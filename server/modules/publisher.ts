/**
 * publisher.ts — Ad publishing module
 *
 * Sends user-defined ads to all joined WhatsApp groups.
 * - Ads are stored persistently in MongoDB (Keywords_Config collection)
 * - Rotation is random (shuffled on each run)
 * - All delays use human-mimicry utilities
 * - Blocked if another function is running (function-coordinator)
 * - State is saved to System_State for resumability
 *
 * Status: STUB — framework ready, Baileys send integration pending
 */

import { getDb } from "../mongo-auth-state.js";
import { coordinator } from "./function-coordinator.js";
import { systemState } from "./system-state.js";
import { linksRepository } from "./links-repository.js";
import { DELAYS, shuffle, randomPick } from "./human-mimicry.js";

export interface AdMessage {
  _id?: string;
  text: string;
  createdAt: Date;
  sentCount: number;
  lastSentAt?: Date;
}

const COL = "Keywords_Config";

async function col() {
  const db = await getDb();
  return db.collection<AdMessage>(COL);
}

export const publisher = {
  /** Save a new ad message to the database. */
  async addAd(text: string): Promise<string> {
    const c = await col();
    const result = await c.insertOne({ text, createdAt: new Date(), sentCount: 0 } as AdMessage);
    return result.insertedId.toString();
  },

  /** Delete an ad by its ID. */
  async removeAd(id: string): Promise<void> {
    const { ObjectId } = await import("mongodb");
    const c = await col();
    await c.deleteOne({ _id: new ObjectId(id) as any });
  },

  /** List all saved ads. */
  async listAds(): Promise<AdMessage[]> {
    const c = await col();
    return c.find({}).sort({ createdAt: 1 }).toArray();
  },

  /**
   * Start the publishing loop.
   * - Acquires function lock
   * - Shuffles ad list
   * - Iterates through all joined groups
   * - Sends each ad with human-mimicry delays
   *
   * STUB: actual Baileys sendMessage integration is pending.
   * See TODO comment below for integration point.
   */
  async start(
    onProgress?: (sent: number, total: number, groupUrl: string) => void
  ): Promise<void> {
    const acquired = await coordinator.acquire("publishing");
    if (!acquired) {
      throw new Error("وظيفة أخرى تعمل حالياً. يُرجى الانتظار حتى تنتهي.");
    }

    try {
      await systemState.setActiveFunction("publishing");

      const ads = await publisher.listAds();
      if (!ads.length) throw new Error("لا توجد إعلانات محفوظة. يُرجى إضافة إعلان أولاً.");

      const joinedGroups = await linksRepository.findJoined();
      if (!joinedGroups.length) throw new Error("لا توجد مجموعات منضم إليها للنشر.");

      const shuffledAds = shuffle(ads);
      const shuffledGroups = shuffle(joinedGroups);
      let sent = 0;

      for (const group of shuffledGroups) {
        const ad = shuffledAds[sent % shuffledAds.length];

        // TODO: Integrate Baileys sendMessage here:
        // const inviteCode = group.url.split("/").pop()!;
        // const groupId = await baileysManager.resolveGroupId(inviteCode);
        // await baileysManager.sendMessage(groupId, { text: ad.text });

        console.log(`[Publisher] STUB: would send to ${group.url}: "${ad.text.slice(0, 40)}..."`);

        // Update sent count
        const c = await col();
        await c.updateOne(
          { _id: (ad as any)._id },
          { $inc: { sentCount: 1 }, $set: { lastSentAt: new Date() } }
        );

        sent++;
        onProgress?.(sent, shuffledGroups.length, group.url);

        await DELAYS.typingBeforeSend();
        await DELAYS.betweenPublishedMessages();
      }

      console.log(`[Publisher] Done — sent to ${sent} groups`);
    } finally {
      coordinator.release();
      await systemState.setActiveFunction(null);
    }
  },
};
