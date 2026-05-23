/**
 * telemetry.ts — WhatsApp latency sensing & predictive cooldown
 *
 * Monitors join/send response times to predict WhatsApp rate-limiting
 * BEFORE it happens. Triggers proactive cooldowns based on trends.
 *
 * Strategy:
 *   - Spike (single response > 8 s)  → 8-minute emergency backoff
 *   - Trend (rolling avg > 3 s)       → 2-minute predictive cooldown
 */

const WINDOW_SIZE           = 5;           // rolling window of last N samples
const SLOW_THRESHOLD_MS     = 3_000;       // avg above this = slow trend
const SPIKE_THRESHOLD_MS    = 8_000;       // single sample above this = spike
const PREDICTIVE_COOLDOWN_MS = 2 * 60_000; // 2 min on slow trend
const EMERGENCY_COOLDOWN_MS  = 8 * 60_000; // 8 min on spike
const MAX_WINDOW_HISTORY    = 30;          // keep last 30 join windows

export interface TelemetryReport {
  avgLatencyMs: number;
  lastLatencyMs: number;
  sampleCount: number;
  cooldownActive: boolean;
  cooldownUntil?: Date;
  warning?: string;
}

export interface WindowRecord {
  windowNumber: number;
  slotsExecuted: number;
  joined: number;
  failed: number;
  ignored: number;
  startedAt: string;   // ISO
  completedAt: string; // ISO
  durationMs: number;
  avgLatencyMs: number;
  hadCooldown: boolean;
}

class TelemetrySensor {
  private _latencies: number[] = [];
  private _cooldownUntil = 0;
  private _lastWarning?: string;
  private _windowHistory: WindowRecord[] = [];

  /** Record a completed operation's round-trip time in milliseconds */
  record(latencyMs: number): void {
    this._latencies.push(latencyMs);
    if (this._latencies.length > WINDOW_SIZE) this._latencies.shift();

    const avg    = this._avg();
    const latest = latencyMs;

    if (latest > SPIKE_THRESHOLD_MS) {
      const until = Date.now() + EMERGENCY_COOLDOWN_MS;
      this._cooldownUntil = Math.max(this._cooldownUntil, until);
      this._lastWarning = `⚠️ استجابة بطيئة جداً (${(latest / 1000).toFixed(1)}ث) — توقف وقائي ${Math.round(EMERGENCY_COOLDOWN_MS / 60_000)} دقيقة`;
      console.warn(`[Telemetry] SPIKE ${latest}ms → emergency ${Math.round(EMERGENCY_COOLDOWN_MS / 60_000)}min`);
    } else if (this._latencies.length >= 3 && avg > SLOW_THRESHOLD_MS) {
      const until = Date.now() + PREDICTIVE_COOLDOWN_MS;
      this._cooldownUntil = Math.max(this._cooldownUntil, until);
      this._lastWarning = `⚡ تباطؤ متراكم (متوسط ${(avg / 1000).toFixed(1)}ث) — تبريد وقائي ${Math.round(PREDICTIVE_COOLDOWN_MS / 60_000)} دقيقة`;
      console.warn(`[Telemetry] SLOW TREND avg=${Math.round(avg)}ms → predictive ${Math.round(PREDICTIVE_COOLDOWN_MS / 60_000)}min`);
    }
  }

  /** Remaining cooldown in ms (0 when not cooling down) */
  cooldownRemaining(): number {
    return Math.max(0, this._cooldownUntil - Date.now());
  }

  isCoolingDown(): boolean {
    return this.cooldownRemaining() > 0;
  }

  /** Force an emergency cooldown from outside (e.g. after a WA error) */
  triggerEmergency(reason: string, durationMs = EMERGENCY_COOLDOWN_MS): void {
    const until = Date.now() + durationMs;
    this._cooldownUntil = Math.max(this._cooldownUntil, until);
    this._lastWarning   = `🚨 ${reason}`;
    console.warn(`[Telemetry] Emergency: ${reason} — ${Math.round(durationMs / 60_000)}min`);
  }

  getReport(): TelemetryReport {
    return {
      avgLatencyMs:   Math.round(this._avg()),
      lastLatencyMs:  this._latencies[this._latencies.length - 1] ?? 0,
      sampleCount:    this._latencies.length,
      cooldownActive: this.isCoolingDown(),
      cooldownUntil:  this.isCoolingDown() ? new Date(this._cooldownUntil) : undefined,
      warning:        this._lastWarning,
    };
  }

  /** Record a completed join window's stats for history display */
  recordWindow(rec: WindowRecord): void {
    this._windowHistory.push(rec);
    if (this._windowHistory.length > MAX_WINDOW_HISTORY) {
      this._windowHistory.shift();
    }
  }

  /** Returns a copy of the last N window records (newest last) */
  getWindowHistory(): WindowRecord[] {
    return [...this._windowHistory];
  }

  reset(): void {
    this._latencies     = [];
    this._cooldownUntil = 0;
    this._lastWarning   = undefined;
    this._windowHistory = [];
  }

  private _avg(): number {
    if (!this._latencies.length) return 0;
    return this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length;
  }
}

export const telemetry = new TelemetrySensor();

// ── Per-workspace factory ─────────────────────────────────────────────────────
export { TelemetrySensor };

const _instances = new Map<string, TelemetrySensor>();
export function getTelemetryFor(workspaceId: string): TelemetrySensor {
  if (!_instances.has(workspaceId)) {
    _instances.set(workspaceId, new TelemetrySensor());
  }
  return _instances.get(workspaceId)!;
}
