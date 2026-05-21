/**
 * publisher.ts — Ad publishing module (anti-ban hardened)
 *
 * Safety layers added:
 *   1. Telemetry tracking on every send — latency spikes trigger cooldowns
 *   2. Proactive cooldown check BEFORE each send (not just after errors)
 *   3. Pause / Resume support (in addition to Stop)
 *   4. Batch rests: after every 10–15 sends, take a 3–7 minute break
 *   5. Coordinator blocks publish entirely during join windows
 *   6. Consecutive failure limit: 5 → stop publish (protects account)
 *   7. Stop-all from WA error: halts everything, not just publishing
 */

import { getDb }            from "../mongo-auth-state.js";
import { baileysManager }   from "../baileys-manager.js";
import { coordinator }      from "./function-coordinator.js";
import { systemState }      from "./system-state.js";
import { linksRepository }  from "./links-repository.js";
import { classifyWAError }  from "./wa-error-handler.js";
import { telemetry }        from "./telemetry.js";
import { DELAYS, shuffle, randomInt } from "./human-mimicry.js";
import { publishHistory }   from "./publish-history.js";

export interface AdMessage {
  _id?: string;
  text: string;
  createdAt: Date;
  sentCount: number;
  lastSentAt?: Date;
}

export interface PublishProgress {
  status: "running" | "done" | "paused" | "stopped" | "cooldown" | "error";
  total: number;
  processed: number;
  sent: number;
  failed: number;
  currentGroup?: string;
  startedAt: string;
  completedAt?: string;
  cooldownUntil?: string;
  telemetry?: { avgLatencyMs: number; lastLatencyMs: number; cooldownActive: boolean; warning?: string };
}

const COL = "Keywords_Config";
const MAX_CONSECUTIVE_FAILURES = 5;
const BATCH_SIZE_MIN = 10;   // take a long rest after this many sends
const BATCH_SIZE_MAX = 15;

async function col() {
  const db = await getDb();
  return db.collection<AdMessage>(COL);
}

let _progress:       PublishProgress | null = null;
let _stopRequested   = false;
let _pauseRequested  = false;

/** Interruptible sleep — freezes when paused, returns "stopped" if stop requested */
async function interruptibleSleep(ms: number): Promise<"done" | "stopped"> {
  let remaining = ms;
  const TICK = 1_000;
  while (remaining > 0) {
    if (_stopRequested) return "stopped";
    if (!_pauseRequested) remaining -= Math.min(TICK, remaining);
    else if (_progress) _progress.status = "paused";
    await new Promise(r => setTimeout(r, Math.min(TICK, remaining > 0 ? remaining : TICK)));
  }
  return "done";
}

function syncTelemetry() {
  if (!_progress) return;
  const r = telemetry.getReport();
  _progress.telemetry = {
    avgLatencyMs:   r.avgLatencyMs,
    lastLatencyMs:  r.lastLatencyMs,
    cooldownActive: r.cooldownActive,
    warning:        r.warning,
  };
  _progress.cooldownUntil = r.cooldownActive && r.cooldownUntil
    ? r.cooldownUntil.toISOString()
    : undefined;
}

