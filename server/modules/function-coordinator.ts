/**
 * function-coordinator.ts — Function isolation / mutex
 *
 * Two-track design:
 *  • Heavy track (_active): joining / leaving / publishing / checking — mutual exclusion,
 *    blocked during the join-window, emit "released" when done.
 *  • Reading track (_readingActive): message-reading runs INDEPENDENTLY and is NEVER
 *    blocked or preempted. It does not hold the heavy lock and does not block heavy
 *    functions from starting.
 *
 * The user's requirement: قراءة الرسائل يجب أن تعمل بشكل مستمر في أي وقت وفي أي حالة.
 */

import { EventEmitter } from "events";

export type BotFunction = "checking" | "joining" | "reading" | "publishing" | "leaving";

export interface FunctionState {
  active: BotFunction | null;
  startedAt: Date | null;
  joinWindowActive: boolean;
  queuedRequests: BotFunction[];
}

class FunctionCoordinator extends EventEmitter {
  private _active:          BotFunction | null = null;
  private _startedAt:       Date        | null = null;
  private _joinWindowActive             = false;
  /** Reading runs on its own track — never blocks / never gets blocked. */
  private _readingActive                = false;

  /**
   * Returns the currently active function.
   * Heavy functions take priority in the display; reading shown only when nothing else runs.
   */
  getActive(): BotFunction | null {
    return this._active ?? (this._readingActive ? "reading" : null);
  }

  /** True when a heavy function (not reading) is running. */
  isRunning(): boolean { return this._active !== null; }

  /** True while the join-manager is executing a join slot. */
  isJoinWindowActive(): boolean { return this._joinWindowActive; }

  /** Called by join-manager to raise / lower the join-window flag. */
  setWindowActive(active: boolean): void {
    this._joinWindowActive = active;
    if (active) {
      console.log("[Coordinator] 🔒 Join window OPEN — heavy functions blocked");
    } else {
      console.log("[Coordinator] 🔓 Join window CLOSED");
    }
  }

  /**
   * Acquire the coordinator for a given function.
   *
   * "reading" → uses the independent reading track; always succeeds unless reading is
   *             already running. Never blocked by join window or heavy functions.
   *
   * Others   → heavy track; blocked when another heavy function is active or during a
   *             join window (except "joining" itself).
   */
  async acquire(fn: BotFunction): Promise<boolean> {
    // ── Reading: independent track ──────────────────────────────────────────────
    if (fn === "reading") {
      if (this._readingActive) return false; // already reading
      this._readingActive = true;
      // No log needed — reading is background / continuous
      return true;
    }

    // ── Heavy functions ─────────────────────────────────────────────────────────
    if (this._joinWindowActive && fn !== "joining") {
      console.warn(
        `[Coordinator] ⛔ Cannot start "${fn}" — join window is active.`
      );
      return false;
    }

    if (this._active !== null) {
      console.warn(`[Coordinator] Cannot start "${fn}" — "${this._active}" is already running`);
      return false;
    }

    this._active    = fn;
    this._startedAt = new Date();
    console.log(`[Coordinator] Started "${fn}"`);
    return true;
  }

  /**
   * Release the coordinator.
   *
   * Smart dispatch:
   *  • If _active is set  → release the heavy function.
   *  • Else if _readingActive → release reading.
   *
   * Pass fn="reading" to force release of the reading track even when a heavy
   * function is also active (used only from message-reader internal code).
   */
  release(fn?: "reading"): void {
    if (fn === "reading" || (this._active === null && this._readingActive)) {
      // Release the reading track
      this._readingActive = false;
      return;
    }
    // Release the heavy track
    if (this._active) {
      console.log(`[Coordinator] Released "${this._active}" (ran for ${this._elapsedSec()}s)`);
    }
    this._active          = null;
    this._startedAt       = null;
    this._joinWindowActive = false;
    this.emit("released");
  }

  getState(): FunctionState {
    return {
      active:           this._active ?? (this._readingActive ? "reading" : null),
      startedAt:        this._startedAt,
      joinWindowActive: this._joinWindowActive,
      queuedRequests:   [],
    };
  }

  private _elapsedSec(): number {
    if (!this._startedAt) return 0;
    return Math.round((Date.now() - this._startedAt.getTime()) / 1000);
  }
}

export const coordinator = new FunctionCoordinator();

// ── Per-workspace factory ─────────────────────────────────────────────────────
export { FunctionCoordinator };

const _instances = new Map<string, FunctionCoordinator>();
export function getCoordinatorFor(workspaceId: string): FunctionCoordinator {
  if (!_instances.has(workspaceId)) {
    _instances.set(workspaceId, new FunctionCoordinator());
  }
  return _instances.get(workspaceId)!;
}
