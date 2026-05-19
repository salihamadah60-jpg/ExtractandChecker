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

export interface SleepStatus {
  isSleeping: boolean;
  sleepUntil?: Date;
  msUntilWake?: number;
}

/** Returns true if the current local time is inside the sleep window */
export function isSleepTime(): boolean {
  const now   = new Date();
  const mins  = now.getHours() * 60 + now.getMinutes();
  const start = SLEEP_START_HOUR * 60 + SLEEP_START_MIN;
  const wake  = WAKE_HOUR        * 60 + WAKE_MIN;
  return mins >= start || mins < wake;
}

/** Milliseconds until 07:30. Returns 0 when not sleeping. */
export function msUntilWakeUp(): number {
  if (!isSleepTime()) return 0;
  const now  = new Date();
  const wake = new Date(now);
  wake.setHours(WAKE_HOUR, WAKE_MIN, 0, 0);
  if (wake <= now) wake.setDate(wake.getDate() + 1);
  return wake.getTime() - now.getTime();
}

export function getSleepStatus(): SleepStatus {
  if (!isSleepTime()) return { isSleeping: false };
  const ms = msUntilWakeUp();
  return { isSleeping: true, sleepUntil: new Date(Date.now() + ms), msUntilWake: ms };
}
