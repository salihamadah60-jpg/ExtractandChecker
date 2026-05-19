/**
 * join-manager.ts — Smart join scheduler with human pacing
 *
 * Rate model: 2 links per 10-minute window, spread across two random slots:
 *   Slot 0 → random offset  0:30 – 4:30  (first half)
 *   Slot 1 → random offset  5:00 – 9:30  (second half)
 *
 * Safety layers:
 *   1. Daily sleep mode  01:30 – 07:30  (6-hour nightly rest)
 *   2. Telemetry sensing — latency spikes trigger proactive cooldowns
 *   3. Coordinator lock held for ENTIRE session (no parallel WA calls)
 *   4. Strict window lock — blocks publish / read / leave during any window
 *   5. Pause / Resume without losing progress
 *   6. Interruptible sleep — stop/pause signals checked every second
 *   7. Continues running in background even when browser is closed
 */

import { baileysManager }            from "../baileys-manager.js";
import { coordinator }               from "./function-coordinator.js";
import { systemState }               from "./system-state.js";
import { linksRepository }           from "./links-repository.js";
import { classifyWAError }           from "./wa-error-handler.js";
import { WINDOW_DURATION_MS, joinSlotOffset, shuffle } from "./human-mimicry.js";
import { isSleepTime, msUntilWakeUp } from "./sleep-scheduler.js";
import { telemetry }                 from "./telemetry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JoinProgress {
  status: "running" | "waiting" | "sleeping" | "cooldown" | "paused" | "done" | "stopped" | "error";
  total:       number;
  processed:   number;
  joined:      number;
  ignored:     number;
  failed:      number;
  skipped_ads: number;
  currentLink?: string;
  stopReason?:  string;
  startedAt:    string;
  completedAt?: string;

  // Smart scheduling
  windowNumber:    number;   // current window index (1-based)
  nextJoinAt?:     string;   // ISO – when next join fires
  sleepUntil?:     string;   // ISO – when daily sleep ends
  cooldownUntil?:  string;   // ISO – when telemetry cooldown ends
  telemetry?: {
    avgLatencyMs:  number;
    lastLatencyMs: number;
    cooldownActive: boolean;
    warning?:      string;
  };
}

// ── Module state ──────────────────────────────────────────────────────────────

let _progress:       JoinProgress | null = null;
let _stopRequested  = false;
let _pauseRequested = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Interruptible sleep.
 * - While PAUSED: time does NOT count down (progress freezes).
 * - While STOPPED: returns "stopped" immediately.
 * - Checks signals every 1 second.
 */
async function interruptibleSleep(
  totalMs: number,
  label: string,
  status: JoinProgress["status"] = "waiting",
  nextAt?: () => string
): Promise<"done" | "stopped"> {
  let remaining = totalMs;
  const TICK = 1_000;

  console.log(`[JoinManager] ${label} — ${Math.round(totalMs / 1000)}s`);

  while (remaining > 0) {
    if (_stopRequested) return "stopped";

    if (_pauseRequested) {
      if (_progress && _progress.status !== "paused") {
        _progress.status = "paused";
        _progress.nextJoinAt = nextAt?.();
        await systemState.setExtra({ joinProgress: _progress }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, TICK));
      continue; // freeze — don't count down
    }

    if (_progress && _progress.status !== status) {
      _progress.status = status;
    }
    if (_progress && nextAt) {
      _progress.nextJoinAt = nextAt();
    }

    const step = Math.min(TICK, remaining);
    await new Promise(r => setTimeout(r, step));
    remaining -= step;
  }

  return "done";
}

