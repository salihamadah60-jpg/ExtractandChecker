/**
 * publisher.ts — Ad publishing module
 *
 * Sends user-defined ads to all joined WhatsApp groups.
 * - Ads stored in MongoDB Keywords_Config collection
 * - Ad rotation is randomised each run (shuffle)
 * - All delays use human-mimicry (no fixed timing)
 * - Blocked if another function is running (coordinator)
 * - System_State tracks last_published_ad_index for resumability
 * - Real Baileys sendTextMessage integration
 */

import { getDb } from "../mongo-auth-state.js";
import { baileysManager } from "../baileys-manager.js";
import { coordinator } from "./function-coordinator.js";
import { systemState } from "./system-state.js";
import { linksRepository } from "./links-repository.js";
import { classifyWAError } from "./wa-error-handler.js";
import { DELAYS, shuffle, randomPick } from "./human-mimicry.js";

export interface AdMessage {
  _id?: string;
  text: string;
  createdAt: Date;
  sentCount: number;
  lastSentAt?: Date;
}

export interface PublishProgress {
  status: "running" | "done" | "stopped" | "error";
  total: number;
  processed: number;
  sent: number;
  failed: number;
  currentGroup?: string;
  startedAt: string;
  completedAt?: string;
}

const COL = "Keywords_Config";

async function col() {
  const db = await getDb();
  return db.collection<AdMessage>(COL);
}

let _progress: PublishProgress | null = null;
let _stopRequested = false;

export const publisher = {
  getProgress(): PublishProgress | null {
    return _progress;
  },

  requestStop(): void {
    _stopRequested = true;
    if (_progress && _progress.status === "running") _progress.status = "stopped";
  },

  /** Save a new ad message. Returns the new document ID as string. */
  async addAd(text: string): Promise<string> {
    const c = await col();
    const result = await c.insertOne({ text, createdAt: new Date(), sentCount: 0 } as AdMessage);
    return result.insertedId.toString();
  },

  /** Delete an ad by its MongoDB ObjectId string. */
  async removeAd(id: string): Promise<void> {
    const { ObjectId } = await import("mongodb");
    const c = await col();
    await c.deleteOne({ _id: new ObjectId(id) as any });
  },

  /** List all saved ads ordered by creation date. */
  async listAds(): Promise<AdMessage[]> {
    const c = await col();
    return c.find({}).sort({ createdAt: 1 }).toArray();
  },

  /**
   * Start the publishing loop.
   * Sends each saved ad to all joined groups in random order.
   * Rotates through ads sequentially to ensure even distribution.
   */
  async start(onProgress?: (p: PublishProgress) => void): Promise<void> {
    if (!baileysManager.isConnected()) {
      throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
    }

    const acquired = await coordinator.acquire("publishing");
    if (!acquired) {
      const active = coordinator.getActive();
      throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
    }

    _stopRequested = false;

    try {
      await systemState.setActiveFunction("publishing");

      const ads = await publisher.listAds();
      if (!ads.length) throw new Error("لا توجد إعلانات محفوظة. أضف إعلاناً أولاً.");

      const joinedGroups = await linksRepository.findJoined();
      if (!joinedGroups.length) throw new Error("لا توجد مجموعات منضم إليها للنشر.");

      // Get last published index for resumability
      const state = await systemState.get();
      let adIdx = (state.last_published_ad_index ?? -1 + 1) % ads.length;

      const shuffledGroups = shuffle(joinedGroups);

      _progress = {
        status: "running",
        total: shuffledGroups.length,
        processed: 0,
        sent: 0,
        failed: 0,
        startedAt: new Date().toISOString(),
      };

      onProgress?.(_progress);
      let consecutiveFailures = 0;

      for (const group of shuffledGroups) {
        if (_stopRequested || _progress.status === "stopped") {
          _progress.status = "stopped";
          break;
        }

        if (!baileysManager.isConnected()) {
          _progress.status = "stopped";
          break;
        }

        _progress.currentGroup = group.url;
        onProgress?.(_progress);

        // Get target JID from Links_Repository
        const db = await getDb();
        const rec = await db.collection("Links_Repository").findOne({ url: group.url }) as any;
        const jid = rec?.groupJid;

        if (!jid) {
          // No JID saved — can't send without it
          console.warn(`[Publisher] No groupJid for ${group.url} — skipping`);
          _progress.processed++;
          continue;
        }

        const ad = ads[adIdx % ads.length];
        adIdx = (adIdx + 1) % ads.length;

        try {
          // Simulate typing delay before send
          await DELAYS.typingBeforeSend();
          await baileysManager.sendTextMessage(jid, ad.text);

          // Update sent count in DB
          const c = await col();
          await c.updateOne(
            { _id: (ad as any)._id },
            { $inc: { sentCount: 1 }, $set: { lastSentAt: new Date() } }
          );
          await systemState.update({ last_published_ad_index: adIdx });

          _progress.sent++;
          consecutiveFailures = 0;
          console.log(`[Publisher] ✓ Sent to ${group.url}: "${ad.text.slice(0, 40)}..."`);
        } catch (err: unknown) {
          const classified = classifyWAError(err, consecutiveFailures);
          consecutiveFailures++;

          if (classified.action === "stop_all") {
            _progress.status = "stopped";
            console.error(`[Publisher] CRITICAL: ${classified.reason}`);
            break;
          }

          _progress.failed++;
          console.warn(`[Publisher] ✗ ${classified.reason} | ${group.url}`);

          if (classified.action === "wait_and_retry") {
            await new Promise((r) => setTimeout(r, classified.waitMs ?? 30_000));
          }
        }

        _progress.processed++;
        onProgress?.(_progress);

        if (_progress.processed < _progress.total) {
          await DELAYS.betweenPublishedMessages();
        }
      }

      if (_progress.status === "running") {
        _progress.status = "done";
        _progress.completedAt = new Date().toISOString();
      }

      console.log(`[Publisher] Done — sent: ${_progress.sent}, failed: ${_progress.failed}`);
    } finally {
      if (_progress) _progress.currentGroup = undefined;
      coordinator.release();
      await systemState.setActiveFunction(null);
    }
  },
};
