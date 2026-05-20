/**
 * publish-history.ts — Persistent log of every completed publish session.
 *
 * Saves to MongoDB collection `publish_history`.
 * Each document represents one complete (or stopped/failed) publish run.
 */

import { getDb } from "../mongo-auth-state.js";

export interface PublishSession {
  _id?:        string;
  startedAt:   string;
  completedAt: string;
  status:      "done" | "stopped" | "error";
  total:       number;
  processed:   number;
  sent:        number;
  failed:      number;
  phone?:      string;
}

const COL = "publish_history";

async function col() {
  const db = await getDb();
  return db.collection<PublishSession>(COL);
}

export const publishHistory = {
  async save(session: Omit<PublishSession, "_id">): Promise<void> {
    try {
      const c = await col();
      await c.insertOne(session as any);
    } catch (err) {
      console.error("[PublishHistory] Failed to save session:", err);
    }
  },

  async list(limit = 20): Promise<PublishSession[]> {
    const c    = await col();
    const docs = await c
      .find({})
      .sort({ completedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(d => ({ ...d, _id: d._id?.toString() })) as PublishSession[];
  },
};
