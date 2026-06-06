/**
 * publish-scheduler.ts — Recurring publish schedule manager (per-workspace)
 *
 * Stores schedules in MongoDB and fires the publisher automatically
 * when nextRunAt is reached. Tick runs every 5 seconds.
 */

import { getDb } from "../mongo-auth-state.js";
import { getPublisherFor } from "./publisher.js";
import { randomUUID } from "crypto";

export type IntervalUnit = "seconds" | "minutes" | "hours" | "days" | "weeks";

export interface PublishSchedule {
  _id: string;
  workspaceId: string;
  name: string;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
  createdAt: Date;
}

const COL = "Publish_Schedules";
const TICK_MS = 5_000;
const MIN_INTERVAL_MS = 30_000;

const UNIT_MS: Record<IntervalUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours:   3_600_000,
  days:    86_400_000,
  weeks:   604_800_000,
};

function toMs(value: number, unit: IntervalUnit): number {
  return value * UNIT_MS[unit];
}

async function col() {
  const db = await getDb();
  return db.collection<PublishSchedule>(COL);
}

let _tickInterval: ReturnType<typeof setInterval> | null = null;

export const publishScheduler = {
  async init(): Promise<void> {
    try {
      const c = await col();
      await (c as any).createIndex({ workspaceId: 1, enabled: 1, nextRunAt: 1 });
      console.log("[PublishScheduler] Ready");
    } catch (err: any) {
      console.warn("[PublishScheduler] Init warning:", err.message);
    }
    this._startTick();
  },

  async list(workspaceId: string): Promise<PublishSchedule[]> {
    const c = await col();
    return (c as any).find({ workspaceId }).sort({ createdAt: 1 }).toArray() as Promise<PublishSchedule[]>;
  },

  async create(
    workspaceId: string,
    name: string,
    intervalValue: number,
    intervalUnit: IntervalUnit
  ): Promise<PublishSchedule> {
    const intervalMs = toMs(intervalValue, intervalUnit);
    if (intervalMs < MIN_INTERVAL_MS) {
      throw new Error("الحد الأدنى للتكرار هو 30 ثانية");
    }
    const c = await col();
    const now = new Date();
    const doc: PublishSchedule = {
      _id: randomUUID(),
      workspaceId,
      name: name.trim() || "جدول جديد",
      intervalValue,
      intervalUnit,
      enabled: true,
      nextRunAt: new Date(Date.now() + intervalMs),
      createdAt: now,
    };
    await (c as any).insertOne(doc);
    console.log(`[PublishScheduler] Created schedule "${doc.name}" every ${intervalValue} ${intervalUnit} for workspace ${workspaceId}`);
    return doc;
  },

  async update(
    id: string,
    workspaceId: string,
    fields: Partial<Pick<PublishSchedule, "name" | "intervalValue" | "intervalUnit">>
  ): Promise<void> {
    const c = await col();
    const doc = await (c as any).findOne({ _id: id, workspaceId }) as PublishSchedule | null;
    if (!doc) throw new Error("الجدول غير موجود");

    const iv = fields.intervalValue ?? doc.intervalValue;
    const iu = fields.intervalUnit ?? doc.intervalUnit;
    const intervalMs = toMs(iv, iu);
    if (intervalMs < MIN_INTERVAL_MS) throw new Error("الحد الأدنى للتكرار هو 30 ثانية");

    const $set: any = {
      nextRunAt: new Date(Date.now() + intervalMs),
    };
    if (fields.name !== undefined) $set.name = fields.name.trim() || doc.name;
    if (fields.intervalValue !== undefined) $set.intervalValue = fields.intervalValue;
    if (fields.intervalUnit !== undefined) $set.intervalUnit = fields.intervalUnit;

    await (c as any).updateOne({ _id: id, workspaceId }, { $set });
  },

  async toggle(id: string, workspaceId: string): Promise<boolean> {
    const c = await col();
    const doc = await (c as any).findOne({ _id: id, workspaceId }) as PublishSchedule | null;
    if (!doc) throw new Error("الجدول غير موجود");
    const newEnabled = !doc.enabled;
    const $set: any = { enabled: newEnabled };
    if (newEnabled) {
      $set.nextRunAt = new Date(Date.now() + toMs(doc.intervalValue, doc.intervalUnit));
    }
    await (c as any).updateOne({ _id: id, workspaceId }, { $set });
    console.log(`[PublishScheduler] Schedule "${doc.name}" ${newEnabled ? "enabled" : "disabled"}`);
    return newEnabled;
  },

  async delete(id: string, workspaceId: string): Promise<void> {
    const c = await col();
    await (c as any).deleteOne({ _id: id, workspaceId });
    console.log(`[PublishScheduler] Deleted schedule ${id}`);
  },

  _startTick(): void {
    if (_tickInterval) return;
    _tickInterval = setInterval(async () => {
      try {
        const c = await col();
        const now = new Date();
        const due = await (c as any).find({
          enabled: true,
          nextRunAt: { $lte: now },
        }).toArray() as PublishSchedule[];

        for (const schedule of due) {
          const intervalMs = toMs(schedule.intervalValue, schedule.intervalUnit);
          const nextRunAt = new Date(Date.now() + intervalMs);

          await (c as any).updateOne(
            { _id: schedule._id },
            { $set: { lastRunAt: now, nextRunAt } }
          );

          console.log(`[PublishScheduler] ⏰ Firing "${schedule.name}" for workspace ${schedule.workspaceId}`);
          getPublisherFor(schedule.workspaceId).start().catch((err: Error) => {
            console.warn(`[PublishScheduler] Publisher error for "${schedule.name}":`, err.message);
          });
        }
      } catch (err: any) {
        console.warn("[PublishScheduler] Tick error:", err.message);
      }
    }, TICK_MS);
  },
};
