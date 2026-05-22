/**
 * links-repository.ts — MongoDB Links_Repository collection
 *
 * Single source of truth for ALL links ever seen by the bot.
 * Prevents duplication across rounds, sessions, and functions.
 *
 * Collections:
 *  - Links_Repository: all links with type + status
 */

import { getDb } from "../mongo-auth-state.js";

export type LinkStatus = "Pending" | "Joined" | "Ignored" | "Left";
export type LinkType = "Group" | "Channel";
export type LinkSource = "upload" | "description" | "message" | "manual";

export interface LinkRecord {
  url: string;
  groupJid?: string;
  type: LinkType;
  status: LinkStatus;
  name?: string;
  members?: number;
  description?: string;
  source: LinkSource;
  addedAt: Date;
  updatedAt: Date;
  joinedAt?: Date;
  leftAt?: Date;
  checkCount: number;
  lastCheckedAt?: Date;
  /** Phone number of the WhatsApp account that joined this link. */
  joinedByPhone?: string;
}

const COL = "Links_Repository";

async function col() {
  const db = await getDb();
  return db.collection<LinkRecord>(COL);
}

export const linksRepository = {
  /** Create indexes — call once on startup. */
  async init(): Promise<void> {
    const c = await col();
    await c.createIndex({ url: 1 }, { unique: true, background: true } as any);
    await c.createIndex({ status: 1, type: 1 }, { background: true } as any);
    console.log("[LinksRepository] Indexes ready");
  },

  /**
   * Insert a new link if not already present.
   * Returns true if inserted, false if it already existed.
   */
  async addIfNew(
    url: string,
    type: LinkType,
    source: LinkSource,
    extra: Partial<Pick<LinkRecord, "name" | "members" | "description">> = {}
  ): Promise<boolean> {
    const c = await col();
    try {
      await c.insertOne({
        url,
        type,
        status: "Pending",
        source,
        addedAt: new Date(),
        updatedAt: new Date(),
        checkCount: 0,
        ...extra,
      } as LinkRecord);
      return true;
    } catch {
      return false; // duplicate key = already exists
    }
  },

  /** Upsert a link — updates metadata but won't overwrite status. */
  async upsert(
    url: string,
    type: LinkType,
    source: LinkSource,
    extra: Partial<Pick<LinkRecord, "name" | "members" | "description">> = {}
  ): Promise<void> {
    const c = await col();
    await c.updateOne(
      { url },
      {
        $setOnInsert: { url, type, status: "Pending", source, addedAt: new Date(), checkCount: 0 },
        $set: { updatedAt: new Date(), ...extra },
        $inc: { checkCount: 0 }, // touch without incrementing on upsert
      } as any,
      { upsert: true }
    );
  },

  /** Mark a link's status and optionally record timestamps + joining phone. */
  async setStatus(url: string, status: LinkStatus, joinedByPhone?: string): Promise<void> {
    const c = await col();
    const extra: Partial<LinkRecord> = { status, updatedAt: new Date() };
    if (status === "Joined") {
      extra.joinedAt = new Date();
      if (joinedByPhone) extra.joinedByPhone = joinedByPhone;
    }
    if (status === "Left") extra.leftAt = new Date();
    await c.updateOne({ url }, { $set: extra });
  },

  /** Increment check count and update last-checked timestamp. */
  async recordCheck(url: string, name?: string, members?: number, description?: string): Promise<void> {
    const c = await col();
    await c.updateOne(
      { url },
      {
        $inc: { checkCount: 1 },
        $set: { lastCheckedAt: new Date(), updatedAt: new Date(), ...(name && { name }), ...(members && { members }), ...(description && { description }) },
      }
    );
  },

  /** Returns true if URL is already in the repository. */
  async exists(url: string): Promise<boolean> {
    const c = await col();
    return !!(await c.findOne({ url }, { projection: { _id: 1 } }));
  },

  /** Find all links with a given status. */
  async findByStatus(status: LinkStatus): Promise<LinkRecord[]> {
    const c = await col();
    return c.find({ status }).toArray();
  },

  /**
   * Find links pending joining for a specific WhatsApp account.
   * Returns:
   *   - All links with status "Pending" (not yet joined by anyone)
   *   - Links with status "Joined" by a DIFFERENT phone (the current account hasn't joined them)
   */
  async findPendingForJoin(currentPhone?: string): Promise<LinkRecord[]> {
    const c = await col();
    if (currentPhone) {
      // Pending OR joined by someone else
      return c.find({
        $or: [
          { status: "Pending" },
          { status: "Joined", joinedByPhone: { $exists: false } },           // legacy: no phone recorded
          { status: "Joined", joinedByPhone: { $ne: currentPhone } },         // joined by different account
        ],
      }).sort({ addedAt: 1 }).toArray();
    }
    // Fallback (no phone known): only truly Pending
    return c.find({ status: "Pending" }).sort({ addedAt: 1 }).toArray();
  },

  /** Find joined groups for message reading / publishing (for THIS phone). */
  async findJoined(currentPhone?: string): Promise<LinkRecord[]> {
    const c = await col();
    if (currentPhone) {
      return c.find({ status: "Joined", joinedByPhone: currentPhone }).toArray();
    }
    return c.find({ status: "Joined" }).toArray();
  },

  /**
   * Reset links that were joined by a DIFFERENT phone back to Pending.
   * Call this when a new account connects.
   * Returns the number of links reset.
   */
  async resetJoinedByOtherPhone(currentPhone: string): Promise<number> {
    const c = await col();
    const result = await c.updateMany(
      {
        status: "Joined",
        $or: [
          { joinedByPhone: { $exists: false } },        // legacy records without phone
          { joinedByPhone: { $ne: currentPhone } },     // joined by a different account
        ],
      },
      { $set: { status: "Pending" as LinkStatus, updatedAt: new Date() }, $unset: { joinedAt: "" } }
    );
    console.log(`[LinksRepository] Reset ${result.modifiedCount} links joined by other accounts → Pending (phone: ${currentPhone})`);
    return result.modifiedCount;
  },

  /** Count by status from the perspective of a specific phone. */
  async countByStatusForPhone(currentPhone?: string): Promise<Record<LinkStatus, number>> {
    const c = await col();
    const all = await c.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
    const result: Record<string, number> = { Pending: 0, Joined: 0, Ignored: 0, Left: 0 };
    all.forEach((d: any) => { result[d._id] = d.count; });

    if (currentPhone) {
      // "Joined" for THIS account = records with joinedByPhone === currentPhone
      const joinedByMe = await c.countDocuments({ status: "Joined", joinedByPhone: currentPhone });
      const joinedByOthers = await c.countDocuments({
        status: "Joined",
        $or: [{ joinedByPhone: { $ne: currentPhone } }, { joinedByPhone: { $exists: false } }],
      });
      // From this account's perspective: links joined by others are still "pending"
      result.Joined  = joinedByMe;
      result.Pending = result.Pending + joinedByOthers;
    }

    return result as Record<LinkStatus, number>;
  },

  /** Return all URLs (for deduplication). */
  async getAllUrls(): Promise<Set<string>> {
    const c = await col();
    const docs = await c.find({}, { projection: { url: 1 } }).toArray();
    return new Set(docs.map((d) => d.url));
  },

  /** Total count by status. */
  async countByStatus(): Promise<Record<LinkStatus, number>> {
    const c = await col();
    const agg = await c.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
    const result: Record<string, number> = { Pending: 0, Joined: 0, Ignored: 0, Left: 0 };
    agg.forEach((d: any) => { result[d._id] = d.count; });
    return result as Record<LinkStatus, number>;
  },

  /**
   * Save filtered results (groups + ads + description links) as Pending links.
   * Skips duplicates. Returns counts of newly added records.
   */
  async saveFilteredLinks(
    groups: { link: string; name?: string; members?: number; description?: string }[],
    ads: { link: string; name?: string; members?: number; description?: string }[],
    descLinks?: string[]
  ): Promise<{ newGroups: number; newAds: number; newDescLinks: number }> {
    let newGroups = 0;
    let newDescLinks = 0;

    // Only groups (>50 members) are saved for joining — ads links are NOT added to the join queue
    for (const g of groups) {
      const added = await this.addIfNew(g.link, "Group", "upload", {
        name: g.name, members: g.members, description: g.description,
      });
      if (added) newGroups++;
    }

    if (descLinks) {
      for (const url of descLinks) {
        if (!url.includes("chat.whatsapp.com")) continue;
        const added = await this.addIfNew(url, "Group", "description");
        if (added) newDescLinks++;
      }
    }

    console.log(`[LinksRepository] Filtered saved → ${newGroups} new groups, 0 ads (excluded), ${newDescLinks} new desc links`);
    return { newGroups, newAds: 0, newDescLinks };
  },

  /** Get daily additions for the last N days (for trend chart). */
  async getDailyTrend(days = 14): Promise<{ date: string; count: number }[]> {
    const c = await col();
    const since = new Date();
    since.setDate(since.getDate() - days);
    const agg = await c.aggregate([
      { $match: { addedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$addedAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    return agg.map((d: any) => ({ date: d._id as string, count: d.count as number }));
  },

  /** Get count by source. */
  async countBySource(): Promise<Record<string, number>> {
    const c = await col();
    const agg = await c.aggregate([{ $group: { _id: "$source", count: { $sum: 1 } } }]).toArray();
    const result: Record<string, number> = {};
    agg.forEach((d: any) => { result[d._id] = d.count; });
    return result;
  },

  /** Get the most recently added links (for activity feed). */
  async getRecent(limit = 15): Promise<LinkRecord[]> {
    const c = await col();
    return c.find({}).sort({ addedAt: -1 }).limit(limit).toArray();
  },

  /**
   * Handle group removal/kick — mark the record as Left by groupJid.
   * Called when the bot is removed from a group.
   */
  async handleGroupRemoval(groupJid: string): Promise<void> {
    const c = await col();
    const result = await c.updateOne(
      { groupJid, status: { $in: ["Joined", "Pending"] } },
      { $set: { status: "Left" as LinkStatus, leftAt: new Date(), updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[LinksRepository] Marked as Left (kicked/removed): ${groupJid}`);
    }
  },
};
