/**
 * human-mimicry.ts — Randomized delays and human-like pacing
 * All bot actions use these utilities to avoid detection.
 * NO fixed timings — everything is within a human-plausible range.
 */

/**
 * Sleep for a random duration between [minMs, maxMs] milliseconds.
 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gaussian-like jitter — clusters around the midpoint, rarely hits extremes.
 */
function gaussianDelay(minMs: number, maxMs: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const std = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const mid = (minMs + maxMs) / 2;
  const range = (maxMs - minMs) / 6;
  return Math.max(minMs, Math.min(maxMs, Math.round(mid + std * range)));
}

export function gaussianRandomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, gaussianDelay(minMs, maxMs)));
}

/**
 * Predefined delay profiles for different actions.
 * All intervals are human-plausible ranges, never fixed.
 */
export const DELAYS = {
  /** Between sequential link checks: 2–5 seconds */
  betweenChecks: () => randomDelay(2000, 5000),

  /** Between sequential group joins: 3–8 seconds */
  betweenJoins: () => gaussianRandomDelay(3000, 8000),

  /** Rest pause after every ~25–35 joins: 60–120 seconds */
  batchRestAfterJoins: () => randomDelay(60_000, 120_000),

  /** Between messages sent to a group: 8–25 seconds */
  betweenPublishedMessages: () => gaussianRandomDelay(8000, 25_000),

  /** Between reading a group's messages: 2–6 seconds */
  betweenGroupReads: () => randomDelay(2000, 6000),

  /** Rest pause after every ~20–30 messages read: 30–60 seconds */
  batchRestAfterReads: () => randomDelay(30_000, 60_000),

  /** Simulated typing time before sending a message: 500ms–3s */
  typingBeforeSend: () => gaussianRandomDelay(500, 3000),

  /** Short pause before leaving a group: 5–15 seconds */
  beforeLeave: () => randomDelay(5000, 15_000),
} as const;

/**
 * Returns a random integer between min and max (inclusive).
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pick a random item from an array.
 */
export function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Shuffle an array in-place (Fisher-Yates).
 */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Returns true with the given probability (0–1).
 */
export function withChance(probability: number): boolean {
  return Math.random() < probability;
}
