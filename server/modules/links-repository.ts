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

  /** Mark a link's status and optionally record timestamps. */
  async setStatus(url: string, status: LinkStatus): Promise<void> {
    const c = await col();
    const extra: Partial<LinkRecord> = { status, updatedAt: new Date() };
    if (status === "Joined") extra.joinedAt = new Date();
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

  /** Find links pending joining (status=Pending, type=Group or Channel). */
  async findPendingForJoin(): Promise<LinkRecord[]> {
    const c = await col();
    return c.find({ status: "Pending" }).sort({ addedAt: 1 }).toArray();
  },

  /** Find joined groups for message reading / publishing. */
  async findJoined(): Promise<LinkRecord[]> {
    const c = await col();
    return c.find({ status: "Joined" }).toArray();
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
    let newAds = 0;
    let newDescLinks = 0;

    for (const g of groups) {
      const added = await this.addIfNew(g.link, "Group", "upload", {
        name: g.name, members: g.members, description: g.description,
      });
      if (added) newGroups++;
    }

    for (const a of ads) {
      const added = await this.addIfNew(a.link, "Group", "upload", {
        name: a.name, members: a.members, description: a.description,
      });
      if (added) newAds++;
    }

    if (descLinks) {
      for (const url of descLinks) {
        if (!url.includes("chat.whatsapp.com")) continue;
        const added = await this.addIfNew(url, "Group", "description");
        if (added) newDescLinks++;
      }
    }

    console.log(`[LinksRepository] Filtered saved → ${newGroups} new groups, ${newAds} new ads, ${newDescLinks} new desc links`);
    return { newGroups, newAds, newDescLinks };
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
