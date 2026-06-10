/**
 * join-config.ts — Persistent join-rate configuration stored in MongoDB.
 * Users can set how many links are joined per 10-minute window (2–8).
 */
import { getDb } from "../mongo-auth-state.js";

const COL = "GlobalConfig";
const KEY = "join_config";

export interface JoinConfig {
  slotsPerWindow: number;
}

const DEFAULT: JoinConfig = { slotsPerWindow: 4 };

let _cached: JoinConfig | null = null;
let _syncConfig: JoinConfig = { ...DEFAULT };

export async function getJoinConfig(): Promise<JoinConfig> {
  if (_cached) return { ..._cached };
  try {
    const db  = await getDb();
    const doc = await db.collection(COL).findOne({ key: KEY }) as any;
    _cached   = doc ? { slotsPerWindow: doc.slotsPerWindow ?? 4 } : { ...DEFAULT };
    return { ..._cached };
  } catch {
    return { ...DEFAULT };
  }
}

export async function setJoinConfig(cfg: Partial<JoinConfig>): Promise<JoinConfig> {
  const current = await getJoinConfig();
  const updated  = { ...current, ...cfg };
  // Clamp to safe range 2–8
  updated.slotsPerWindow = Math.max(2, Math.min(8, updated.slotsPerWindow));
  try {
    const db = await getDb();
    await db.collection(COL).updateOne(
      { key: KEY },
      { $set: { key: KEY, ...updated, updatedAt: new Date() } },
      { upsert: true }
    );
    _cached = updated;
    updateJoinConfigSync(updated);
  } catch (err) {
    console.warn("[JoinConfig] Failed to persist:", (err as Error).message);
  }
  return { ...updated };
}

export function getJoinConfigSync(): JoinConfig { return { ..._syncConfig }; }
export function updateJoinConfigSync(cfg: JoinConfig): void { _syncConfig = { ...cfg }; }
