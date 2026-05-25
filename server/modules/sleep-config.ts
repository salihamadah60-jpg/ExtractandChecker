/**
 * sleep-config.ts — Persistent sleep window configuration stored in MongoDB.
 * Users can set the sleep start time; duration is fixed at SLEEP_DURATION_HOURS.
 */
import { getDb } from "../mongo-auth-state.js";

const COL = "GlobalConfig";
const KEY = "sleep_config";
export const SLEEP_DURATION_HOURS = 6;

export interface SleepConfig {
  startHour:     number;
  startMin:      number;
  durationHours: number;
}

const DEFAULT: SleepConfig = { startHour: 1, startMin: 30, durationHours: SLEEP_DURATION_HOURS };

let _cached: SleepConfig | null = null;

export async function getSleepConfig(): Promise<SleepConfig> {
  if (_cached) return { ..._cached };
  try {
    const db  = await getDb();
    const doc = await db.collection(COL).findOne({ key: KEY }) as any;
    _cached   = doc
      ? { startHour: doc.startHour ?? 1, startMin: doc.startMin ?? 30, durationHours: doc.durationHours ?? SLEEP_DURATION_HOURS }
      : { ...DEFAULT };
    return { ..._cached };
  } catch {
    return { ...DEFAULT };
  }
}

export async function setSleepConfig(cfg: Partial<SleepConfig>): Promise<SleepConfig> {
  const current = await getSleepConfig();
  const updated  = { ...current, ...cfg };
  try {
    const db = await getDb();
    await db.collection(COL).updateOne(
      { key: KEY },
      { $set: { key: KEY, ...updated, updatedAt: new Date() } },
      { upsert: true }
    );
    _cached = updated;
    updateSleepConfigSync(updated);
  } catch (err) {
    console.warn("[SleepConfig] Failed to persist:", (err as Error).message);
  }
  return { ...updated };
}

// Synchronous cache used by sleep-scheduler.ts (which is called synchronously)
let _syncConfig: SleepConfig = { ...DEFAULT };

export function getSleepConfigSync(): SleepConfig { return { ..._syncConfig }; }
export function updateSleepConfigSync(cfg: SleepConfig): void { _syncConfig = { ...cfg }; }
