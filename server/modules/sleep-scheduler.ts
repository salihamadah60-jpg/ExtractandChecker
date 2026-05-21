/**
 * sleep-scheduler.ts — Daily sleep window management
 *
 * Enforces a nightly sleep period (01:30 – 07:30 local time) to mimic
 * human inactivity and reset WhatsApp activity counters.
 */

const SLEEP_START_HOUR = 1;
const SLEEP_START_MIN  = 30;
const WAKE_HOUR        = 7;
const WAKE_MIN         = 30;

/** Timezone used for sleep window calculations — Yemen / Gulf (UTC+3) */
const TZ = "Asia/Riyadh";

export interface SleepStatus {
  isSleeping: boolean;
  sleepUntil?: Date;
  msUntilWake?: number;
}

/** Returns current local hour & total minutes since midnight in the configured timezone. */
function localHourMin(): { hours: number; mins: number } {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour:   "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const hours = parseInt(parts.find((p) => p.type === "hour")?.value   ?? "0", 10);
  const mins  = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hours, mins: hours * 60 + mins };
}

/** Returns true if the current local time is inside the sleep window (01:30 – 07:30) */
export function isSleepTime(): boolean {
  const { mins } = localHourMin();
  const start    = SLEEP_START_HOUR * 60 + SLEEP_START_MIN; // 90
  const wake     = WAKE_HOUR        * 60 + WAKE_MIN;        // 450
  // The window 01:30–07:30 does NOT cross midnight → simple AND check
  return mins >= start && mins < wake;
}

/** Milliseconds until 07:30 local (UTC+3). Returns 0 when not sleeping. */
export function msUntilWakeUp(): number {
  if (!isSleepTime()) return 0;
  const TIMEZONE_OFFSET_HOURS = 3;
  const nowLocal = Date.now() + TIMEZONE_OFFSET_HOURS * 3_600_000;
  const dLocal   = new Date(nowLocal);

  // Build wake time in UTC+3 then convert back to UTC ms
  const wakeLocal = new Date(nowLocal);
  wakeLocal.setUTCHours(WAKE_HOUR, WAKE_MIN, 0, 0);
  if (wakeLocal.getTime() <= dLocal.getTime()) {
    wakeLocal.setUTCDate(wakeLocal.getUTCDate() + 1);
  }
  // The difference is timezone-independent
  return wakeLocal.getTime() - dLocal.getTime();
}

export function getSleepStatus(): SleepStatus {
  if (!isSleepTime()) return { isSleeping: false };
  const ms = msUntilWakeUp();
  return { isSleeping: true, sleepUntil: new Date(Date.now() + ms), msUntilWake: ms };
}
