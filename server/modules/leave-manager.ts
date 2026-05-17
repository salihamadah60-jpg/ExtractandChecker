/**
 * leave-manager.ts — LeavingQueue processor
 *
 * Features:
 *   - LeavingQueue MongoDB collection: links enqueued for leaving
 *   - Coordinator lock: blocked if another function is running
 *   - Calls baileysManager.leaveGroup(groupJid) for each queued group
 *   - Updates Links_Repository: Joined → Left
 *   - Human-mimicry delays between leaves
 *   - Handles errors gracefully (already left, not member, etc.)
 */

import { getDb } from "../mongo-auth-state.js";
import { baileysManager } from "../baileys-manager.js";
import { coordinator } from "./function-coordinator.js";
import { systemState } from "./system-state.js";
import { linksRepository } from "./links-repository.js";
import { classifyWAError } from "./wa-error-handler.js";
import { DELAYS, randomInt } from "./human-mimicry.js";

export interface LeaveQueueEntry {
  url: string;
  groupJid?: string;
  enqueuedAt: Date;
  reason?: string;
}

export interface LeaveProgress {
  status: "running" | "done" | "stopped" | "error";
  total: number;
  processed: number;
  left: number;
  failed: number;
  startedAt: string;
  completedAt?: string;
  currentLink?: string;
}

const COL = "LeavingQueue";

async function col() {
  const db = await getDb();
  return db.collection<LeaveQueueEntry>(COL);
}

let _progress: LeaveProgress | null = null;
let _stopRequested = false;

export const leaveManager = {
  /** Initialize collection index. */
  async init(): Promise<void> {
    const c = await col();
    await c.createIndex({ url: 1 }, { unique: true, background: true } as any);
    console.log("[LeaveManager] LeavingQueue ready");
  },

  /** Add a URL to the leaving queue. groupJid is resolved from Links_Repository if not provided. */
  async enqueue(url: string, reason?: string): Promise<boolean> {
    const c = await col();
    // Look up groupJid from Links_Repository
    const db = await getDb();
    const rec = await db.collection("Links_Repository").findOne({ url }) as any;
    const groupJid = rec?.groupJid ?? undefined;

    try {
      await c.insertOne({ url, groupJid, enqueuedAt: new Date(), reason } as LeaveQueueEntry);
      return true;
    } catch {
      return false; // already in queue
    }
  },

  /** Remove a URL from the queue (if user changes mind). */
  async dequeue(url: string): Promise<void> {
    const c = await col();
    await c.deleteOne({ url });
  },

  /** Get all entries in the queue. */
  async listQueue(): Promise<LeaveQueueEntry[]> {
    const c = await col();
    return c.find({}).sort({ enqueuedAt: 1 }).toArray();
  },

  /** Get queue size. */
  async queueSize(): Promise<number> {
    const c = await col();
    return c.countDocuments();
  },

  getProgress(): LeaveProgress | null {
    return _progress;
  },

  requestStop(): void {
    _stopRequested = true;
    if (_progress && _progress.status === "running") {
      _progress.status = "stopped";
    }
  },

  /** Process the entire leaving queue. */
  async processQueue(): Promise<void> {
    if (!baileysManager.isConnected()) {
      throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
    }

    const acquired = await coordinator.acquire("leaving");
    if (!acquired) {
      const active = coordinator.getActive();
      throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
    }

    _stopRequested = false;

    try {
      await systemState.setActiveFunction("leaving");

      const queue = await leaveManager.listQueue();
      if (!queue.length) {
        throw new Error("قائمة المغادرة فارغة.");
      }

      _progress = {
        status: "running",
        total: queue.length,
        processed: 0,
        left: 0,
        failed: 0,
        startedAt: new Date().toISOString(),
      };

      const c = await col();

      for (const entry of queue) {
        if (_stopRequested || _progress.status === "stopped") {
          _progress.status = "stopped";
          break;
        }

        if (!baileysManager.isConnected()) {
          _progress.status = "stopped";
          break;
        }

        _progress.currentLink = entry.url;

        const jid = entry.groupJid;
        if (!jid) {
          // No JID — we can't leave without knowing the group JID
          console.warn(`[LeaveManager] No groupJid for ${entry.url} — marking as left anyway`);
          await linksRepository.setStatus(entry.url, "Left");
          await c.deleteOne({ url: entry.url });
          _progress.left++;
          _progress.processed++;
          continue;
        }

        // ── Pre-leave pause ────────────────────────────────────────────────────
        await DELAYS.beforeLeave();

        try {
          await baileysManager.leaveGroup(jid);
          await linksRepository.setStatus(entry.url, "Left");
          await c.deleteOne({ url: entry.url });
          _progress.left++;
          console.log(`[LeaveManager] ✓ Left: ${entry.url}`);
        } catch (err: unknown) {
          const classified = classifyWAError(err, 0);

          if (classified.action === "stop_all") {
            _progress.status = "stopped";
            break;
          }

          // "not a member" / "already left" — still mark as Left
          if (
            classified.action === "skip" ||
            classified.action === "already_member"
          ) {
            await linksRepository.setStatus(entry.url, "Left");
            await c.deleteOne({ url: entry.url });
            _progress.left++;
          } else {
            _progress.failed++;
            console.warn(`[LeaveManager] ✗ ${classified.reason} | ${entry.url}`);
          }
        }

        _progress.processed++;

        // ── Human delay between leaves ─────────────────────────────────────
        if (_progress.processed < _progress.total) {
          await DELAYS.betweenJoins(); // reuse join delay (3–8s)

          // Longer rest every N leaves
          const batchSize = randomInt(15, 25);
          if (_progress.processed % batchSize === 0) {
            console.log(`[LeaveManager] Mini-rest after ${_progress.processed} leaves...`);
            await DELAYS.batchRestAfterJoins();
          }
        }
      }

      if (_progress.status === "running") {
        _progress.status = "done";
        _progress.completedAt = new Date().toISOString();
      }

      console.log(`[LeaveManager] Done — left: ${_progress.left}, failed: ${_progress.failed}`);
    } finally {
      if (_progress) _progress.currentLink = undefined;
      coordinator.release();
      await systemState.setActiveFunction(null);
    }
  },
};
