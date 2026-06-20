/**
 * threat-monitor.ts — Per-workspace WhatsApp account safety tracker
 *
 * Tracks all events that signal WhatsApp is flagging the account for spam/abuse,
 * computes a live threat level, and takes automatic protective actions.
 * Also tracks daily join counts against safe thresholds.
 *
 * Threat Levels:
 *   LOW      — safe, normal operation
 *   MEDIUM   — caution, reduce speed (1+ rate limit OR 3+ kicks)
 *   HIGH     — danger, auto-pause 30 min (2+ rate limits OR 2+ stop-joins OR 5+ kicks)
 *   CRITICAL — emergency, auto-stop 4 hours (3+ rate limits OR 3+ stop-joins OR stop_all fired)
 *
 * Daily Safe Thresholds (WhatsApp community research):
 *   GREEN:  0–25 joins/day  → safe zone
 *   YELLOW: 26–40 joins/day → caution zone
 *   RED:    41–55 joins/day → danger zone → hard stop at 55
 */

export type ThreatLevel = "low" | "medium" | "high" | "critical";

export interface ThreatEvent {
  type:     "rate_limit" | "stop_join" | "kick" | "stop_all" | "network_drop";
  at:       string;
  details?: string;
}

export interface ThreatStatus {
  level:                  ThreatLevel;
  events:                 ThreatEvent[];
  rateLimitCount:         number;
  stopJoinCount:          number;
  kickCount:              number;
  consecutiveNetworkFail: number;
  dailyJoins:             number;
  sessionJoins:           number;
  dailyGreen:             number;
  dailyYellow:            number;
  dailyRed:               number;
  safetyModeActive:       boolean;
  safetyModeUntil?:       string;
}

export const DAILY_GREEN_LIMIT  = 25;
export const DAILY_YELLOW_LIMIT = 40;
export const DAILY_RED_LIMIT    = 55;

const THRESHOLDS = {
  medium:   { rateLimits: 1, kicks: 3 },
  high:     { rateLimits: 2, stopJoins: 2, kicks: 5 },
  critical: { rateLimits: 3, stopJoins: 3 },
};

interface WorkspaceState {
  events:                 ThreatEvent[];
  rateLimitCount:         number;
  stopJoinCount:          number;
  kickCount:              number;
  consecutiveNetworkFail: number;
  safetyModeActive:       boolean;
  safetyModeUntil?:       Date;
  sessionJoins:           number;
  dailyJoins:             number;
  dailyDate:              string;
}

function todayKey(): string {
  return new Date().toISOString().split("T")[0];
}

function fresh(): WorkspaceState {
  return {
    events: [],
    rateLimitCount: 0,
    stopJoinCount: 0,
    kickCount: 0,
    consecutiveNetworkFail: 0,
    safetyModeActive: false,
    safetyModeUntil: undefined,
    sessionJoins: 0,
    dailyJoins: 0,
    dailyDate: todayKey(),
  };
}

const _state = new Map<string, WorkspaceState>();

function _ws(wid: string): WorkspaceState {
  if (!_state.has(wid)) _state.set(wid, fresh());
  const ws = _state.get(wid)!;
  const today = todayKey();
  if (ws.dailyDate !== today) {
    ws.dailyDate  = today;
    ws.dailyJoins = 0;
    console.log(`[ThreatMonitor:${wid}] 🌅 New day — daily counter reset`);
  }
  return ws;
}

function _level(ws: WorkspaceState): ThreatLevel {
  if (ws.safetyModeActive && ws.safetyModeUntil && ws.safetyModeUntil > new Date()) {
    const natural = _naturalLevel(ws);
    return natural === "low" || natural === "medium" ? "high" : natural;
  }
  return _naturalLevel(ws);
}

function _naturalLevel(ws: WorkspaceState): ThreatLevel {
  if (
    ws.rateLimitCount >= THRESHOLDS.critical.rateLimits ||
    ws.stopJoinCount  >= THRESHOLDS.critical.stopJoins
  ) return "critical";
  if (
    ws.rateLimitCount >= THRESHOLDS.high.rateLimits ||
    ws.stopJoinCount  >= THRESHOLDS.high.stopJoins ||
    ws.kickCount      >= THRESHOLDS.high.kicks
  ) return "high";
  if (
    ws.rateLimitCount >= THRESHOLDS.medium.rateLimits ||
    ws.kickCount      >= THRESHOLDS.medium.kicks
  ) return "medium";
  return "low";
}

