/**
 * central-links.ts — Global central links repository
 *
 * All active (valid) WhatsApp groups discovered by any workspace are stored
 * here, deduplicated by URL. Admins use this collection to join groups.
 */

import { getDb } from "../mongo-auth-state.js";
import { randomUUID } from "crypto";

export interface CentralLinkDoc {
  _id: string;
  url: string;
  name?: string;
  members?: number;
  description?: string;
  workspaceId?: string;
  category: "group" | "ad";
  addedAt: Date;
}

const COL = "CentralLinks";

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
  } catch {
    return url.toLowerCase().trim();
  }
}

async function col() {
  const db = await getDb();
  return db.collection<CentralLinkDoc>(COL);
}

export const centralLinksStore = {
  async init(): Promise<void> {
    const c = await col();
    await (c.createIndex as any)({ url: 1 }, { unique: true, background: true });
    await (c.createIndex as any)({ addedAt: -1 }, { background: true });
    await (c.createIndex as any)({ members: -1 }, { background: true });
    await (c.createIndex as any)({ category: 1 }, { background: true });
    console.log("[CentralLinksStore] Ready");
  },

  async addBatch(links: Array<{
    url: string;
    name?: string;
    members?: number;
    description?: string;
    workspaceId?: string;
    category: "group" | "ad";
  }>): Promise<{ added: number; duplicates: number }> {
    if (!links.length) return { added: 0, duplicates: 0 };
    const c = await col();
    let added = 0;
    let duplicates = 0;

    for (const link of links) {
      const normUrl = normalizeUrl(link.url);
      try {
        const existing = await c.findOne({ url: normUrl });
        if (existing) {
          // Update with better data if available
          if (link.name || link.members !== undefined) {
            await (c.updateOne as any)({ url: normUrl }, {
              $set: {
                ...(link.name ? { name: link.name } : {}),
                ...(link.members !== undefined ? { members: link.members } : {}),
                ...(link.description ? { description: link.description } : {}),
              },
            });
          }
          duplicates++;
        } else {
          const doc: CentralLinkDoc = {
            _id: randomUUID(),
            url: normUrl,
            name: link.name,
            members: link.members,
            description: link.description,
            workspaceId: link.workspaceId,
            category: link.category,
            addedAt: new Date(),
          };
          await (c.insertOne as any)(doc);
          added++;
        }
      } catch (err: any) {
        if (err.code === 11000) duplicates++;
        else console.warn("[CentralLinks] Insert error:", err.message);
      }
    }
    return { added, duplicates };
  },

  async list(opts: {
    skip?: number;
    limit?: number;
    search?: string;
    minMembers?: number;
    category?: "group" | "ad" | "";
  } = {}): Promise<{ docs: CentralLinkDoc[]; total: number }> {
    const c = await col();
    const filter: any = {};
    if (opts.search?.trim()) {
      const re = new RegExp(opts.search.trim(), "i");
      filter.$or = [{ url: re }, { name: re }, { description: re }];
    }
    if (opts.minMembers !== undefined && opts.minMembers > 0) {
      filter.members = { $gte: opts.minMembers };
    }
    if (opts.category) {
      filter.category = opts.category;
    }
    const total = await c.countDocuments(filter);
    const docs = await c
      .find(filter)
      .sort({ members: -1, addedAt: -1 })
      .skip(opts.skip ?? 0)
      .limit(opts.limit ?? 50)
      .toArray() as CentralLinkDoc[];
    return { docs, total };
  },

  async count(): Promise<{ total: number; groups: number; ads: number }> {
    const c = await col();
    const total = await c.countDocuments();
    const groups = await c.countDocuments({ category: "group" });
    const ads = await c.countDocuments({ category: "ad" });
    return { total, groups, ads };
  },

  async getAllUrls(): Promise<string[]> {
    const c = await col();
    const docs = await c.find({}, { projection: { url: 1 } }).toArray();
    return docs.map((d: any) => d.url);
  },
};