export const publisher = {
  getProgress(): PublishProgress | null { return _progress; },

  requestStop(): void {
    _stopRequested  = true;
    _pauseRequested = false;
    if (_progress && _progress.status !== "done") _progress.status = "stopped";
  },

  requestPause(): void {
    if (!_progress || _progress.status === "done" || _progress.status === "stopped") return;
    _pauseRequested = true;
  },

  requestResume(): void {
    _pauseRequested = false;
    if (_progress && _progress.status === "paused") _progress.status = "running";
  },

  async addAd(text: string): Promise<string> {
    const c = await col();
    const result = await c.insertOne({ text, createdAt: new Date(), sentCount: 0 } as AdMessage);
    return result.insertedId.toString();
  },

  async removeAd(id: string): Promise<void> {
    const { ObjectId } = await import("mongodb");
    const c = await col();
    await c.deleteOne({ _id: new ObjectId(id) as any });
  },

  async listAds(): Promise<AdMessage[]> {
    const c = await col();
    return c.find({}).sort({ createdAt: 1 }).toArray();
  },

  async start(onProgress?: (p: PublishProgress) => void): Promise<void> {
    if (!baileysManager.isConnected()) {
      throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
    }
    if (coordinator.isJoinWindowActive()) {
      throw new Error("⛔ نافذة انضمام نشطة — لا يمكن النشر حالياً. انتظر انتهاء النافذة.");
    }

    const acquired = await coordinator.acquire("publishing");
    if (!acquired) {
      const active = coordinator.getActive();
      throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
    }

    _stopRequested  = false;
    _pauseRequested = false;

    try {
      await systemState.setActiveFunction("publishing");

      const ads = await publisher.listAds();
      if (!ads.length) throw new Error("لا توجد إعلانات محفوظة. أضف إعلاناً أولاً.");

      const currentPhone = baileysManager.getConnectedPhone() ?? undefined;
      console.log(`[Publisher] Starting — phone: ${currentPhone ?? "unknown"}`);

      const joinedGroups = await linksRepository.findJoined(currentPhone);
      if (!joinedGroups.length) throw new Error("لا توجد مجموعات منضم إليها بهذا الحساب للنشر.");

      const state = await systemState.get();
      let adIdx = ((state.last_published_ad_index ?? -1) + 1) % ads.length;

      const shuffledGroups = shuffle(joinedGroups);
      const batchLimit = randomInt(BATCH_SIZE_MIN, BATCH_SIZE_MAX);

      _progress = {
        status:    "running",
        total:     shuffledGroups.length,
        processed: 0,
        sent:      0,
        failed:    0,
        startedAt: new Date().toISOString(),
      };

      onProgress?.(_progress);

      let consecutiveFailures = 0;
      let sendsSinceRest      = 0;

      for (const group of shuffledGroups) {
        if (_stopRequested || _progress.status === "stopped") {
          _progress.status = "stopped"; break;
        }

        // ── Pause check ──────────────────────────────────────────────────
        while (_pauseRequested && !_stopRequested) {
          _progress.status = "paused";
          await new Promise(r => setTimeout(r, 1000));
        }
        if (_stopRequested) { _progress.status = "stopped"; break; }
        if (_progress.status === "paused") _progress.status = "running";

        if (!baileysManager.isConnected()) {
          _progress.status = "stopped"; break;
        }

        // ── User-activity guard ───────────────────────────────────────────
        if (baileysManager.isUserActive(90_000)) {
          console.log("[Publisher] 👤 User active — pausing 2 min");
          if (_progress) _progress.status = "cooldown";
          const outcome = await interruptibleSleep(2 * 60_000);
          if (outcome === "stopped") { _progress.status = "stopped"; break; }
          if (_progress) _progress.status = "running";
        }

        // ── Proactive telemetry cooldown check ───────────────────────────
        if (telemetry.isCoolingDown()) {
          const coolMs = telemetry.cooldownRemaining();
          console.log(`[Publisher] Telemetry cooldown — ${Math.round(coolMs / 60_000)} min`);
          syncTelemetry();
          if (_progress) _progress.status = "cooldown";
          const outcome = await interruptibleSleep(coolMs);
          if (outcome === "stopped") { _progress.status = "stopped"; break; }
          if (_progress) _progress.status = "running";
        }

        // ── Batch rest ───────────────────────────────────────────────────
        if (sendsSinceRest >= batchLimit) {
          const restMs = randomInt(3 * 60_000, 7 * 60_000); // 3–7 min
          console.log(`[Publisher] Batch rest after ${sendsSinceRest} sends — ${Math.round(restMs / 60_000)} min`);
          const outcome = await interruptibleSleep(restMs);
          if (outcome === "stopped") { _progress.status = "stopped"; break; }
          sendsSinceRest = 0;
        }

        _progress.currentGroup = group.url;
        onProgress?.(_progress);

        const db  = await getDb();
        const rec = await db.collection("Links_Repository").findOne({ url: group.url }) as any;
        const jid = rec?.groupJid;

        if (!jid) {
          console.warn(`[Publisher] No groupJid for ${group.url} — skipping`);
          _progress.processed++;
          continue;
        }

        // Dynamic announce check: skip groups where only admins can post
        try {
          const meta = await baileysManager.getGroupMetadata(jid);
          if (meta?.announce === true) {
            console.log(`[Publisher] ⏭ Admins-only (announce:true) — skipping: ${group.url}`);
            _progress.processed++;
            continue;
          }
        } catch { /* ignore metadata errors — attempt send anyway */ }

        const ad  = ads[adIdx % ads.length];
        adIdx     = (adIdx + 1) % ads.length;

        const t0 = Date.now();
        try {
          await DELAYS.typingBeforeSend();
          await baileysManager.sendTextMessage(jid, ad.text);

          const latency = Date.now() - t0;
          telemetry.record(latency);
          syncTelemetry();

          const c = await col();
          await c.updateOne(
            { _id: (ad as any)._id },
            { $inc: { sentCount: 1 }, $set: { lastSentAt: new Date() } }
          );
          await systemState.update({ last_published_ad_index: adIdx });

          _progress.sent++;
          consecutiveFailures = 0;
          sendsSinceRest++;
          console.log(`[Publisher] ✓ Sent (${latency}ms) to ${group.url}: "${ad.text.slice(0, 40)}..."`);

        } catch (err: unknown) {
          const classified = classifyWAError(err, consecutiveFailures);
          consecutiveFailures++;
          syncTelemetry();

          if (classified.action === "stop_all") {
            _progress.status = "stopped";
            telemetry.triggerEmergency(classified.reason, 30 * 60_000);
            console.error(`[Publisher] 🚨 CRITICAL stop_all: ${classified.reason}`);
            break;
          }

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            _progress.status = "stopped";
            console.error(`[Publisher] Too many consecutive failures (${consecutiveFailures}) — stopping`);
            break;
          }

          _progress.failed++;
          console.warn(`[Publisher] ✗ ${classified.reason} | ${group.url}`);

          if (classified.action === "wait_and_retry") {
            const waitMs = classified.waitMs ?? 60_000;
            console.log(`[Publisher] Rate-limit wait ${Math.round(waitMs / 1000)}s`);
            const outcome = await interruptibleSleep(waitMs);
            if (outcome === "stopped") { _progress.status = "stopped"; break; }
          }
        }

        _progress.processed++;
        onProgress?.(_progress);

        // ── Normal between-group delay ───────────────────────────────────
        if (_progress.processed < _progress.total && _progress.status === "running") {
          const outcome = await interruptibleSleep(
            randomInt(10_000, 30_000) // 10–30 s between groups
          );
          if (outcome === "stopped") { _progress.status = "stopped"; break; }
        }
      }

      if (_progress.status === "running") {
        _progress.status      = "done";
        _progress.completedAt = new Date().toISOString();
      }

      console.log(`[Publisher] Done — sent: ${_progress.sent}, failed: ${_progress.failed}`);

      // ── Persist session to history ──────────────────────────────────────
      if (_progress.completedAt) {
        void publishHistory.save({
          startedAt:   _progress.startedAt,
          completedAt: _progress.completedAt,
          status:      _progress.status as "done" | "stopped" | "error",
          total:       _progress.total,
          processed:   _progress.processed,
          sent:        _progress.sent,
          failed:      _progress.failed,
          phone:       baileysManager.getConnectedPhone() ?? undefined,
        });
      }
    } finally {
      if (_progress) _progress.currentGroup = undefined;
      coordinator.release();
      await systemState.setActiveFunction(null);
    }
  },
};
