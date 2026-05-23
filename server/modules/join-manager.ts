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
 *   5. Pause / Resume — checked BEFORE every sleep AND before every join
 *   6. Interruptible sleep — stop/pause signals checked every 300 ms
 *   7. User-activity guard — pauses if user is actively using WhatsApp
 *   8. Continues running in background even when browser is closed
 */

import { baileysManager }            from "../baileys-manager.js";
import { coordinator }               from "./function-coordinator.js";
import { systemState }               from "./system-state.js";
import { linksRepository }           from "./links-repository.js";
import { classifyWAError }           from "./wa-error-handler.js";
import { WINDOW_DURATION_MS, SLOTS_PER_WINDOW, computeSlotOffsets, shuffle } from "./human-mimicry.js";
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
  windowNumber:    number;
  nextJoinAt?:     string;
  sleepUntil?:     string;
  cooldownUntil?:  string;
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

/**
 * Set to true when the scheduler is paused automatically due to a WhatsApp
 * disconnect. Cleared on auto-resume so that a manual pause is never
 * accidentally overridden by a reconnect event.
 */
let _autoPaused = false;

/** In-memory set of invite codes currently being processed — prevents duplicate join attempts on rapid restart */
const _joiningCache = new Set<string>();

// ── Core sleep helper ─────────────────────────────────────────────────────────

/**
 * Interruptible sleep — checks stop/pause every 300 ms.
 * - PAUSE: timer freezes; loop spins until resumed or stopped.
 * - STOP : returns "stopped" immediately on next tick.
 */
async function interruptibleSleep(
  totalMs: number,
  label: string,
  status: JoinProgress["status"] = "waiting",
  nextAt?: () => string
): Promise<"done" | "stopped"> {
  let remaining = totalMs;
  const TICK = 300;

  console.log(`[JoinManager] ⏱ ${label} — ${Math.round(totalMs / 1000)}s`);

  while (remaining > 0) {
    if (_stopRequested) return "stopped";

    if (_pauseRequested) {
      if (_progress && _progress.status !== "paused") {
        _progress.status    = "paused";
        _progress.nextJoinAt = nextAt?.();
        await systemState.setExtra({ joinProgress: _progress }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, TICK));
      continue; // freeze — don't count down
    }

    if (_progress && _progress.status !== status) {
      _progress.status = status;
      if (nextAt) _progress.nextJoinAt = nextAt();
    }

    const step = Math.min(TICK, remaining);
    await new Promise(r => setTimeout(r, step));
    remaining -= step;
  }

  return "done";
}

/**
 * Explicit pause gate — spins (without counting any timer) until unpaused or stopped.
 * Call this at the TOP of the main loop and BEFORE each actual join call.
 */
