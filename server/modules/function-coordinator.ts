/**
 * function-coordinator.ts — Function isolation / mutex
 *
 * Ensures only ONE heavy WhatsApp function runs at a time.
 * If one is running, others are blocked until it completes.
 * This reduces the risk of WhatsApp detecting automation.
 *
 * Functions: checking, joining, reading, publishing, leaving
 */

export type BotFunction = "checking" | "joining" | "reading" | "publishing" | "leaving";

export interface FunctionState {
  active: BotFunction | null;
  startedAt: Date | null;
  queuedRequests: BotFunction[];
}

class FunctionCoordinator {
  private _active: BotFunction | null = null;
  private _startedAt: Date | null = null;

  /** Returns the currently running function, or null if idle. */
  getActive(): BotFunction | null {
    return this._active;
  }

  /** Returns true if any function is currently running. */
  isRunning(): boolean {
    return this._active !== null;
  }

  /**
   * Try to acquire the lock for a given function.
   * Returns true if acquired, false if another function is already running.
   */
  async acquire(fn: BotFunction): Promise<boolean> {
    if (this._active !== null) {
      console.warn(`[Coordinator] Cannot start "${fn}" — "${this._active}" is already running`);
      return false;
    }
    this._active = fn;
    this._startedAt = new Date();
    console.log(`[Coordinator] Started "${fn}"`);
    return true;
  }

  /**
   * Release the lock. Should always be called in a finally block.
   */
  release(): void {
    if (this._active) {
      console.log(`[Coordinator] Released "${this._active}" (ran for ${this._elapsedSec()}s)`);
    }
    this._active = null;
    this._startedAt = null;
  }

  /** Returns the current state snapshot. */
  getState(): FunctionState {
    return {
      active: this._active,
      startedAt: this._startedAt,
      queuedRequests: [],
    };
  }

  private _elapsedSec(): number {
    if (!this._startedAt) return 0;
    return Math.round((Date.now() - this._startedAt.getTime()) / 1000);
  }
}

export const coordinator = new FunctionCoordinator();
