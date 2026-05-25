/**
 * sleep-scheduler.ts — Daily sleep window management
 *
 * Sleep start time is configurable by the user (stored in MongoDB).
 * Duration is fixed at SLEEP_DURATION_HOURS (default 6h).
 * Call updateSleepConfigSync() after loading config from DB.
 */

import { getSleepConfigSync } from "./sleep-config.js";

const TZ = "Asia/Riyadh";

export interface SleepStatus {
  isSleeping:  boolean;
  sleepUntil?: Date;
  msUntilWake?: number;
  sleepStart?: string;
  sleepEnd?:   string;
}

function localHourMin(): { hours: number; mins: number } {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour:     "numeric",
    minute:   "numeric",
    hour12:   false,
  }).formatToParts(now);

  const hours = parseInt(parts.find((p) => p.type === "hour")?.value   ?? "0", 10);
  const mins  = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hours, mins: hours * 60 + mins };
}

function _getSleepWindow(): { startMins: number; endMins: number; crossesMidnight: boolean } {
  const cfg      = getSleepConfigSync();
  const startMins = cfg.startHour * 60 + cfg.startMin;
  const endMins   = startMins + cfg.durationHours * 60;
  const crossesMidnight = endMins >= 24 * 60;
  return { startMins, endMins: crossesMidnight ? endMins - 24 * 60 : endMins, crossesMidnight };
}

export function isSleepTime(): boolean {
  const { mins }                                 = localHourMin();
  const { startMins, endMins, crossesMidnight }  = _getSleepWindow();
  if (crossesMidnight) {
    return mins >= startMins || mins < endMins;
  }
  return mins >= startMins && mins < endMins;
}

export function msUntilWakeUp(): number {
  if (!isSleepTime()) return 0;

  const cfg      = getSleepConfigSync();
  const endMins  = (cfg.startHour * 60 + cfg.startMin + cfg.durationHours * 60) % (24 * 60);
  const wakeHour = Math.floor(endMins / 60);
  const wakeMin  = endMins % 60;

  const TIMEZONE_OFFSET_HOURS = 3;
  const nowLocal  = Date.now() + TIMEZONE_OFFSET_HOURS * 3_600_000;
  const dLocal    = new Date(nowLocal);
  const wakeLocal = new Date(nowLocal);
  wakeLocal.setUTCHours(wakeHour, wakeMin, 0, 0);
  if (wakeLocal.getTime() <= dLocal.getTime()) {
    wakeLocal.setUTCDate(wakeLocal.getUTCDate() + 1);
  }
  return wakeLocal.getTime() - dLocal.getTime();
}

export function getSleepStatus(): SleepStatus {
  const cfg     = getSleepConfigSync();
  const endMins = (cfg.startHour * 60 + cfg.startMin + cfg.durationHours * 60) % (24 * 60);
  const wakeHour = Math.floor(endMins / 60);
  const wakeMin  = endMins % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  const sleepStart = `${pad(cfg.startHour)}:${pad(cfg.startMin)}`;
  const sleepEnd   = `${pad(wakeHour)}:${pad(wakeMin)}`;

  if (!isSleepTime()) return { isSleeping: false, sleepStart, sleepEnd };
  const ms = msUntilWakeUp();
  return { isSleeping: true, sleepUntil: new Date(Date.now() + ms), msUntilWake: ms, sleepStart, sleepEnd };
}
