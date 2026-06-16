/**
 * wa-error-handler.ts — Comprehensive WhatsApp error classification
 *
 * Every Baileys groupAcceptInvite error goes through here.
 * Returns an action and explanation.
 *
 * Real Baileys / WhatsApp stanza error codes (Boom wrappers):
 *   400 bad-request       — invalid / malformed invite code
 *   401 not-authorized    — account kicked/banned from this specific group
 *   403 forbidden         — group full, admin-restricted, or link revoked
 *   404 item-not-found    — group or invite does not exist
 *   405 not-allowed       — action not permitted (group locked, etc.)
 *   406 not-acceptable    — join request ALREADY SENT and awaiting admin approval
 *   408 timeout           — request timed out (transient)
 *   409 conflict          — account is already a member
 *   410 gone              — group deleted or link permanently expired
 *   421 resource-limit    — WhatsApp is blocking joining specifically
 *   429 rate-overlimit    — too many requests in a short window
 *   500/503               — WhatsApp server error (transient)
 *
 * Actions:
 *   skip                    — Dead/revoked link. Mark Ignored and move on.
 *   already_member          — Already in the group. Mark Joined and move on.
 *   pending_approval        — Join REQUEST already submitted; awaiting admin.
 *                             Mark PendingApproval and do NOT retry — the
 *                             group-participants.update watcher handles approval.
 *   community               — Community invite, not a plain group.
 *   wait_and_retry          — Rate-limited. Back off then retry same link.
 *   retry                   — True transient/network error. Up to 3 retries.
 *   stop_join               — WA blocking joins specifically. Pause joining.
 *   stop_all                — ACCOUNT UNDER THREAT. Halt ALL functions now.
 *   kicked                  — Account removed/banned from this group; link valid.
 */

export type WAErrorAction =
  | "skip"
  | "kicked"
  | "already_member"
  | "pending_approval"
  | "community"
  | "wait_and_retry"
  | "retry"
  | "stop_join"
  | "stop_all";

export interface WAErrorResult {
  action:   WAErrorAction;
  reason:   string;
  waitMs?:  number;
  critical: boolean;
}

// ── Pattern tables ─────────────────────────────────────────────────────────────

/**
 * True low-level OS/network errors — the WhatsApp server was never reached.
 * These are the ONLY errors that justify a "Network hiccup" retry message.
 * Must NOT be confused with WhatsApp application-level errors.
 */
const NETWORK_ERROR_PATTERNS: RegExp[] = [
  /ETIMEDOUT/,     /ECONNRESET/,   /ECONNREFUSED/,
  /ENOTFOUND/,     /ENETUNREACH/,  /EHOSTUNREACH/,
  /ECONNABORTED/,  /ENETDOWN/,     /EPIPE/,
  /socket hang up/i,
  /connection.*reset/i,
  /connection.*refused/i,
  /getaddrinfo ENOTFOUND/i,
  /connect ETIMEDOUT/i,
  /read ECONNRESET/i,
  /write ECONNRESET/i,
  /socket closed/i,
  /websocket.*close/i,
];

/**
 * 406 not-acceptable — WhatsApp confirmed the invite code is valid but a
 * join REQUEST for this account is ALREADY PENDING admin approval.
 * Retrying is pointless and will just spam the group admin.
 */
const PENDING_APPROVAL_PATTERNS: RegExp[] = [
  /not-acceptable/i,
  /not_acceptable/i,
  /request.*pending/i,
  /already.*pending/i,
  /pending.*approval/i,
  /waiting.*approval/i,
  /approval.*required/i,
];

/**
 * 401 / not-authorized — account was kicked or banned from THIS group.
 * The invite link is still valid. Mark kickedFromGroup, not Ignored.
 */
const KICKED_PATTERNS: RegExp[] = [
  /not-authorized/i,
  /not authorized/i,
  /not_authorized/i,
];

/**
 * Dead, revoked, or permanently invalid links.
 * 400 bad-request, 403 forbidden (when link revoked), 404 item-not-found,
 * 405 not-allowed, 410 gone.
 */
