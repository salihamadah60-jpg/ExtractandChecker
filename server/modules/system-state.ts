/**
 * system-state.ts — MongoDB System_State collection
 *
 * Stores the current bot state so that if Replit restarts,
 * the bot can resume from exactly where it left off.
 *
 * Fields:
 *  - is_running: whether any function is currently active
 *  - active_function: which function is running
 *  - last_read_message_id: last message processed by the reader
 *  - last_published_ad_index: rotation index for ad publishing
 *  - extra: arbitrary JSON for function-specific state (merged, never replaced)
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
  last_updated: Date;
  extra?: Record<string, unknown>;
}

const COL = "System_State";
const DOC_ID = "main";

async function col() {
  const db = await getDb();
  return db.collection<SystemStateDoc>(COL);
}

export const systemState = {
  /** Initialize the singleton document if it doesn't exist. */
  async init(): Promise<void> {
    const c = await col();
    const exists = await c.findOne({ _id: DOC_ID as any });
    if (!exists) {
      await c.insertOne({
        _id: DOC_ID as any,
        is_running: false,
        active_function: null,
        last_updated: new Date(),
      } as SystemStateDoc);
    }
    console.log("[SystemState] Ready");
  },

  /** Get the current state. */
  async get(): Promise<SystemStateDoc> {
    const c = await col();
    const doc = await c.findOne({ _id: DOC_ID as any });
    return doc ?? {
      _id: DOC_ID,
      is_running: false,
      active_function: null,
      last_updated: new Date(),
    };
  },

  /** Patch the state document. */
  async update(patch: Partial<Omit<SystemStateDoc, "_id">>): Promise<void> {
    const c = await col();
    await c.updateOne(
      { _id: DOC_ID as any },
      { $set: { ...patch, last_updated: new Date() } },
      { upsert: true }
    );
  },

  /** Set active function and is_running flag atomically. */
  async setActiveFunction(fn: BotFunction | null): Promise<void> {
    await systemState.update({ active_function: fn, is_running: fn !== null });
  },

  /** Save last processed message ID (for resumable reading). */
  async setLastReadMessageId(id: string): Promise<void> {
    await systemState.update({ last_read_message_id: id });
  },

  /** Advance the ad rotation index and return the new value. */
  async advanceAdIndex(total: number): Promise<number> {
    const current = await systemState.get();
    const next = ((current.last_published_ad_index ?? -1) + 1) % total;
    await systemState.update({ last_published_ad_index: next });
    return next;
  },

  /**
   * Merge arbitrary function-specific state into the extra field.
   * Uses $set with dot-notation keys to avoid overwriting unrelated keys.
   */
  async setExtra(data: Record<string, unknown>): Promise<void> {
    const c = await col();
    const dotSet: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      dotSet[`extra.${k}`] = v;
    }
    dotSet["last_updated"] = new Date();
    await c.updateOne(
      { _id: DOC_ID as any },
      { $set: dotSet },
      { upsert: true }
    );
  },

  /** Save whether the reader should run continuously (persists across restarts). */
  async setReaderContinuous(enabled: boolean): Promise<void> {
    await systemState.update({ reader_continuous: enabled });
  },

  /** Get whether the reader was set to continuous mode. */
  async getReaderContinuous(): Promise<boolean> {
    const state = await systemState.get();
    return state.reader_continuous ?? false;
  },

  /**
   * Check on startup whether a function was interrupted.
   * Returns the interrupted function name if recovery is needed.
   */
  async checkRecovery(): Promise<BotFunction | null> {
    const state = await systemState.get();
    if (state.is_running && state.active_function) {
      console.warn(`[SystemState] Recovery: "${state.active_function}" was interrupted — resetting`);
      await systemState.setActiveFunction(null);
      return state.active_function;
    }
    return null;
  },
};
