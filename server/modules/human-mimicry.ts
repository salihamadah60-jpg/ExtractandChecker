/**
 * human-mimicry.ts — Randomized delays and human-like pacing
 *
 * All bot actions use these utilities to avoid detection.
 * NO fixed timings — everything is within a human-plausible range.
 *
 * JOIN TIMING MODEL (anti-ban):
 *   Window = 10 minutes.  2 links processed per window.
 *   Slot 0 → random offset within  0:30 – 4:30  (first half)
 *   Slot 1 → random offset within  5:00 – 9:30  (second half)
 *   Coordinator lock is held for the ENTIRE window so no other
 *   WhatsApp function can fire simultaneously.
 */

export const WINDOW_DURATION_MS  = 10 * 60_000;  // 10 minutes per window
export const SLOTS_PER_WINDOW    = 4;             // 4 joins per window
export const SLOT_PERIOD_MS      = WINDOW_DURATION_MS / SLOTS_PER_WINDOW; // 150 s each
export const MIN_SEPARATION_MS   = 55_000;         // absolute minimum gap between consecutive joins

/** Sleep for a random duration between [minMs, maxMs] */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gaussian-like jitter — clusters around midpoint, rarely hits extremes */
function gaussianDelay(minMs: number, maxMs: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const std   = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const mid   = (minMs + maxMs) / 2;
  const range = (maxMs - minMs) / 6;
  return Math.max(minMs, Math.min(maxMs, Math.round(mid + std * range)));
}

export function gaussianRandomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, gaussianDelay(minMs, maxMs)));
}

/**
 * Compute randomised offsets for N join slots within a 10-minute window.
 *
 * Each slot owns an equal period of (WINDOW_DURATION_MS / slots).
 * Anti-clustering safeguard: consecutive slots are kept at least
 * MIN_SEPARATION_MS (55 s) apart.
 *
 * @param slots Number of joins per window (2–8, default SLOTS_PER_WINDOW)
 */
export function computeSlotOffsets(slots: number = SLOTS_PER_WINDOW): number[] {
  const n = Math.max(2, Math.min(8, Math.round(slots)));
  const P = Math.floor(WINDOW_DURATION_MS / n); // period per slot in ms

  const offsets: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = i * P;
    const hi = Math.min((i + 1) * P - 1, WINDOW_DURATION_MS - 1);
    offsets.push(randomInt(lo, hi));
  }

  // Enforce minimum separation between consecutive slots
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] - offsets[i - 1] < MIN_SEPARATION_MS) {
      const ceiling = Math.min(((i + 1) * P) - 1, WINDOW_DURATION_MS - 1);
      offsets[i] = Math.min(
        offsets[i - 1] + MIN_SEPARATION_MS + randomInt(0, 12_000),
        ceiling,
      );
    }
  }

  return offsets;
}

/** @deprecated Use computeSlotOffsets() instead — kept for backward compat */
export function computeSlotOffsets4(): [number, number, number, number] {
  const r = computeSlotOffsets(4);
  return [r[0], r[1], r[2], r[3]];
}

/** @deprecated Use computeSlotOffsets() instead */
export function joinSlotOffset(slot: 0 | 1): number {
  if (slot === 0) return randomInt(30_000, 270_000);
  return randomInt(300_000, 570_000);
}

/** Predefined delay profiles for different actions */
export const DELAYS = {
  /** Between sequential link checks: 2–5 seconds */
  betweenChecks: () => randomDelay(2000, 5000),

  /**
   * NOT used for the main join loop (which uses the window scheduler).
   * Kept for pipeline / fallback paths: 45–90 seconds.
   */
  betweenJoins: () => randomDelay(45_000, 90_000),

  /** Rest pause after every ~25–35 joins: 3–6 minutes */
  batchRestAfterJoins: () => randomDelay(180_000, 360_000),

  /** Between messages sent to a group: 8–25 seconds */
  betweenPublishedMessages: () => gaussianRandomDelay(8000, 25_000),

  /** Between reading a group's messages: 2–6 seconds */
  betweenGroupReads: () => randomDelay(2000, 6000),

  /** Rest pause after every ~20–30 messages read: 30–60 seconds */
  batchRestAfterReads: () => randomDelay(30_000, 60_000),

  /** Simulated typing time before sending a message: 1–4 seconds */
  typingBeforeSend: () => gaussianRandomDelay(1000, 4000),

  /** Short pause before leaving a group: 5–15 seconds */
  beforeLeave: () => randomDelay(5000, 15_000),
} as const;

/** Returns a random integer between min and max (inclusive) */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick a random item from an array */
export function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Shuffle an array in-place (Fisher-Yates) */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Returns true with the given probability (0–1) */
export function withChance(probability: number): boolean {
  return Math.random() < probability;
}
