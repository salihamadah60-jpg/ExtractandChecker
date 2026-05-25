/**
 * links-repository.ts — MongoDB Links_Repository collection (per-workspace)
 *
 * All methods accept workspaceId as the first parameter.
 * Unique index: { workspaceId, url } — allows same URL across different workspaces.
 */

import { getDb } from "../mongo-auth-state.js";

export type LinkStatus = "Pending" | "Joined" | "Ignored" | "Left";
export type LinkType = "Group" | "Channel";
export type LinkSource = "upload" | "description" | "message" | "manual";

export interface LinkRecord {
  url: string;
  workspaceId: string;
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
  joinedByPhone?: string;      // legacy: last phone to join
  joinedByPhones?: string[];   // per-phone tracking: all phones that joined this link
}

const COL = "Links_Repository";

async function col() {
  const db = await getDb();
  return db.collection<LinkRecord>(COL);
}

export const linksRepository = {
  async init(): Promise<void> {
    const c = await col();
    // Compound unique index: same URL can exist in different workspaces
    await c.createIndex({ workspaceId: 1, url: 1 }, { unique: true, background: true } as any);
    await c.createIndex({ workspaceId: 1, status: 1, type: 1 }, { background: true } as any);
    console.log("[LinksRepository] Indexes ready");
  },

  async addIfNew(
    workspaceId: string,
    url: string,
    type: LinkType,
    source: LinkSource,
    extra: Partial<Pick<LinkRecord, "name" | "members" | "description">> = {}
  ): Promise<boolean> {
    const c = await col();
    try {
      await c.insertOne({
        workspaceId,
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
      return false;
    }
  },

  async upsert(
    workspaceId: string,
    url: string,
    type: LinkType,
    source: LinkSource,
    extra: Partial<Pick<LinkRecord, "name" | "members" | "description">> = {}
  ): Promise<void> {
    const c = await col();
    await c.updateOne(
      { workspaceId, url },
      {
        $setOnInsert: { workspaceId, url, type, status: "Pending", source, addedAt: new Date(), checkCount: 0 },
        $set: { updatedAt: new Date(), ...extra },
        $inc: { checkCount: 0 },
      } as any,
      { upsert: true }
    );
  },

  async setStatus(workspaceId: string, url: string, status: LinkStatus, joinedByPhone?: string): Promise<void> {
    const c = await col();
    const setFields: Partial<LinkRecord> = { status, updatedAt: new Date() };
    if (status === "Joined") {
      setFields.joinedAt = new Date();
      if (joinedByPhone) setFields.joinedByPhone = joinedByPhone;
    }
    if (status === "Left") setFields.leftAt = new Date();

    const update: any = { $set: setFields };
    if (status === "Joined" && joinedByPhone) {
      // Track per-phone join history independently — addToSet never duplicates
      update.$addToSet = { joinedByPhones: joinedByPhone };
    }
    await c.updateOne({ workspaceId, url }, update);
  },

  async recordCheck(workspaceId: string, url: string, name?: string, members?: number, description?: string): Promise<void> {
    const c = await col();
    await c.updateOne(
      { workspaceId, url },
      {
        $inc: { checkCount: 1 },
        $set: {
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
          ...(name && { name }),
          ...(members && { members }),
          ...(description && { description }),
        },
      }
    );
  },

  async exists(workspaceId: string, url: string): Promise<boolean> {
    const c = await col();
    return !!(await c.findOne({ workspaceId, url }, { projection: { _id: 1 } }));
  },

  async findByStatus(workspaceId: string, status: LinkStatus): Promise<LinkRecord[]> {
    const c = await col();
    return c.find({ workspaceId, status }).toArray();
  },

  async findPendingForJoin(workspaceId: string, currentPhone?: string): Promise<LinkRecord[]> {
    const c = await col();
    if (currentPhone) {
      // Return links that this specific phone has NOT yet joined.
      // Uses the joinedByPhones array for accurate per-phone tracking.
      // Falls back to checking the legacy joinedByPhone field for old records.
      return c.find({
        workspaceId,
        $or: [
          { status: "Pending" },
          {
            status: "Joined",
            joinedByPhones: { $nin: [currentPhone] },
            joinedByPhone: { $ne: currentPhone },
          },
          {
            status: "Joined",
            joinedByPhones: { $exists: false },
            joinedByPhone: { $ne: currentPhone },
          },
        ],
      }).sort({ addedAt: 1 }).toArray();
    }
    return c.find({ workspaceId, status: "Pending" }).sort({ addedAt: 1 }).toArray();
  },

  async findJoined(workspaceId: string, currentPhone?: string): Promise<LinkRecord[]> {
    const c = await col();
    if (currentPhone) {
      // A link is "joined by this phone" if the phone is in joinedByPhones OR is the legacy joinedByPhone
      return c.find({
        workspaceId,
        status: "Joined",
        $or: [
          { joinedByPhones: currentPhone },
          { joinedByPhone: currentPhone, joinedByPhones: { $exists: false } },
        ],
      }).toArray();
    }
    return c.find({ workspaceId, status: "Joined" }).toArray();
  },

  /**
   * Reset only the CURRENT phone's own join records back to Pending.
   * This lets a phone restart its own join queue without disturbing other phones.
   * Previously this wiped ALL other phones' join data — that bug is now fixed.
   */
  async resetMyJoinProgress(workspaceId: string, currentPhone: string): Promise<number> {
    const c = await col();
    // Remove current phone from joinedByPhones array; if that empties the array, reset status to Pending
    const joined = await c.find({
      workspaceId,
      $or: [
        { joinedByPhones: currentPhone },
        { joinedByPhone: currentPhone, joinedByPhones: { $exists: false } },
      ],
    }, { projection: { url: 1, joinedByPhones: 1 } }).toArray();

    let resetCount = 0;
    for (const doc of joined) {
      const remaining = (doc.joinedByPhones ?? []).filter((p: string) => p !== currentPhone);
      if (remaining.length === 0) {
        // No other phone has joined this — safe to reset to Pending
        await c.updateOne(
          { workspaceId, url: doc.url },
          { $set: { status: "Pending" as LinkStatus, updatedAt: new Date() }, $unset: { joinedAt: "", joinedByPhone: "", joinedByPhones: "" } }
        );
      } else {
        // Other phones joined — just remove current phone from the array
        await c.updateOne(
          { workspaceId, url: doc.url },
          { $set: { updatedAt: new Date() }, $pull: { joinedByPhones: currentPhone } as any }
        );
      }
      resetCount++;
    }
    console.log(`[LinksRepository] Reset ${resetCount} of my join records (phone: ${currentPhone}, wid: ${workspaceId})`);
    return resetCount;
  },

  /** @deprecated Use resetMyJoinProgress — kept for backward compat */
  async resetJoinedByOtherPhone(workspaceId: string, currentPhone: string): Promise<number> {
    return this.resetMyJoinProgress(workspaceId, currentPhone);
  },

  async countByStatusForPhone(workspaceId: string, currentPhone?: string): Promise<Record<LinkStatus, number>> {
    const c = await col();
    const all = await c.aggregate([
      { $match: { workspaceId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray();
    const result: Record<string, number> = { Pending: 0, Joined: 0, Ignored: 0, Left: 0 };
    all.forEach((d: any) => { result[d._id] = d.count; });

    if (currentPhone) {
      // Count links this specific phone has joined (using joinedByPhones array)
      const joinedByMe = await c.countDocuments({
        workspaceId,
        status: "Joined",
        $or: [
          { joinedByPhones: currentPhone },
          { joinedByPhone: currentPhone, joinedByPhones: { $exists: false } },
        ],
      });
      // Links joined by the system but NOT by this phone are effectively Pending for this phone
      const joinedByOthers = result.Joined - joinedByMe;
      result.Joined = joinedByMe;
      result.Pending = result.Pending + Math.max(0, joinedByOthers);
    }

    return result as Record<LinkStatus, number>;
  },

  async getAllUrls(workspaceId: string): Promise<Set<string>> {
    const c = await col();
    const docs = await c.find({ workspaceId }, { projection: { url: 1 } }).toArray();
    return new Set(docs.map((d) => d.url));
  },

  async countByStatus(workspaceId: string): Promise<Record<LinkStatus, number>> {
    const c = await col();
    const agg = await c.aggregate([
      { $match: { workspaceId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray();
    const result: Record<string, number> = { Pending: 0, Joined: 0, Ignored: 0, Left: 0 };
    agg.forEach((d: any) => { result[d._id] = d.count; });
    return result as Record<LinkStatus, number>;
  },

  async saveFilteredLinks(
    workspaceId: string,
    groups: { link: string; name?: string; members?: number; description?: string }[],
    ads: { link: string; name?: string; members?: number; description?: string }[],
    descLinks?: string[]
  ): Promise<{ newGroups: number; newAds: number; newDescLinks: number }> {
    const c = await col();
    const now = new Date();

    const buildOp = (url: string, type: LinkType, source: LinkSource, extra: Partial<Pick<LinkRecord, "name" | "members" | "description">> = {}) => ({
      updateOne: {
        filter: { workspaceId, url },
        update: {
          $setOnInsert: { workspaceId, url, type, status: "Pending" as LinkStatus, source, addedAt: now, checkCount: 0 },
          $set: { updatedAt: now, ...extra },
        },
        upsert: true,
      },
    });

    const allOps = [
      ...groups.map(g => buildOp(g.link, "Group", "upload", { name: g.name, members: g.members, description: g.description })),
      ...ads.map(a => buildOp(a.link, "Group", "upload", { name: a.name, members: a.members, description: a.description })),
      ...(descLinks ?? [])
        .filter(url => url.includes("chat.whatsapp.com"))
        .map(url => buildOp(url, "Group", "description")),
    ];

    if (!allOps.length) return { newGroups: 0, newAds: 0, newDescLinks: 0 };

    const result = await c.bulkWrite(allOps, { ordered: false });
    const newGroups    = Math.min(result.upsertedCount, groups.length);
    const newAds       = Math.max(0, result.upsertedCount - newGroups);
    const newDescLinks = result.upsertedCount - newGroups - newAds;

    console.log(`[LinksRepository] Bulk saved (wid: ${workspaceId}) — upserted: ${result.upsertedCount}, modified: ${result.modifiedCount}`);
    return { newGroups, newAds, newDescLinks: Math.max(0, newDescLinks) };
  },

  /**
   * Sync groups fetched live from WhatsApp's groupFetchAllParticipating().
   * - Upserts each group by groupJid (updates name/members/desc if changed).
   * - Marks any DB "Joined" record whose JID is absent from WA as "Left"
   *   (handles groups the user left manually outside the app).
   */
  async syncFromWhatsAppGroups(
    workspaceId: string,
    waGroups: Array<{ id: string; subject?: string; participants?: Array<{ id: string }>; desc?: string; size?: number }>
  ): Promise<{ synced: number; markedLeft: number }> {
    const c = await col();
    const now = new Date();
    const activeJids = new Set(waGroups.map(g => g.id));

    const ops = waGroups.map(g => {
      const members = typeof g.size === "number" ? g.size : (g.participants?.length ?? undefined);
      return {
        updateOne: {
          filter: { workspaceId, groupJid: g.id },
          update: {
            $setOnInsert: {
              workspaceId,
              url: `https://chat.whatsapp.com/synced-${g.id}`,
              type: "Group" as LinkType,
              status: "Joined" as LinkStatus,
              source: "manual" as LinkSource,
              addedAt: now,
              checkCount: 0,
            },
            $set: {
              status: "Joined" as LinkStatus,
              name: g.subject ?? undefined,
              ...(members !== undefined ? { members } : {}),
              ...(g.desc ? { description: g.desc } : {}),
              updatedAt: now,
            },
          },
          upsert: true,
        },
      };
    });

    let synced = 0;
    if (ops.length) {
      const r = await c.bulkWrite(ops, { ordered: false });
      synced = r.upsertedCount + r.modifiedCount;
    }

    // Mark groups that WA no longer shows as Left
    const leftResult = await c.updateMany(
      {
        workspaceId,
        status: "Joined",
        groupJid: { $exists: true, $ne: null, $nin: [...activeJids] },
      },
      { $set: { status: "Left" as LinkStatus, leftAt: now, updatedAt: now } }
    );

    console.log(`[LinksRepository] WA sync (wid: ${workspaceId}) — synced: ${synced}, markedLeft: ${leftResult.modifiedCount}`);
    return { synced, markedLeft: leftResult.modifiedCount };
  },

  /** Mark a single group Left by JID (e.g. when voluntary leave detected via events). */
  async markLeftByJid(workspaceId: string, groupJid: string): Promise<void> {
    const c = await col();
    const result = await c.updateMany(
      { workspaceId, groupJid, status: { $in: ["Joined", "Pending"] } },
      { $set: { status: "Left" as LinkStatus, leftAt: new Date(), updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[LinksRepository] Marked Left (voluntary leave): ${groupJid} (wid: ${workspaceId})`);
    }
  },

  async getDailyTrend(workspaceId: string, days = 14): Promise<{ date: string; count: number }[]> {
    const c = await col();
    const since = new Date();
    since.setDate(since.getDate() - days);
    const agg = await c.aggregate([
      { $match: { workspaceId, addedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$addedAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    return agg.map((d: any) => ({ date: d._id as string, count: d.count as number }));
  },

  async countBySource(workspaceId: string): Promise<Record<string, number>> {
    const c = await col();
    const agg = await c.aggregate([
      { $match: { workspaceId } },
      { $group: { _id: "$source", count: { $sum: 1 } } },
    ]).toArray();
    const result: Record<string, number> = {};
    agg.forEach((d: any) => { result[d._id] = d.count; });
    return result;
  },

  async getRecent(workspaceId: string, limit = 15): Promise<LinkRecord[]> {
    const c = await col();
    return c.find({ workspaceId }).sort({ addedAt: -1 }).limit(limit).toArray();
  },

  async handleGroupRemoval(workspaceId: string, groupJid: string): Promise<void> {
    const c = await col();
    const result = await c.updateOne(
      { workspaceId, groupJid, status: { $in: ["Joined", "Pending"] } },
      { $set: { status: "Left" as LinkStatus, leftAt: new Date(), updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[LinksRepository] Marked as Left (kicked): ${groupJid} (wid: ${workspaceId})`);
    }
  },

  // ── Backward-compat helpers (no workspaceId, used by legacy link-store flow) ──

  /** @deprecated use countByStatus(workspaceId) */
  async countByStatusLegacy(): Promise<Record<LinkStatus, number>> {
    const c = await col();
    const agg = await c.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
    const result: Record<string, number> = { Pending: 0, Joined: 0, Ignored: 0, Left: 0 };
    agg.forEach((d: any) => { result[d._id] = d.count; });
    return result as Record<LinkStatus, number>;
  },
};
