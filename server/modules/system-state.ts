/**
 * system-state.ts — MongoDB System_State collection (per-workspace)
 *
 * Each workspace has its own state document.
 * All methods accept workspaceId as the first parameter.
 */

import { getDb } from "../mongo-auth-state.js";
import type { BotFunction } from "./function-coordinator.js";

export interface SystemStateDoc {
  _id: string;
  is_running: boolean;
  active_function: BotFunction | null;
  last_read_message_id?: string;
  last_published_ad_index?: number;
  reader_continuous?: boolean;
  reader_total_messages?: number;
  reader_total_links_found?: number;
  reader_total_links_new?: number;
  last_updated: Date;
  extra?: Record<string, unknown>;
}

const COL = "System_State";

async function col() {
  const db = await getDb();
  return db.collection<SystemStateDoc>(COL);
}

function _empty(workspaceId: string): SystemStateDoc {
  return {
    _id: workspaceId,
    is_running: false,
    active_function: null,
    last_updated: new Date(),
  };
}

export const systemState = {
  /** Initialize workspace doc if it doesn't exist. */
  async init(workspaceId = "main"): Promise<void> {
    const c = await col();
    const exists = await c.findOne({ _id: workspaceId as any });
    if (!exists) {
      await c.insertOne(_empty(workspaceId) as any);
    }
    console.log(`[SystemState] Ready (workspace: ${workspaceId})`);
  },

  async get(workspaceId = "main"): Promise<SystemStateDoc> {
    const c = await col();
    const doc = await c.findOne({ _id: workspaceId as any });
    return (doc as unknown as SystemStateDoc) ?? _empty(workspaceId);
  },

  async update(workspaceId = "main", patch: Partial<Omit<SystemStateDoc, "_id">>): Promise<void> {
    const c = await col();
    await c.updateOne(
      { _id: workspaceId as any },
      { $set: { ...patch, last_updated: new Date() } },
      { upsert: true }
    );
  },

  async setActiveFunction(workspaceId = "main", fn: BotFunction | null): Promise<void> {
    await systemState.update(workspaceId, { active_function: fn, is_running: fn !== null });
  },

  async setLastReadMessageId(workspaceId = "main", id: string): Promise<void> {
    await systemState.update(workspaceId, { last_read_message_id: id });
  },

  async advanceAdIndex(workspaceId = "main", total: number): Promise<number> {
    const current = await systemState.get(workspaceId);
    const next = ((current.last_published_ad_index ?? -1) + 1) % total;
    await systemState.update(workspaceId, { last_published_ad_index: next });
    return next;
  },

  /**
   * Merge arbitrary function-specific state into the extra field.
   * Uses $set with dot-notation keys to avoid overwriting unrelated keys.
   */
  async setExtra(workspaceId = "main", data: Record<string, unknown>): Promise<void> {
    const c = await col();
    const dotSet: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      dotSet[`extra.${k}`] = v;
    }
    dotSet["last_updated"] = new Date();
    await c.updateOne(
      { _id: workspaceId as any },
      { $set: dotSet },
      { upsert: true }
    );
  },

  async setReaderContinuous(workspaceId = "main", enabled: boolean): Promise<void> {
    await systemState.update(workspaceId, { reader_continuous: enabled });
  },

  async getReaderContinuous(workspaceId = "main"): Promise<boolean> {
    const state = await systemState.get(workspaceId);
    return state.reader_continuous ?? false;
  },

  /** Load accumulated reader totals from MongoDB (called on reader start). */
  async getReaderTotals(workspaceId = "main"): Promise<{ messages: number; linksFound: number; linksNew: number }> {
    const state = await systemState.get(workspaceId);
    return {
      messages:   state.reader_total_messages    ?? 0,
      linksFound: state.reader_total_links_found ?? 0,
      linksNew:   state.reader_total_links_new   ?? 0,
    };
  },

  /** Atomically increment reader counters (batched — called every ~50 messages). */
  async incrementReaderCounters(
    workspaceId = "main",
    delta: { messages: number; linksFound: number; linksNew: number }
  ): Promise<void> {
    const c = await col();
    await c.updateOne(
      { _id: workspaceId as any },
      {
        $inc: {
          reader_total_messages:    delta.messages,
          reader_total_links_found: delta.linksFound,
          reader_total_links_new:   delta.linksNew,
        },
        $set: { last_updated: new Date() },
      },
      { upsert: true }
    );
  },

  async checkRecovery(workspaceId = "main"): Promise<BotFunction | null> {
    const state = await systemState.get(workspaceId);
    if (state.is_running && state.active_function) {
      console.warn(`[SystemState] Recovery (${workspaceId}): "${state.active_function}" was interrupted — resetting`);
      await systemState.setActiveFunction(workspaceId, null);
      return state.active_function;
    }
    return null;
  },
};