/** Perform one actual group join and record telemetry */
async function joinOne(
  record: { url: string },
  consecutiveFailures: number
): Promise<{ result: "joined" | "ignored" | "failed" | "stop_all" | "stop_join"; waitMs?: number }> {
  const codeMatch    = record.url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  const channelMatch = record.url.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/);

  if (channelMatch) {
    await linksRepository.setStatus(record.url, "Ignored");
    console.log(`[JoinManager] Skipped channel: ${record.url}`);
    return { result: "ignored" };
  }
  if (!codeMatch) {
    await linksRepository.setStatus(record.url, "Ignored");
    console.log(`[JoinManager] Skipped — unrecognized URL: ${record.url}`);
    return { result: "ignored" };
  }

  const inviteCode = codeMatch[1];
  const t0 = Date.now();

  try {
    const groupJid = await baileysManager.joinGroup(inviteCode);
    const latency  = Date.now() - t0;
    telemetry.record(latency);

    await linksRepository.setStatus(record.url, "Joined");
    await linksRepository.recordCheck(record.url, undefined, undefined, undefined);
    if (groupJid) {
      const db = (await import("../mongo-auth-state.js")).getDb();
      const c  = (await db).collection("Links_Repository");
      await c.updateOne({ url: record.url }, { $set: { groupJid, updatedAt: new Date() } });
    }
    console.log(`[JoinManager] ✓ Joined (${latency}ms): ${record.url}`);
    return { result: "joined" };

  } catch (err: unknown) {
    const latency = Date.now() - t0;
    const classified = classifyWAError(err, consecutiveFailures);

    switch (classified.action) {
      case "stop_all":
        telemetry.triggerEmergency(classified.reason, 30 * 60_000);
        return { result: "stop_all" };

      case "stop_join":
        telemetry.triggerEmergency(classified.reason, classified.waitMs ?? 15 * 60_000);
        return { result: "stop_join", waitMs: classified.waitMs };

      case "already_member":
        await linksRepository.setStatus(record.url, "Joined");
        return { result: "joined" };

      case "community":
        try {
          const communityJid = await baileysManager.joinCommunity(inviteCode);
          await linksRepository.setStatus(record.url, "Joined");
          if (communityJid) {
            const db = (await import("../mongo-auth-state.js")).getDb();
            const c  = (await db).collection("Links_Repository");
            await c.updateOne({ url: record.url }, { $set: { groupJid: communityJid, type: "Group", updatedAt: new Date() } });
          }
          return { result: "joined" };
        } catch {
          await linksRepository.setStatus(record.url, "Ignored");
          return { result: "ignored" };
        }

      case "wait_and_retry":
        telemetry.record(latency);
        await linksRepository.setStatus(record.url, "Ignored");
        console.warn(`[JoinManager] Rate-limit skip: ${record.url}`);
        return { result: "failed" };

      default:
        await linksRepository.setStatus(record.url, "Ignored");
        console.warn(`[JoinManager] ✗ ${classified.reason} | ${record.url}`);
        return { result: "failed" };
    }
  }
}

