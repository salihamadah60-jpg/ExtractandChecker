/**
 * publisher.ts — Ad publishing module (per-workspace, anti-ban hardened)
 */

import { getDb }            from "../mongo-auth-state.js";
import { baileysManager }   from "../baileys-manager.js";
import { getCoordinatorFor } from "./function-coordinator.js";
import { systemState }      from "./system-state.js";
import { linksRepository }  from "./links-repository.js";
import { classifyWAError }  from "./wa-error-handler.js";
import { getTelemetryFor }  from "./telemetry.js";
import { DELAYS, shuffle, randomInt } from "./human-mimicry.js";
import { publishHistory }   from "./publish-history.js";
import { excludedGroups }   from "./excluded-groups.js";

export interface AdMessage {
  _id?: string;
  workspaceId: string;
  text: string;
  mediaData?: string;
  mediaType?: "image" | "video" | "document";
  mediaCaption?: string;
  mediaFilename?: string;
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
const BATCH_SIZE_MIN = 10;
const BATCH_SIZE_MAX = 15;

async function col(workspaceId: string) {
  const db = await getDb();
  return db.collection<AdMessage>(COL);
}

// ── Per-workspace state ────────────────────────────────────────────────────────

interface WState {
  progress:       PublishProgress | null;
  stopRequested:  boolean;
  pauseRequested: boolean;
}

const _stateByWid = new Map<string, WState>();

function _st(wid: string): WState {
  if (!_stateByWid.has(wid)) {
    _stateByWid.set(wid, { progress: null, stopRequested: false, pauseRequested: false });
  }
  return _stateByWid.get(wid)!;
}

async function interruptibleSleep(wid: string, ms: number): Promise<"done" | "stopped"> {
  const s = _st(wid);
  let remaining = ms;
  const TICK = 1_000;
  while (remaining > 0) {
    if (s.stopRequested) return "stopped";
    if (!s.pauseRequested) remaining -= Math.min(TICK, remaining);
    else if (s.progress) s.progress.status = "paused";
    await new Promise(r => setTimeout(r, Math.min(TICK, remaining > 0 ? remaining : TICK)));
  }
  return "done";
}

function syncTelemetry(wid: string): void {
  const s   = _st(wid);
  const tel = getTelemetryFor(wid);
  if (!s.progress) return;
  const r = tel.getReport();
  s.progress.telemetry = {
    avgLatencyMs:   r.avgLatencyMs,
    lastLatencyMs:  r.lastLatencyMs,
    cooldownActive: r.cooldownActive,
    warning:        r.warning,
  };
  s.progress.cooldownUntil = r.cooldownActive && r.cooldownUntil
    ? r.cooldownUntil.toISOString()
    : undefined;
}

// ── Manager factory ────────────────────────────────────────────────────────────

function _createManager(wid: string) {
  return {
    getProgress(): PublishProgress | null { return _st(wid).progress; },

    requestStop(): void {
      const s = _st(wid);
      s.stopRequested  = true;
      s.pauseRequested = false;
      if (s.progress && s.progress.status !== "done") s.progress.status = "stopped";
    },

    requestPause(): void {
      const s = _st(wid);
      if (!s.progress || s.progress.status === "done" || s.progress.status === "stopped") return;
      s.pauseRequested = true;
    },

    requestResume(): void {
      const s = _st(wid);
      s.pauseRequested = false;
      if (s.progress && s.progress.status === "paused") s.progress.status = "running";
    },

    async addAd(text: string, media?: { data: string; type: "image" | "video" | "document"; caption?: string; filename?: string }): Promise<string> {
      const c = await col(wid);
      const doc: AdMessage = { workspaceId: wid, text, createdAt: new Date(), sentCount: 0 };
      if (media) {
        doc.mediaData    = media.data;
        doc.mediaType    = media.type;
        doc.mediaCaption = media.caption;
        doc.mediaFilename = media.filename;
      }
      const result = await c.insertOne(doc);
      return result.insertedId.toString();
    },

    async removeAd(id: string): Promise<void> {
      const { ObjectId } = await import("mongodb");
      const c = await col(wid);
      await c.deleteOne({ workspaceId: wid, _id: new ObjectId(id) as any });
    },

    async listAds(): Promise<AdMessage[]> {
      const c = await col(wid);
      return c.find({ workspaceId: wid }).sort({ createdAt: 1 }).toArray();
    },

    async start(onProgress?: (p: PublishProgress) => void): Promise<void> {
      const coord = getCoordinatorFor(wid);
      const tel   = getTelemetryFor(wid);

      if (!baileysManager.isConnectedForWorkspace(wid)) {
        throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
      }
      if (coord.isJoinWindowActive()) {
        throw new Error("⛔ نافذة انضمام نشطة — لا يمكن النشر حالياً.");
      }

      const acquired = await coord.acquire("publishing");
      if (!acquired) {
        const active = coord.getActive();
        throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
      }

      const s = _st(wid);
      s.stopRequested  = false;
      s.pauseRequested = false;

      try {
        await systemState.setActiveFunction(wid, "publishing");

        const self = _createManager(wid);
        const ads  = await self.listAds();
        if (!ads.length) throw new Error("لا توجد إعلانات محفوظة. أضف إعلاناً أولاً.");

        const currentPhone = baileysManager.getConnectedPhoneForWorkspace(wid) ?? undefined;
        console.log(`[Publisher:${wid}] Starting — phone: ${currentPhone ?? "unknown"}`);

        // ── Fetch LIVE groups directly from WhatsApp (not from DB) ──────────────
        const _sock = baileysManager.getActiveStateForWorkspace(wid)?.sock;
        if (!_sock) throw new Error("واتساب غير متصل.");
        console.log(`[Publisher:${wid}] Fetching live groups from WhatsApp...`);
        const _allWA   = await _sock.groupFetchAllParticipating();
        const allGroups: any[] = Object.values(_allWA);
        if (!allGroups.length) throw new Error("لا توجد مجموعات على واتساب حالياً.");
        console.log(`[Publisher:${wid}] Found ${allGroups.length} groups from WhatsApp`);

        // Build excluded-JID set (cross-reference URLs → JIDs from Links_Repository)
        const _db             = await getDb();
        const _excludedList   = await excludedGroups.list(wid);
        const excludedJidSet  = new Set<string>();
        const _excludedUrls   = _excludedList.map(e => e.url);
        if (_excludedUrls.length) {
          const _excRecs = await _db.collection("Links_Repository")
            .find({ workspaceId: wid, url: { $in: _excludedUrls }, groupJid: { $exists: true } },
                  { projection: { groupJid: 1 } })
            .toArray() as any[];
          for (const r of _excRecs) { if (r.groupJid) excludedJidSet.add(r.groupJid); }
        }
        // Also handle synced-URL pattern: wa-sync/<jid>
        for (const eg of _excludedList) {
          const m = eg.url.match(/\/wa-sync\/(.+)$/);
          if (m) excludedJidSet.add(m[1]);
        }

        const state = await systemState.get(wid);
        let adIdx = ((state.last_published_ad_index ?? -1) + 1) % ads.length;

        const shuffledGroups = shuffle(allGroups);
        const batchLimit     = randomInt(BATCH_SIZE_MIN, BATCH_SIZE_MAX);

        s.progress = {
          status:    "running",
          total:     shuffledGroups.length,
          processed: 0,
          sent:      0,
          failed:    0,
          startedAt: new Date().toISOString(),
        };

        onProgress?.(s.progress);

        let consecutiveFailures = 0;
        let sendsSinceRest      = 0;

        for (const group of shuffledGroups) {
          if (s.stopRequested || s.progress.status === "stopped") {
            s.progress.status = "stopped"; break;
          }

          while (s.pauseRequested && !s.stopRequested) {
            s.progress.status = "paused";
            await new Promise(r => setTimeout(r, 1000));
          }
          if (s.stopRequested) { s.progress.status = "stopped"; break; }
          if (s.progress.status === "paused") s.progress.status = "running";

          if (!baileysManager.isConnectedForWorkspace(wid)) {
            s.progress.status = "stopped"; break;
          }

          if (baileysManager.isUserActiveForWorkspace(wid, 90_000)) {
            console.log(`[Publisher:${wid}] 👤 User active — pausing 2 min`);
            if (s.progress) s.progress.status = "cooldown";
            const outcome = await interruptibleSleep(wid, 2 * 60_000);
            if (outcome === "stopped") { s.progress.status = "stopped"; break; }
            if (s.progress) s.progress.status = "running";
          }

          if (tel.isCoolingDown()) {
            const coolMs = tel.cooldownRemaining();
            console.log(`[Publisher:${wid}] Telemetry cooldown — ${Math.round(coolMs / 60_000)} min`);
            syncTelemetry(wid);
            if (s.progress) s.progress.status = "cooldown";
            const outcome = await interruptibleSleep(wid, coolMs);
            if (outcome === "stopped") { s.progress.status = "stopped"; break; }
            if (s.progress) s.progress.status = "running";
          }

          if (sendsSinceRest >= batchLimit) {
            const restMs = randomInt(3 * 60_000, 7 * 60_000);
            console.log(`[Publisher:${wid}] Batch rest after ${sendsSinceRest} sends — ${Math.round(restMs / 60_000)} min`);
            const outcome = await interruptibleSleep(wid, restMs);
            if (outcome === "stopped") { s.progress.status = "stopped"; break; }
            sendsSinceRest = 0;
          }

          // JID and display name come directly from WhatsApp — no DB lookup needed
          const jid: string  = group.id;
          const label: string = group.subject ?? jid;
          s.progress.currentGroup = label;
          onProgress?.(s.progress);

          // Skip excluded groups (by JID)
          if (excludedJidSet.has(jid)) {
            console.log(`[Publisher:${wid}] ⛔ Excluded — skipping: ${label}`);
            s.progress.processed++;
            continue;
          }

          // Skip admins-only groups (flag already in group metadata from WA)
          if (group.announce === true) {
            console.log(`[Publisher:${wid}] ⏭ Admins-only — skipping: ${label}`);
            s.progress.processed++;
            continue;
          }

          const ad  = ads[adIdx % ads.length];
          adIdx     = (adIdx + 1) % ads.length;

          const t0 = Date.now();
          try {
            await DELAYS.typingBeforeSend();
            await baileysManager.sendAdMessageForWorkspace(jid, ad, wid);

            const latency = Date.now() - t0;
            tel.record(latency);
            syncTelemetry(wid);

            const c = await col(wid);
            await c.updateOne(
              { workspaceId: wid, _id: (ad as any)._id },
              { $inc: { sentCount: 1 }, $set: { lastSentAt: new Date() } }
            );
            await systemState.update(wid, { last_published_ad_index: adIdx });
            // Persist progress snapshot so it survives server restarts
            void systemState.setExtra(wid, { publishProgress: s.progress }).catch(() => {});

            s.progress.sent++;
            consecutiveFailures = 0;
            sendsSinceRest++;
            console.log(`[Publisher:${wid}] ✓ Sent (${latency}ms) to ${label}`);

          } catch (err: unknown) {
            const classified = classifyWAError(err, consecutiveFailures);
            consecutiveFailures++;
            syncTelemetry(wid);

            if (classified.action === "stop_all") {
              s.progress.status = "stopped";
              tel.triggerEmergency(classified.reason, 30 * 60_000);
              break;
            }

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              s.progress.status = "stopped";
              console.error(`[Publisher:${wid}] Too many consecutive failures — stopping`);
              break;
            }

            s.progress.failed++;
            console.warn(`[Publisher:${wid}] ✗ ${classified.reason} | ${label}`);

            if (classified.action === "wait_and_retry") {
              const waitMs = classified.waitMs ?? 60_000;
              const outcome = await interruptibleSleep(wid, waitMs);
              if (outcome === "stopped") { s.progress.status = "stopped"; break; }
            }
          }

          s.progress.processed++;
          onProgress?.(s.progress);

          if (s.progress.processed < s.progress.total && s.progress.status === "running") {
            const outcome = await interruptibleSleep(wid, randomInt(10_000, 30_000));
            if (outcome === "stopped") { s.progress.status = "stopped"; break; }
          }
        }

        if (s.progress.status === "running") {
          s.progress.status      = "done";
          s.progress.completedAt = new Date().toISOString();
        }

        console.log(`[Publisher:${wid}] Done — sent: ${s.progress.sent}, failed: ${s.progress.failed}`);

        if (s.progress.completedAt) {
          void publishHistory.save({
            startedAt:   s.progress.startedAt,
            completedAt: s.progress.completedAt,
            status:      s.progress.status as "done" | "stopped" | "error",
            total:       s.progress.total,
            processed:   s.progress.processed,
            sent:        s.progress.sent,
            failed:      s.progress.failed,
            phone:       baileysManager.getConnectedPhoneForWorkspace(wid) ?? undefined,
          });
        }
      } finally {
        if (s.progress) s.progress.currentGroup = undefined;
        coord.release();
        await systemState.setActiveFunction(wid, null);
      }
    },
  };
}

const _managerCache = new Map<string, ReturnType<typeof _createManager>>();

export function getPublisherFor(workspaceId: string): ReturnType<typeof _createManager> {
  if (!_managerCache.has(workspaceId)) {
    _managerCache.set(workspaceId, _createManager(workspaceId));
  }
  return _managerCache.get(workspaceId)!;
}
