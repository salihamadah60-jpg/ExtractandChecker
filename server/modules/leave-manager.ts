/**
 * leave-manager.ts — LeavingQueue processor (per-workspace)
 */

import { getDb }             from "../mongo-auth-state.js";
import { baileysManager }    from "../baileys-manager.js";
import { getCoordinatorFor } from "./function-coordinator.js";
import { systemState }       from "./system-state.js";
import { linksRepository }   from "./links-repository.js";
import { classifyWAError }   from "./wa-error-handler.js";
import { DELAYS, randomInt } from "./human-mimicry.js";

export interface LeaveQueueEntry {
  workspaceId:  string;
  url:          string;
  groupJid?:    string;
  enqueuedAt:   Date;
  reason?:      string;
  scheduledAt?: Date;
}

export interface LeaveProgress {
  status:       "running" | "done" | "stopped" | "paused" | "error";
  total:        number;
  processed:    number;
  left:         number;
  failed:       number;
  startedAt:    string;
  completedAt?: string;
  currentLink?: string;
}

const COL = "LeavingQueue";

async function col() {
  const db = await getDb();
  return db.collection<LeaveQueueEntry>(COL);
}

// ── Per-workspace state ────────────────────────────────────────────────────────

interface WState {
  progress:       LeaveProgress | null;
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

async function _interruptibleSleep(wid: string, ms: number): Promise<"done" | "stopped"> {
  const TICK = 500;
  const s    = _st(wid);
  let remaining = ms;
  while (remaining > 0) {
    await new Promise(r => setTimeout(r, Math.min(TICK, remaining)));
    if (s.stopRequested) return "stopped";
    if (!s.pauseRequested) remaining -= Math.min(TICK, remaining);
    else if (s.progress) s.progress.status = "paused";
  }
  return "done";
}

// ── Manager factory ────────────────────────────────────────────────────────────

function _createManager(wid: string) {
  return {
    async init(): Promise<void> {
      const c = await col();
      await c.createIndex({ workspaceId: 1, url: 1 }, { unique: true, background: true } as any);
      console.log(`[LeaveManager:${wid}] LeavingQueue ready`);
    },

    async enqueue(url: string, reason?: string, scheduledAt?: Date): Promise<boolean> {
      const c  = await col();
      const db = await getDb();
      const rec = await db.collection("Links_Repository").findOne({ workspaceId: wid, url }) as any;
      const groupJid = rec?.groupJid ?? undefined;
      try {
        await c.insertOne({ workspaceId: wid, url, groupJid, enqueuedAt: new Date(), reason, scheduledAt } as LeaveQueueEntry);
        return true;
      } catch {
        return false;
      }
    },

    async updateSchedule(url: string, scheduledAt: Date | null): Promise<void> {
      const c = await col();
      await c.updateOne(
        { workspaceId: wid, url },
        scheduledAt ? { $set: { scheduledAt } } : { $unset: { scheduledAt: "" } },
      );
    },

    async leaveNow(url: string): Promise<void> {
      if (!baileysManager.isConnectedForWorkspace(wid)) {
        throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
      }
      const db  = await getDb();
      const rec = await db.collection("Links_Repository").findOne({ workspaceId: wid, url }) as any;
      const jid = rec?.groupJid;
      if (!jid) throw new Error("لم يُعثر على JID للمجموعة — غير قادر على المغادرة الفورية");
      await baileysManager.leaveGroupForWorkspace(jid, wid);
      await linksRepository.setStatus(wid, url, "Left");
      const c = await col();
      await c.deleteOne({ workspaceId: wid, url });
    },

    async dequeue(url: string): Promise<void> {
      const c = await col();
      await c.deleteOne({ workspaceId: wid, url });
    },

    async listQueue(): Promise<LeaveQueueEntry[]> {
      const c = await col();
      return c.find({ workspaceId: wid }).sort({ enqueuedAt: 1 }).toArray();
    },

    async queueSize(): Promise<number> {
      const c = await col();
      return c.countDocuments({ workspaceId: wid });
    },

    getProgress(): LeaveProgress | null { return _st(wid).progress; },

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
      if (s.progress) s.progress.status = "paused";
    },

    requestResume(): void {
      const s = _st(wid);
      s.pauseRequested = false;
      if (s.progress && s.progress.status === "paused") s.progress.status = "running";
    },

    async processQueue(): Promise<void> {
      const coord = getCoordinatorFor(wid);

      if (!baileysManager.isConnectedForWorkspace(wid)) {
        throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
      }

      const acquired = await coord.acquire("leaving");
      if (!acquired) {
        const active = coord.getActive();
        throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
      }

      const s = _st(wid);
      s.stopRequested  = false;
      s.pauseRequested = false;

      try {
        await systemState.setActiveFunction(wid, "leaving");

        const self  = _createManager(wid);
        const queue = await self.listQueue();
        if (!queue.length) throw new Error("قائمة المغادرة فارغة.");

        s.progress = {
          status:    "running",
          total:     queue.length,
          processed: 0,
          left:      0,
          failed:    0,
          startedAt: new Date().toISOString(),
        };

        const c = await col();

        for (const entry of queue) {
          if (s.stopRequested || s.progress.status === "stopped") {
            s.progress.status = "stopped"; break;
          }

          // Pause gate
          while (s.pauseRequested && !s.stopRequested) {
            s.progress.status = "paused";
            await new Promise(r => setTimeout(r, 500));
          }
          if (s.stopRequested) { s.progress.status = "stopped"; break; }
          if (s.progress.status === "paused") s.progress.status = "running";

          if (!baileysManager.isConnectedForWorkspace(wid)) {
            s.progress.status = "stopped"; break;
          }

          s.progress.currentLink = entry.url;

          // Skip entries scheduled for the future
          if (entry.scheduledAt && entry.scheduledAt > new Date()) {
            console.log(`[LeaveManager:${wid}] ⏰ Skipping future-scheduled: ${entry.url} (due: ${entry.scheduledAt.toISOString()})`);
            s.progress.processed++;
            continue;
          }

          const jid = entry.groupJid;

          if (!jid) {
            console.warn(`[LeaveManager:${wid}] No groupJid for ${entry.url} — marking as left`);
            await linksRepository.setStatus(wid, entry.url, "Left");
            await c.deleteOne({ workspaceId: wid, url: entry.url });
            s.progress.left++;
            s.progress.processed++;
            continue;
          }

          await DELAYS.beforeLeave();

          try {
            await baileysManager.leaveGroupForWorkspace(jid, wid);
            await linksRepository.setStatus(wid, entry.url, "Left");
            await c.deleteOne({ workspaceId: wid, url: entry.url });
            s.progress.left++;
            console.log(`[LeaveManager:${wid}] ✓ Left: ${entry.url}`);
          } catch (err: unknown) {
            const classified = classifyWAError(err, 0);
            if (classified.action === "stop_all") {
              s.progress.status = "stopped"; break;
            }
            if (classified.action === "skip" || classified.action === "already_member") {
              await linksRepository.setStatus(wid, entry.url, "Left");
              await c.deleteOne({ workspaceId: wid, url: entry.url });
              s.progress.left++;
            } else {
              s.progress.failed++;
              console.warn(`[LeaveManager:${wid}] ✗ ${classified.reason} | ${entry.url}`);
            }
          }

          s.progress.processed++;

          if (s.progress.processed < s.progress.total) {
            const outcome = await _interruptibleSleep(wid, randomInt(5_000, 15_000));
            if (outcome === "stopped") { s.progress.status = "stopped"; break; }
            const batchSize = randomInt(15, 25);
            if (s.progress.processed % batchSize === 0) {
              console.log(`[LeaveManager:${wid}] Mini-rest after ${s.progress.processed} leaves...`);
              const outcome2 = await _interruptibleSleep(wid, randomInt(60_000, 180_000));
              if (outcome2 === "stopped") { s.progress.status = "stopped"; break; }
            }
          }
        }

        if (s.progress.status === "running") {
          s.progress.status  = "done";
          s.progress.completedAt = new Date().toISOString();
        }

        console.log(`[LeaveManager:${wid}] Done — left: ${s.progress.left}, failed: ${s.progress.failed}`);
      } finally {
        if (s.progress) s.progress.currentLink = undefined;
        coord.release();
        await systemState.setActiveFunction(wid, null);
      }
    },
  };
}

const _managerCache = new Map<string, ReturnType<typeof _createManager>>();

export function getLeaveManagerFor(workspaceId: string): ReturnType<typeof _createManager> {
  if (!_managerCache.has(workspaceId)) {
    _managerCache.set(workspaceId, _createManager(workspaceId));
  }
  return _managerCache.get(workspaceId)!;
}