const SKIP_PATTERNS: RegExp[] = [
  /item-not-found/i,
  /not-found/i,
  /gone/i,
  /bad-request/i,
  /bad request/i,
  /bad-param/i,
  /bad_param/i,
  /invalid/i,
  /expired/i,
  /link.*(revoked|expired|invalid)/i,
  /group.*(deleted|closed|not exist)/i,
  /invite.*invalid/i,
  /join-denied/i,
  /group full/i,
  /group-full/i,
  /no-room/i,
  /admin.*denied/i,
  /not-allowed/i,
  /not_allowed/i,
  /forbidden/i,
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

const STOP_ALL_PATTERNS: RegExp[] = [
  /account.*block/i,
  /account.*suspend/i,
  /account.*banned/i,
  /temporarily.*block/i,
  /blocked.*account/i,
  /your.*account.*restrict/i,
  /action.*block/i,
  /spam.*detect/i,
  /account.*locked/i,
];

// ── Main classifier ────────────────────────────────────────────────────────────

export function classifyWAError(
  err:                unknown,
  consecutiveFailures = 0,
): WAErrorResult {
  const raw        = (err as any)?.message ?? String(err);
  const msg        = raw.toLowerCase();
  const statusCode =
    (err as any)?.output?.statusCode ??
    (err as any)?.statusCode ??
    parseInt(raw.match(/\b(\d{3})\b/)?.[1] ?? "0", 10);

  // ── 1. PENDING APPROVAL (406 not-acceptable) ─────────────────────────────────
  // Must be checked BEFORE rate-limit and before the network-error fallback,
  // because these errors arrive as WhatsApp application errors (not OS errors)
  // and should NEVER be retried — doing so just spams the group admin.
  if (
    PENDING_APPROVAL_PATTERNS.some((p) => p.test(msg)) ||
    statusCode === 406
  ) {
    return {
      action:   "pending_approval",
      reason:   "طلب الانضمام مُرسَل مسبقاً وينتظر موافقة المشرف",
      critical: false,
    };
  }

  // ── 2. ACCOUNT THREAT — stop everything now ──────────────────────────────────
  if (STOP_ALL_PATTERNS.some((p) => p.test(msg)) || statusCode === 401 && !KICKED_PATTERNS.some(p => p.test(msg))) {
    return {
      action:   "stop_all",
      reason:   `⚠️ حساب تحت التهديد: ${raw}`,
      critical: true,
    };
  }

  // ── 3. ALREADY MEMBER (409 conflict) ─────────────────────────────────────────
  if (ALREADY_MEMBER_PATTERNS.some((p) => p.test(msg)) || statusCode === 409) {
    return {
      action:   "already_member",
      reason:   "أنت بالفعل عضو في هذه المجموعة",
      critical: false,
    };
  }

  // ── 4. KICKED (401 not-authorized) — account removed from THIS group ─────────
  // Checked AFTER stop_all to avoid misclassifying account-ban as kick.
  if (KICKED_PATTERNS.some((p) => p.test(msg))) {
    return {
      action:   "kicked",
      reason:   `تمت إزالة الحساب من المجموعة: ${raw}`,
      critical: false,
    };
  }

  // ── 5. STOP JOIN — WA blocking join action specifically ──────────────────────
  if (STOP_JOIN_PATTERNS.some((p) => p.test(msg)) || statusCode === 421) {
    return {
      action:   "stop_join",
      reason:   `⛔ WhatsApp يمنع الانضمام: ${raw}`,
      waitMs:   15 * 60_000,
      critical: true,
    };
  }

  // ── 6. RATE LIMIT (429 rate-overlimit) ───────────────────────────────────────
  // Exponential backoff: 1min → 2min → 4min → 8min → 15min
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(msg)) || statusCode === 429) {
    const waitMs = Math.min(
      15 * 60_000,
      60_000 * Math.pow(2, Math.max(0, consecutiveFailures - 1)),
    );
    return {
      action:   "wait_and_retry",
      reason:   `⏳ تجاوز حد المعدل — انتظار ${Math.round(waitMs / 1000)}ث`,
      waitMs,
      critical: false,
    };
  }

  // ── 7. COMMUNITY invite ──────────────────────────────────────────────────────
  if (COMMUNITY_PATTERNS.some((p) => p.test(msg))) {
    return {
      action:   "community",
      reason:   "هذا مجتمع وليس مجموعة عادية",
      critical: false,
    };
  }

  // ── 8. SKIP — dead / revoked / permanently invalid link ──────────────────────
  if (
    SKIP_PATTERNS.some((p) => p.test(msg)) ||
    statusCode === 400 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 405 ||
    statusCode === 410
  ) {
    return {
      action:   "skip",
      reason:   `رابط منتهٍ أو غير صالح: ${raw}`,
      critical: false,
    };
  }

  // ── 9. TRUE NETWORK / OS ERROR — transient, safe to retry ───────────────────
  // Only real TCP/OS errors reach this branch. WhatsApp app errors are handled above.
  if (NETWORK_ERROR_PATTERNS.some((p) => p.test(raw))) {
    return {
      action:   "retry",
      reason:   `خطأ شبكي حقيقي (OS/TCP) — سيُعاد المحاولة: ${raw}`,
      critical: false,
    };
  }

  // ── 10. TRANSIENT SERVER ERRORS (408 / 500 / 503 / timeout) ─────────────────
  if (
    statusCode === 408 || statusCode === 500 || statusCode === 503 ||
    msg.includes("timeout") || msg.includes("timed out")
  ) {
    return {
      action:   "retry",
      reason:   `خطأ مؤقت في الخادم — إعادة المحاولة: ${raw}`,
      critical: false,
    };
  }

  // ── 11. HIGH CONSECUTIVE FAILURES — protective stop (not account threat) ─────
  if (consecutiveFailures >= 8) {
    return {
      action:   "stop_join",
      reason:   `${consecutiveFailures} أخطاء متتالية — توقف مؤقت للحماية`,
      waitMs:   10 * 60_000,
      critical: true,
    };
  }

  // ── 12. UNKNOWN — retry once; link stays Pending, never silently dropped ─────
  return {
    action:   "retry",
    reason:   `خطأ غير معروف — إعادة المحاولة: ${raw}`,
    critical: false,
  };
}
