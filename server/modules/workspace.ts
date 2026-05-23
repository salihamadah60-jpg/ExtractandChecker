/**
 * workspace.ts — Multi-tenant workspace management
 *
 * Each workspace is an isolated context identified by a UUID.
 * Clients authenticate via X-Workspace-Key header (a second UUID).
 * All data (links, state, ads, queue) is scoped to a workspaceId.
 */

import { getDb } from "../mongo-auth-state.js";
import { randomUUID } from "crypto";

export interface WorkspaceDoc {
  _id: string;
  name: string;
  accessKey: string;
  createdAt: Date;
  activeSessionId?: string;
}

const COL = "Workspaces";

async function col() {
  const db = await getDb();
  return db.collection<WorkspaceDoc>(COL);
}

export const workspaceStore = {
  async init(): Promise<void> {
    const c = await col();
    await c.createIndex({ accessKey: 1 }, { unique: true, background: true } as any);
    console.log("[WorkspaceStore] Ready");
  },

  async create(name: string): Promise<WorkspaceDoc> {
    const c = await col();
    const doc: WorkspaceDoc = {
      _id: randomUUID(),
      name: name.trim() || "مساحة عمل جديدة",
      accessKey: randomUUID(),
      createdAt: new Date(),
    };
    await c.insertOne(doc as any);
    return doc;
  },

  async findByKey(accessKey: string): Promise<WorkspaceDoc | null> {
    const c = await col();
    return c.findOne({ accessKey }) as Promise<WorkspaceDoc | null>;
  },

  async findById(id: string): Promise<WorkspaceDoc | null> {
    const c = await col();
    return c.findOne({ _id: id as any }) as Promise<WorkspaceDoc | null>;
  },

  async list(): Promise<WorkspaceDoc[]> {
    const c = await col();
    return c.find({}).sort({ createdAt: 1 }).toArray() as Promise<WorkspaceDoc[]>;
  },

  async rename(id: string, name: string): Promise<void> {
    const c = await col();
    await c.updateOne({ _id: id as any }, { $set: { name } });
  },

  async setActiveSession(workspaceId: string, sessionId: string | null): Promise<void> {
    const c = await col();
    await c.updateOne(
      { _id: workspaceId as any },
      { $set: { activeSessionId: sessionId ?? null } },
      { upsert: false }
    );
  },

  async delete(id: string): Promise<void> {
    const c = await col();
    await c.deleteOne({ _id: id as any });
  },
};
