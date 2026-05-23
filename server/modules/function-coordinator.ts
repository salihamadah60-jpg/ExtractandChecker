/**
 * function-coordinator.ts — Function isolation / mutex
 *
 * Ensures only ONE heavy WhatsApp function runs at a time.
 * During an active join window, ALL other functions are strictly blocked.
 * Emits "released" event when the lock is freed — used by message-reader
 * to auto-resume continuous reading.
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

  getActive(): BotFunction | null { return this._active; }

  isRunning(): boolean { return this._active !== null; }

  /** True while the join-manager is executing a join slot (strict 10-min window) */
  isJoinWindowActive(): boolean { return this._joinWindowActive; }

  /** Called by join-manager to raise / lower the join-window flag */
  setWindowActive(active: boolean): void {
    this._joinWindowActive = active;
    if (active) {
      console.log("[Coordinator] 🔒 Join window OPEN — all other functions blocked");
    } else {
      console.log("[Coordinator] 🔓 Join window CLOSED");
    }
  }

  /**
   * Try to acquire the lock for a given function.
   * Returns true if acquired, false if another function is already running
   * OR if a join window is currently active.
   */
  async acquire(fn: BotFunction): Promise<boolean> {
    if (this._joinWindowActive && fn !== "joining") {
      console.warn(
        `[Coordinator] ⛔ Cannot start "${fn}" — join window is active. ` +
        `WhatsApp sees all outgoing requests; parallel calls are forbidden.`
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

  /** Release the lock. Always call in a finally block. */
  release(): void {
    if (this._active) {
      console.log(`[Coordinator] Released "${this._active}" (ran for ${this._elapsedSec()}s)`);
    }
    this._active          = null;
    this._startedAt       = null;
    this._joinWindowActive = false;
    // Notify listeners (e.g. message-reader continuous mode)
    this.emit("released");
  }

  getState(): FunctionState {
    return {
      active:           this._active,
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
