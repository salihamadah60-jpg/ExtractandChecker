/**
 * excluded-groups.ts — Groups excluded from publishing (per-workspace)
 */
import { getDb } from "../mongo-auth-state.js";

export interface ExcludedGroup {
  _id?: string;
  workspaceId: string;
  url:         string;
  name?:       string;
  addedAt:     Date;
}

const COL = "ExcludedGroups";

async function col() {
  const db = await getDb();
  return db.collection<ExcludedGroup>(COL);
}

export const excludedGroups = {
  async init(): Promise<void> {
    const c = await col();
    await c.createIndex({ workspaceId: 1, url: 1 }, { unique: true, background: true } as any);
  },

  async add(workspaceId: string, url: string, name?: string): Promise<boolean> {
    const c = await col();
    try {
      await c.insertOne({ workspaceId, url, name, addedAt: new Date() } as ExcludedGroup);
      return true;
    } catch {
      return false;
    }
  },

  async remove(workspaceId: string, url: string): Promise<void> {
    const c = await col();
    await c.deleteOne({ workspaceId, url });
  },

  async list(workspaceId: string): Promise<ExcludedGroup[]> {
    const c = await col();
    return c.find({ workspaceId }).sort({ addedAt: -1 }).toArray() as unknown as ExcludedGroup[];
  },

  async getUrlSet(workspaceId: string): Promise<Set<string>> {
    const list = await this.list(workspaceId);
    return new Set(list.map(e => e.url));
  },
};