/** Sync telemetry snapshot into progress object */
function syncTelemetry() {
  if (!_progress) return;
  const r = telemetry.getReport();
  _progress.telemetry = {
    avgLatencyMs:   r.avgLatencyMs,
    lastLatencyMs:  r.lastLatencyMs,
    cooldownActive: r.cooldownActive,
    warning:        r.warning,
  };
  if (r.cooldownActive && r.cooldownUntil) {
    _progress.cooldownUntil = r.cooldownUntil.toISOString();
  } else {
    _progress.cooldownUntil = undefined;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const joinManager = {
  getProgress(): JoinProgress | null { return _progress; },

  requestStop(): void {
    _stopRequested  = true;
    _pauseRequested = false;
    if (_progress && _progress.status !== "done") _progress.status = "stopped";
    console.log("[JoinManager] Stop requested");
  },

  requestPause(): void {
    if (!_progress || _progress.status === "done" || _progress.status === "stopped") return;
    _pauseRequested = true;
    console.log("[JoinManager] Pause requested");
  },

  requestResume(): void {
    if (!_progress) return;
    _pauseRequested = false;
    if (_progress.status === "paused") _progress.status = "running";
    console.log("[JoinManager] Resume requested");
  },

  isPaused(): boolean { return _pauseRequested; },

  async start(maxLinks?: number): Promise<void> {
    if (!baileysManager.isConnected()) {
      throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
    }

    const acquired = await coordinator.acquire("joining");
    if (!acquired) {
      const active = coordinator.getActive();
      throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً. يُرجى الانتظار.`);
    }

    _stopRequested  = false;
    _pauseRequested = false;
    telemetry.reset();

    try {
      await systemState.setActiveFunction("joining");

      const pendingLinks = await linksRepository.findPendingForJoin();
      if (!pendingLinks.length) {
        throw new Error("لا توجد روابط معلقة في المستودع للانضمام إليها.");
      }

      // If caller specified a limit (e.g. for testing), trim the queue
      const allLinks = shuffle(pendingLinks);
      const queue = (maxLinks && maxLinks > 0) ? allLinks.slice(0, maxLinks) : allLinks;

      if (maxLinks && maxLinks > 0) {
        console.log(`[JoinManager] Test mode: limiting queue to ${maxLinks} links (${pendingLinks.length} available)`);
      }

      _progress = {
        status:       "running",
        total:        queue.length,
        processed:    0,
        joined:       0,
        ignored:      0,
        failed:       0,
        skipped_ads:  0,
        startedAt:    new Date().toISOString(),
        windowNumber: 0,
      };

      await systemState.setExtra({ joinProgress: _progress });

      let queueIdx            = 0;
      let consecutiveFailures = 0;

      // ── Main window loop ─────────────────────────────────────────────────
      while (queueIdx < queue.length) {
        if (_stopRequested) break;

        // ── 1. Daily sleep check ─────────────────────────────────────────
        if (isSleepTime()) {
          const wakeMs  = msUntilWakeUp();
          const wakeISO = new Date(Date.now() + wakeMs).toISOString();
          console.log(`[JoinManager] Daily sleep — waking at ${new Date(wakeISO).toLocaleTimeString()}`);
          if (_progress) {
            _progress.status    = "sleeping";
            _progress.sleepUntil = wakeISO;
            _progress.nextJoinAt = wakeISO;
          }
          const outcome = await interruptibleSleep(wakeMs, "نوم ليلي", "sleeping");
          if (_progress) { _progress.sleepUntil = undefined; }
          if (outcome === "stopped") break;
          if (isSleepTime()) continue; // edge case: still sleeping (clocks changed, etc.)
        }

        // ── 2. Connection check ──────────────────────────────────────────
        if (!baileysManager.isConnected()) {
          if (_progress) {
            _progress.status    = "paused";
            _progress.stopReason = "انقطع الاتصال بـ WhatsApp";
          }
          console.warn("[JoinManager] Connection lost — waiting 60s");
          const outcome = await interruptibleSleep(60_000, "انتظار إعادة الاتصال", "paused");
          if (outcome === "stopped") break;
          continue;
        }

        // ── 3. Telemetry cooldown check ─────────────────────────────────
        if (telemetry.isCoolingDown()) {
          const coolMs = telemetry.cooldownRemaining();
          const coolISO = new Date(Date.now() + coolMs).toISOString();
          console.log(`[JoinManager] Telemetry cooldown — ${Math.round(coolMs / 60_000)} min`);
          syncTelemetry();
          if (_progress) {
            _progress.status       = "cooldown";
            _progress.nextJoinAt   = coolISO;
          }
          const outcome = await interruptibleSleep(
            coolMs, "تبريد وقائي", "cooldown",
            () => new Date(Date.now() + telemetry.cooldownRemaining()).toISOString()
          );
          if (outcome === "stopped") break;
          continue;
        }

        // ── 4. Open a new 10-minute window ───────────────────────────────
        const windowStart = Date.now();
        const windowEnd   = windowStart + WINDOW_DURATION_MS;
        const windowNum   = (_progress?.windowNumber ?? 0) + 1;

        if (_progress) {
          _progress.windowNumber = windowNum;
          _progress.status       = "waiting";
        }

        // Pick 2 links for this window
        const slot0Link = queue[queueIdx];
        const slot1Link = queue[queueIdx + 1] ?? null; // might not exist

        // Random offsets within each half
        const offset0 = joinSlotOffset(0); // 30s – 4m30s
        const offset1 = joinSlotOffset(1); // 5m00s – 9m30s

        const joinAt0 = windowStart + offset0;
        const joinAt1 = windowStart + offset1;

        console.log(
          `[JoinManager] Window ${windowNum}: ` +
          `slot0 @+${Math.round(offset0 / 1000)}s, ` +
          `slot1 @+${Math.round(offset1 / 1000)}s`
        );

        // ── Slot 0: wait then join ─────────────────────────────────────
        coordinator.setWindowActive(true);

        const wait0 = joinAt0 - Date.now();
        if (wait0 > 0) {
          if (_progress) _progress.nextJoinAt = new Date(joinAt0).toISOString();
          const outcome = await interruptibleSleep(
            wait0, `نافذة ${windowNum} — انتظار الفتحة الأولى`, "waiting",
            () => new Date(joinAt0).toISOString()
          );
          if (outcome === "stopped") { coordinator.setWindowActive(false); break; }
        }

        if (_stopRequested) { coordinator.setWindowActive(false); break; }
        if (!baileysManager.isConnected()) { coordinator.setWindowActive(false); continue; }

        // ── Execute slot 0 join ───────────────────────────────────────
        if (_progress) { _progress.status = "running"; _progress.currentLink = slot0Link.url; }
        console.log(`[JoinManager] [Window ${windowNum}] Slot 0: ${slot0Link.url}`);

        const r0 = await joinOne(slot0Link, consecutiveFailures);

        if (r0.result === "stop_all") {
          if (_progress) { _progress.status = "stopped"; _progress.stopReason = "⚠️ حساب تحت التهديد — تم إيقاف كل شيء"; }
          coordinator.setWindowActive(false);
          break;
        }
        if (r0.result === "stop_join") {
          const waitMs = r0.waitMs ?? 15 * 60_000;
          console.warn(`[JoinManager] stop_join — waiting ${Math.round(waitMs / 60_000)} min`);
          syncTelemetry();
          const outcome = await interruptibleSleep(waitMs, "توقف واتساب المؤقت", "cooldown");
          if (outcome === "stopped") { coordinator.setWindowActive(false); break; }
          coordinator.setWindowActive(false);
          continue; // restart window without consuming the link
        }

        if (r0.result === "joined")  { consecutiveFailures = 0; if (_progress) _progress.joined++; }
        else if (r0.result === "ignored") { if (_progress) _progress.ignored++; }
        else { consecutiveFailures++; if (_progress) _progress.failed++; }

        queueIdx++;
        if (_progress) { _progress.processed++; _progress.currentLink = undefined; }
        syncTelemetry();
        await systemState.setExtra({ joinProgress: _progress }).catch(() => {});

        // ── Slot 1: wait then join (if a second link exists) ──────────
        if (slot1Link && queueIdx < queue.length && !_stopRequested) {
          const wait1 = joinAt1 - Date.now();
          if (wait1 > 0) {
            if (_progress) _progress.nextJoinAt = new Date(joinAt1).toISOString();
            const outcome = await interruptibleSleep(
              wait1, `نافذة ${windowNum} — انتظار الفتحة الثانية`, "waiting",
              () => new Date(joinAt1).toISOString()
            );
            if (outcome === "stopped") { coordinator.setWindowActive(false); break; }
          }

          if (!_stopRequested && baileysManager.isConnected()) {
            if (_progress) { _progress.status = "running"; _progress.currentLink = slot1Link.url; }
            console.log(`[JoinManager] [Window ${windowNum}] Slot 1: ${slot1Link.url}`);

            const r1 = await joinOne(slot1Link, consecutiveFailures);

            if (r1.result === "stop_all") {
              if (_progress) { _progress.status = "stopped"; _progress.stopReason = "⚠️ حساب تحت التهديد — تم إيقاف كل شيء"; }
              coordinator.setWindowActive(false);
              break;
            }
            if (r1.result === "stop_join") {
              const waitMs = r1.waitMs ?? 15 * 60_000;
              syncTelemetry();
              const outcome = await interruptibleSleep(waitMs, "توقف واتساب المؤقت", "cooldown");
              if (outcome === "stopped") { coordinator.setWindowActive(false); break; }
              coordinator.setWindowActive(false);
              continue;
            }

            if (r1.result === "joined")  { consecutiveFailures = 0; if (_progress) _progress.joined++; }
            else if (r1.result === "ignored") { if (_progress) _progress.ignored++; }
            else { consecutiveFailures++; if (_progress) _progress.failed++; }

            queueIdx++;
            if (_progress) { _progress.processed++; _progress.currentLink = undefined; }
            syncTelemetry();
            await systemState.setExtra({ joinProgress: _progress }).catch(() => {});
          }
        }

        coordinator.setWindowActive(false);

        // ── Wait until end of 10-minute window ────────────────────────
        const remainingWindow = windowEnd - Date.now();
        if (remainingWindow > 1000 && queueIdx < queue.length && !_stopRequested) {
          const nextWindowAt = new Date(windowEnd).toISOString();
          if (_progress) _progress.nextJoinAt = nextWindowAt;
          const outcome = await interruptibleSleep(
            remainingWindow, `نافذة ${windowNum} — انتظار نهاية النافذة`, "waiting",
            () => new Date(windowEnd).toISOString()
          );
          if (outcome === "stopped") break;
        }
      }

      // ── Session complete ─────────────────────────────────────────────
      if (_progress) {
        if (_progress.status === "running" || _progress.status === "waiting") {
          _progress.status      = "done";
          _progress.completedAt = new Date().toISOString();
        }
        _progress.nextJoinAt  = undefined;
        _progress.currentLink = undefined;
      }

      console.log(
        `[JoinManager] Session finished — joined: ${_progress?.joined}, ` +
        `ignored: ${_progress?.ignored}, failed: ${_progress?.failed}`
      );
    } finally {
      coordinator.setWindowActive(false);
      coordinator.release();
      await systemState.setActiveFunction(null);
      if (_progress) _progress.currentLink = undefined;
    }
  },
};
