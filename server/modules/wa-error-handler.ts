/**
 * wa-error-handler.ts — Comprehensive WhatsApp error classification
 *
 * Every Baileys error goes through here. Returns an action and explanation.
 * This is the SINGLE place where we decide how to react to any WA error.
 *
 * Actions:
 *   skip           — This link is dead/revoked. Mark Ignored and continue.
 *   already_member — We're already in this group. Mark Joined and continue.
 *   community      — This is a community invite, not a plain group. Handle separately.
 *   wait_and_retry — Rate-limited. Wait backoff ms then retry same link.
 *   retry          — Transient error. Retry after short delay (max 3 times).
 *   stop_join      — WhatsApp blocked join action. Stop joining, wait long.
 *   stop_all       — ACCOUNT UNDER THREAT. Halt ALL functions immediately.
 */

export type WAErrorAction =
  | "skip"
  | "already_member"
  | "community"
  | "wait_and_retry"
  | "retry"
  | "stop_join"
  | "stop_all";

export interface WAErrorResult {
  action: WAErrorAction;
  reason: string;
  waitMs?: number;   // for wait_and_retry
  critical: boolean; // true = log prominently + notify UI
}

// ── Patterns that map message → action ────────────────────────────────────────

const SKIP_PATTERNS: RegExp[] = [
  /item-not-found/i,
  /not-found/i,
  /gone/i,
  /bad-request/i,
  /bad request/i,
  /invalid/i,
  /expired/i,
  /forbidden/i,
  /not-authorized/i,
  /not authorized/i,
  /link.*(revoked|expired|invalid)/i,
  /group.*(deleted|closed|not exist)/i,
  /invite.*invalid/i,
  /join-denied/i,
  /group full/i,
  /group-full/i,
  /admin.*denied/i,
  /غير صالح|منتهي|لا توجد/i,
];

const ALREADY_MEMBER_PATTERNS: RegExp[] = [
  /already.*member/i,
  /already.*participant/i,
  /conflict/i,
  /409/,
  /already joined/i,
  /member already/i,
];

const COMMUNITY_PATTERNS: RegExp[] = [
  /community/i,
  /parent.*group/i,
  /linked.*group/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?overlimit/i,
  /rate.?limit/i,
  /too.?many/i,
  /429/,
  /slow.?down/i,
  /flood/i,
];

// WhatsApp showing "unable to join" repeatedly = account under pressure
const STOP_JOIN_PATTERNS: RegExp[] = [
  /unable.*access.*group/i,
  /unable.*join/i,
  /cannot.*join/i,
  /resource.?limit/i,
  /421/,
  /resource limit/i,
  /reached.*limit/i,
  /limit.*reached/i,
  /joining.*restricted/i,
  /group.*unavailable/i,
];

// These mean the ACCOUNT itself is at risk — stop everything now
const STOP_ALL_PATTERNS: RegExp[] = [
  /account.*block/i,
  /account.*suspend/i,
  /account.*banned/i,
  /temporarily.*block/i,
  /blocked.*account/i,
  /your.*account.*restrict/i,
  /action.*block/i,
  /spam.*detect/i,
  /401/,
  /account.*locked/i,
];

// ── Main classifier ────────────────────────────────────────────────────────────

export function classifyWAError(
  err: unknown,
  consecutiveFailures: number = 0
): WAErrorResult {
  const raw = (err as any)?.message ?? String(err);
  const msg = raw.toLowerCase();
  const statusCode = (err as any)?.output?.statusCode ??
    (err as any)?.statusCode ??
    parseInt(raw.match(/\b(\d{3})\b/)?.[1] ?? "0", 10);

  // ── STOP ALL — account threatening ─────────────────────────────────────────
  if (
    STOP_ALL_PATTERNS.some((p) => p.test(msg)) ||
    statusCode === 401 ||
    consecutiveFailures >= 10  // 10+ consecutive failures = something is very wrong
  ) {
    return {
      action: "stop_all",
      reason: `⚠️ حساب تحت التهديد: ${raw}`,
      critical: true,
    };
  }

  // ── STOP JOIN — WA is blocking joining specifically ─────────────────────────
  if (STOP_JOIN_PATTERNS.some((p) => p.test(msg)) || statusCode === 421) {
    const waitMs = 15 * 60 * 1000; // 15 minutes
    return {
      action: "stop_join",
      reason: `⛔ WhatsApp يمنع الانضمام: ${raw}`,
      waitMs,
      critical: true,
    };
  }

  // ── RATE LIMIT ──────────────────────────────────────────────────────────────
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(msg)) || statusCode === 429) {
    // Exponential backoff: 1min → 2min → 4min → 8min → 15min
    const waitMs = Math.min(15 * 60_000, 60_000 * Math.pow(2, Math.max(0, consecutiveFailures - 1)));
    return {
      action: "wait_and_retry",
      reason: `⏳ تجاوز حد المعدل — انتظار ${Math.round(waitMs / 1000)}ث`,
      waitMs,
      critical: false,
    };
  }

  // ── ALREADY MEMBER ──────────────────────────────────────────────────────────
  if (ALREADY_MEMBER_PATTERNS.some((p) => p.test(msg)) || statusCode === 409) {
    return {
      action: "already_member",
      reason: "أنت بالفعل عضو في هذه المجموعة",
      critical: false,
    };
  }

  // ── COMMUNITY ──────────────────────────────────────────────────────────────
  if (COMMUNITY_PATTERNS.some((p) => p.test(msg))) {
    return {
      action: "community",
      reason: "هذا مجتمع وليس مجموعة عادية",
      critical: false,
    };
  }

  // ── SKIP — dead/revoked link ────────────────────────────────────────────────
  if (SKIP_PATTERNS.some((p) => p.test(msg)) || statusCode === 403 || statusCode === 404 || statusCode === 410) {
    return {
      action: "skip",
      reason: `رابط منتهٍ أو غير صالح: ${raw}`,
      critical: false,
    };
  }

  // ── RETRY — transient / unknown ─────────────────────────────────────────────
  if (statusCode === 408 || statusCode === 500 || statusCode === 503 || msg.includes("timeout") || msg.includes("timed out")) {
    return {
      action: "retry",
      reason: `خطأ مؤقت — إعادة المحاولة: ${raw}`,
      critical: false,
    };
  }

  // ── DEFAULT — skip unknown errors after enough failures ────────────────────
  if (consecutiveFailures >= 5) {
    return {
      action: "stop_join",
      reason: `${consecutiveFailures} فشل متتالي — إيقاف مؤقت: ${raw}`,
      waitMs: 5 * 60_000,
      critical: true,
    };
  }

  return {
    action: "skip",
    reason: `خطأ غير معروف — تخطي: ${raw}`,
    critical: false,
  };
}