async function pauseGate(): Promise<"ok" | "stopped"> {
  while (_pauseRequested && !_stopRequested) {
    if (_progress && _progress.status !== "paused") {
      _progress.status = "paused";
      await systemState.setExtra({ joinProgress: _progress }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (_stopRequested) return "stopped";
  return "ok";
}

// ── Join one link ─────────────────────────────────────────────────────────────

async function joinOne(
  record: { url: string },
  consecutiveFailures: number,
  currentPhone?: string,
  retryCount = 0
): Promise<{ result: "joined" | "ignored" | "failed" | "stop_all" | "stop_join"; waitMs?: number }> {
  const codeMatch    = record.url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  const channelMatch = record.url.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/);

  if (channelMatch) {
    await linksRepository.setStatus(record.url, "Ignored");
    return { result: "ignored" };
  }
  if (!codeMatch) {
    await linksRepository.setStatus(record.url, "Ignored");
    return { result: "ignored" };
  }

  const inviteCode = codeMatch[1];

  // In-memory duplicate guard: don't send two join requests for the same code simultaneously
  if (_joiningCache.has(inviteCode)) {
    console.log(`[JoinManager] ℹ Cache hit — already joining: ${inviteCode}`);
    return { result: "ignored" };
  }
  _joiningCache.add(inviteCode);

  // Pre-flight MongoDB check: skip if already joined by THIS phone to avoid re-join spam
  try {
    const db  = (await import("../mongo-auth-state.js")).getDb;
    const c   = (await db()).collection("Links_Repository");
    const doc = await c.findOne({ url: record.url }, { projection: { status: 1, joinedByPhone: 1 } });
    if (doc?.status === "Joined" && doc?.joinedByPhone === currentPhone) {
      console.log(`[JoinManager] ℹ Pre-flight: already joined by ${currentPhone} — skipping ${record.url}`);
      _joiningCache.delete(inviteCode);
      return { result: "joined" };
    }
  } catch { /* non-fatal — continue with join attempt */ }

  const t0 = Date.now();

  try {
    const groupJid = await baileysManager.joinGroup(inviteCode);
    const latency  = Date.now() - t0;
    telemetry.record(latency);

    await linksRepository.setStatus(record.url, "Joined", currentPhone);
    await linksRepository.recordCheck(record.url, undefined, undefined, undefined);
    if (groupJid) {
      const db = (await import("../mongo-auth-state.js")).getDb();
      const c  = (await db).collection("Links_Repository");
      await c.updateOne({ url: record.url }, { $set: { groupJid, updatedAt: new Date() } });
    }
    console.log(`[JoinManager] ✓ Joined (${latency}ms) [${currentPhone ?? "?"}]: ${record.url}`);
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
        await linksRepository.setStatus(record.url, "Joined", currentPhone);
        console.log(`[JoinManager] ℹ Already member [${currentPhone ?? "?"}]: ${record.url}`);
        return { result: "joined" };

      case "community":
        try {
          const communityJid = await baileysManager.joinCommunity(inviteCode);
          await linksRepository.setStatus(record.url, "Joined", currentPhone);
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

      case "retry": {
        // Transient network error — do NOT mark as Ignored; retry with backoff.
        // After max retries the link stays Pending for the next session.
        const MAX_NET_RETRIES = 3;
        if (retryCount < MAX_NET_RETRIES) {
          const delayMs = Math.min(15_000 * (retryCount + 1), 60_000); // 15s → 30s → 45s
          console.warn(
            `[JoinManager] ⚠ Network hiccup (attempt ${retryCount + 1}/${MAX_NET_RETRIES}) ` +
            `— waiting ${delayMs / 1000}s before retry: ${record.url}`
          );
          _joiningCache.delete(inviteCode); // release cache lock during wait
          await new Promise((r) => setTimeout(r, delayMs));
          if (_stopRequested) return { result: "failed" };
          return joinOne(record, consecutiveFailures, currentPhone, retryCount + 1);
        }
        // All retries exhausted — leave Pending so future session can try again
        console.warn(`[JoinManager] ⚠ Network error — ${MAX_NET_RETRIES} retries exhausted, leaving Pending: ${record.url}`);
        return { result: "failed" };
      }

      default:
        await linksRepository.setStatus(record.url, "Ignored");
        console.warn(`[JoinManager] ✗ ${classified.reason} | ${record.url}`);
        return { result: "failed" };
    }
  } finally {
    _joiningCache.delete(inviteCode);
  }
}

// ── Telemetry sync ────────────────────────────────────────────────────────────

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
    console.log("[JoinManager] 🛑 Stop requested");
  },

  requestPause(): void {
    if (!_progress || _progress.status === "done" || _progress.status === "stopped") return;
    _pauseRequested = true;
    console.log("[JoinManager] ⏸ Pause requested");
  },

  requestResume(): void {
    if (!_progress) return;
    _pauseRequested = false;
    if (_progress.status === "paused") _progress.status = "waiting";
    console.log("[JoinManager] ▶ Resume requested");
  },

  isPaused(): boolean { return _pauseRequested; },

  /**
   * Called automatically when the active WhatsApp session drops.
   * Pauses the scheduler only if it is actively running and not already
   * manually paused — so a manual pause is never silently overridden.
   */
  autoPause(): void {
    if (!_progress) return;
    const s = _progress.status;
    if (s === "done" || s === "stopped") return;
    if (_pauseRequested) return; // already paused (manually) — don't touch it
    _autoPaused     = true;
    _pauseRequested = true;
    if (_progress) _progress.stopReason = "انقطع الاتصال بـ WhatsApp — سيُستأنف تلقائياً عند إعادة الاتصال";
    console.log("[JoinManager] ⏸ Auto-paused (WhatsApp disconnected)");
  },

  /**
   * Called automatically when the active WhatsApp session reconnects.
   * Only resumes if the scheduler was paused by autoPause() — a manual
   * pause from the user is left untouched.
   */
  autoResume(): void {
    if (!_autoPaused) return; // we didn't pause it — don't resume it
    _autoPaused     = false;
    _pauseRequested = false;
    if (_progress && _progress.status === "paused") {
      _progress.status    = "waiting";
      _progress.stopReason = undefined;
    }
    console.log("[JoinManager] ▶ Auto-resumed (WhatsApp reconnected)");
  },

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

      const currentPhone = baileysManager.getConnectedPhone() ?? undefined;
      console.log(`[JoinManager] 🚀 Starting — phone: ${currentPhone ?? "unknown"}, maxLinks: ${maxLinks ?? "all"}`);

      const pendingLinks = await linksRepository.findPendingForJoin(currentPhone);
      if (!pendingLinks.length) {
        throw new Error("لا توجد روابط معلقة في المستودع للانضمام إليها (جميعها تم الانضمام إليها بهذا الحساب).");
      }

      const allLinks = shuffle(pendingLinks);
      const queue    = (maxLinks && maxLinks > 0) ? allLinks.slice(0, maxLinks) : allLinks;

      console.log(`[JoinManager] Queue: ${queue.length} links (${pendingLinks.length} available)`);

      _progress = {
        status:       "waiting",
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

      // ── Main window loop ─────────────────────────────────────────────────────
      while (queueIdx < queue.length) {

        // ── PAUSE GATE (top of every iteration) ─────────────────────────────
        const gateResult = await pauseGate();
        if (gateResult === "stopped") break;

        if (_stopRequested) break;

        // ── 1. Daily sleep check ─────────────────────────────────────────────
        if (isSleepTime()) {
          const wakeMs  = msUntilWakeUp();
          const wakeISO = new Date(Date.now() + wakeMs).toISOString();
          console.log(`[JoinManager] 🌙 Daily sleep — waking at ${new Date(wakeISO).toLocaleTimeString()}`);
          if (_progress) {
            _progress.status     = "sleeping";
            _progress.sleepUntil = wakeISO;
            _progress.nextJoinAt = wakeISO;
          }
          const outcome = await interruptibleSleep(wakeMs, "نوم ليلي", "sleeping");
          if (_progress) _progress.sleepUntil = undefined;
          if (outcome === "stopped") break;
          continue;
        }

        // ── 2. Connection check ──────────────────────────────────────────────
        if (!baileysManager.isConnected()) {
          console.warn("[JoinManager] ⚠ Connection lost — waiting 60s");
          if (_progress) { _progress.status = "paused"; _progress.stopReason = "انقطع الاتصال بـ WhatsApp"; }
          const outcome = await interruptibleSleep(60_000, "انتظار إعادة الاتصال", "paused");
          if (outcome === "stopped") break;
          continue;
        }

        // ── 3. User-activity guard ───────────────────────────────────────────
        if (baileysManager.isUserActive(90_000)) { // 90 s
          console.log("[JoinManager] 👤 User is active — pausing 3 min to avoid conflict");
          if (_progress) _progress.status = "waiting";
          const outcome = await interruptibleSleep(3 * 60_000, "المستخدم نشط — انتظار", "waiting");
          if (outcome === "stopped") break;
          continue;
        }

        // ── 4. Telemetry cooldown check ──────────────────────────────────────
        if (telemetry.isCoolingDown()) {
          const coolMs  = telemetry.cooldownRemaining();
          const coolISO = new Date(Date.now() + coolMs).toISOString();
          console.log(`[JoinManager] 🧊 Telemetry cooldown — ${Math.round(coolMs / 60_000)} min`);
          syncTelemetry();
          if (_progress) { _progress.status = "cooldown"; _progress.nextJoinAt = coolISO; }
          const outcome = await interruptibleSleep(
            coolMs, "تبريد وقائي", "cooldown",
            () => new Date(Date.now() + telemetry.cooldownRemaining()).toISOString()
          );
          if (outcome === "stopped") break;
          continue;
        }

        // ── 5. Open a new 10-minute window (3 slots) ─────────────────────────
        const windowStart = Date.now();
        const windowEnd   = windowStart + WINDOW_DURATION_MS;
        const windowNum   = (_progress?.windowNumber ?? 0) + 1;

        if (_progress) { _progress.windowNumber = windowNum; _progress.status = "waiting"; }

        // Compute 4 randomised join offsets with anti-clustering safeguard
        const [off0, off1, off2, off3] = computeSlotOffsets();
        const slotTimes = [
          windowStart + off0,
          windowStart + off1,
          windowStart + off2,
          windowStart + off3,
        ];
        const slotNames = ["الأولى", "الثانية", "الثالثة", "الرابعة"];

        console.log(
          `[JoinManager] 🪟 Window ${windowNum}: ` +
          `slot0 @+${Math.round(off0 / 1000)}s, ` +
          `slot1 @+${Math.round(off1 / 1000)}s, ` +
          `slot2 @+${Math.round(off2 / 1000)}s, ` +
          `slot3 @+${Math.round(off3 / 1000)}s — ` +
          `queue[${queueIdx}/${queue.length}]`
        );

        coordinator.setWindowActive(true);
        let windowBroken = false;

        // ── Execute up to SLOTS_PER_WINDOW slots per window ──────────────
        for (let slotIdx = 0; slotIdx < SLOTS_PER_WINDOW; slotIdx++) {
          if (queueIdx >= queue.length || _stopRequested) break;

          const joinAt   = slotTimes[slotIdx];
          const slotLink = queue[queueIdx];
          const waitMs   = joinAt - Date.now();

          // Wait until slot time
          if (waitMs > 0) {
            if (_progress) _progress.nextJoinAt = new Date(joinAt).toISOString();
            const outcome = await interruptibleSleep(
              waitMs,
              `نافذة ${windowNum} — انتظار الفتحة ${slotNames[slotIdx]}`,
              "waiting",
              () => new Date(joinAt).toISOString()
            );
            if (outcome === "stopped") { windowBroken = true; break; }
          }

          // Pause / stop checks before actual join
          if ((await pauseGate()) === "stopped") { windowBroken = true; break; }
          if (_stopRequested) { windowBroken = true; break; }
          if (!baileysManager.isConnected()) break; // skip to next window iteration

          if (baileysManager.isUserActive(60_000)) {
            console.log(`[JoinManager] 👤 User active before slot ${slotIdx} — skipping slot`);
            continue;
          }

          // Execute join
          if (_progress) { _progress.status = "running"; _progress.currentLink = slotLink.url; }
          console.log(`[JoinManager] ▶ [W${windowNum}] Slot ${slotIdx}: ${slotLink.url}`);

          const r = await joinOne(slotLink, consecutiveFailures, currentPhone);

          if (r.result === "stop_all") {
            if (_progress) { _progress.status = "stopped"; _progress.stopReason = "⚠️ حساب تحت التهديد — تم إيقاف كل شيء"; }
            windowBroken = true;
            break;
          }
          if (r.result === "stop_join") {
            const wMs = r.waitMs ?? 15 * 60_000;
            console.warn(`[JoinManager] ⛔ stop_join — waiting ${Math.round(wMs / 60_000)} min`);
            syncTelemetry();
            const outcome = await interruptibleSleep(wMs, "توقف واتساب المؤقت", "cooldown");
            if (outcome === "stopped") { windowBroken = true; }
            break; // end this window, re-evaluate at top of outer loop
          }

          if (r.result === "joined")       { consecutiveFailures = 0; if (_progress) _progress.joined++; }
          else if (r.result === "ignored") { if (_progress) _progress.ignored++; }
          else                             { consecutiveFailures++; if (_progress) _progress.failed++; }

          queueIdx++;
          if (_progress) { _progress.processed++; _progress.currentLink = undefined; }
          syncTelemetry();
          await systemState.setExtra({ joinProgress: _progress }).catch(() => {});
        }

        coordinator.setWindowActive(false);

        // ── Record window stats to telemetry history ──────────────────────
        {
          const progressSnap = _progress;
          if (progressSnap) {
            const report = telemetry.getReport();
            telemetry.recordWindow({
              windowNumber:  windowNum,
              slotsExecuted: Math.min(SLOTS_PER_WINDOW, queueIdx),
              joined:        progressSnap.joined,
              failed:        progressSnap.failed,
              ignored:       progressSnap.ignored,
              startedAt:     new Date(windowStart).toISOString(),
              completedAt:   new Date().toISOString(),
              durationMs:    Date.now() - windowStart,
              avgLatencyMs:  report.avgLatencyMs,
              hadCooldown:   report.cooldownActive,
            });
          }
        }

        if (windowBroken) break;

        // ── Wait for remainder of the 10-minute window ────────────────────
        if (queueIdx < queue.length && !_stopRequested) {
          const remainingWindow = windowEnd - Date.now();
          if (remainingWindow > 1000) {
            if (_progress) _progress.nextJoinAt = new Date(windowEnd).toISOString();
            const outcome = await interruptibleSleep(
              remainingWindow,
              `نافذة ${windowNum} — انتظار نهاية النافذة`,
              "waiting",
              () => new Date(windowEnd).toISOString()
            );
            if (outcome === "stopped") break;
          }
        }
      }

      // ── Session complete ─────────────────────────────────────────────────────
      if (_progress) {
        if (_progress.status === "running" || _progress.status === "waiting") {
          _progress.status      = "done";
          _progress.completedAt = new Date().toISOString();
        }
        _progress.nextJoinAt  = undefined;
        _progress.currentLink = undefined;
      }

      console.log(
        `[JoinManager] ✅ Session complete — joined: ${_progress?.joined ?? 0}, ` +
        `failed: ${_progress?.failed ?? 0}, ignored: ${_progress?.ignored ?? 0}`
      );

    } finally {
      coordinator.setWindowActive(false);
      coordinator.release();
      await systemState.setActiveFunction(null).catch(() => {});
      if (_progress && !_progress.completedAt && _progress.status !== "stopped") {
        _progress.completedAt = new Date().toISOString();
      }
    }
  },
};

// ── Auto-pause / auto-resume on WhatsApp connection events ───────────────────
//
// baileysManager emits "status" (WAStatus string) whenever the ACTIVE session
// changes state. We listen here (join-manager already depends on
// baileysManager, so no circular import is introduced).
//
//   disconnect / connecting  →  autoPause()   pauses scheduler instantly
//   connected                →  autoResume()  resumes only if WE paused it
//
baileysManager.on("status", (status: string) => {
  if (status === "disconnected" || status === "connecting") {
    joinManager.autoPause();
  } else if (status === "connected") {
    joinManager.autoResume();
  }
});