function _push(ws: WorkspaceState, evt: ThreatEvent): void {
  ws.events.push(evt);
  if (ws.events.length > 100) ws.events = ws.events.slice(-100);
}

export const threatMonitor = {

  recordRateLimit(wid: string, details?: string): ThreatLevel {
    const ws = _ws(wid);
    ws.rateLimitCount++;
    ws.consecutiveNetworkFail = 0;
    _push(ws, { type: "rate_limit", at: new Date().toISOString(), details });
    const lv = _level(ws);
    console.log(`[ThreatMonitor:${wid}] 🚦 RateLimit #${ws.rateLimitCount} → ${lv.toUpperCase()}`);
    return lv;
  },

  recordStopJoin(wid: string, details?: string): ThreatLevel {
    const ws = _ws(wid);
    ws.stopJoinCount++;
    _push(ws, { type: "stop_join", at: new Date().toISOString(), details });
    const lv = _level(ws);
    console.log(`[ThreatMonitor:${wid}] ⛔ StopJoin #${ws.stopJoinCount} → ${lv.toUpperCase()}`);
    return lv;
  },

  recordKick(wid: string, details?: string): ThreatLevel {
    const ws = _ws(wid);
    ws.kickCount++;
    _push(ws, { type: "kick", at: new Date().toISOString(), details });
    const lv = _level(ws);
    console.log(`[ThreatMonitor:${wid}] 👢 Kick #${ws.kickCount} → ${lv.toUpperCase()}`);
    return lv;
  },

  recordStopAll(wid: string, details?: string): ThreatLevel {
    const ws = _ws(wid);
    _push(ws, { type: "stop_all", at: new Date().toISOString(), details });
    console.log(`[ThreatMonitor:${wid}] 🆘 StopAll → CRITICAL`);
    return "critical";
  },

  recordNetworkDrop(wid: string): void {
    const ws = _ws(wid);
    ws.consecutiveNetworkFail++;
    if (ws.consecutiveNetworkFail >= 5) {
      _push(ws, { type: "network_drop", at: new Date().toISOString(), details: `${ws.consecutiveNetworkFail} consecutive drops` });
      console.log(`[ThreatMonitor:${wid}] 📡 ${ws.consecutiveNetworkFail} consecutive network drops`);
    }
  },

  recordSuccessfulJoin(wid: string): void {
    const ws = _ws(wid);
    ws.consecutiveNetworkFail = 0;
    ws.sessionJoins++;
    ws.dailyJoins++;
  },

  resetSession(wid: string): void {
    const ws = _ws(wid);
    ws.rateLimitCount         = 0;
    ws.stopJoinCount          = 0;
    ws.kickCount              = 0;
    ws.consecutiveNetworkFail = 0;
    ws.sessionJoins           = 0;
    ws.events                 = [];
    console.log(`[ThreatMonitor:${wid}] 🔄 Session reset (daily count preserved: ${ws.dailyJoins})`);
  },

  activateSafetyMode(wid: string, durationMs = 30 * 60_000): void {
    const ws = _ws(wid);
    ws.safetyModeActive = true;
    ws.safetyModeUntil  = new Date(Date.now() + durationMs);
    console.log(`[ThreatMonitor:${wid}] 🛡 Safety mode ON — ${Math.round(durationMs / 60_000)} min`);
  },

  deactivateSafetyMode(wid: string): void {
    const ws = _ws(wid);
    ws.safetyModeActive = false;
    ws.safetyModeUntil  = undefined;
    console.log(`[ThreatMonitor:${wid}] ✅ Safety mode OFF`);
  },

  getLevel(wid: string): ThreatLevel {
    return _level(_ws(wid));
  },

  getStatus(wid: string): ThreatStatus {
    const ws = _ws(wid);
    return {
      level:                  _level(ws),
      events:                 [...ws.events].reverse(),
      rateLimitCount:         ws.rateLimitCount,
      stopJoinCount:          ws.stopJoinCount,
      kickCount:              ws.kickCount,
      consecutiveNetworkFail: ws.consecutiveNetworkFail,
      dailyJoins:             ws.dailyJoins,
      sessionJoins:           ws.sessionJoins,
      dailyGreen:             DAILY_GREEN_LIMIT,
      dailyYellow:            DAILY_YELLOW_LIMIT,
      dailyRed:               DAILY_RED_LIMIT,
      safetyModeActive:       ws.safetyModeActive,
      safetyModeUntil:        ws.safetyModeUntil?.toISOString(),
    };
  },

  isDailyLimitReached(wid: string): boolean {
    return _ws(wid).dailyJoins >= DAILY_RED_LIMIT;
  },
};
