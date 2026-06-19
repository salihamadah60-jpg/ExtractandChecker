/**
 * join-manager.ts — Smart join scheduler with human pacing (per-workspace)
 *
 * Rate model: 4 links per 10-minute window spread across random slots.
 * All state is isolated per-workspace via Maps.
 * Export: getJoinManagerFor(workspaceId) → JoinManagerAPI
 */

import { baileysManager }            from "../baileys-manager.js";
import { getCoordinatorFor }         from "./function-coordinator.js";
import { getTelemetryFor }           from "./telemetry.js";
import { systemState }               from "./system-state.js";
import { linksRepository }           from "./links-repository.js";
import { classifyWAError }           from "./wa-error-handler.js";
import { WINDOW_DURATION_MS, SLOTS_PER_WINDOW, computeSlotOffsets, shuffle } from "./human-mimicry.js";
import { getJoinConfigSync } from "./join-config.js";
import { isAdOnlyMedicalGroup }     from "../link-store.js";
import { keywordFilter }            from "./keyword-filter.js";
import { getLeaveManagerFor }       from "./leave-manager.js";
import { isSleepTime, msUntilWakeUp } from "./sleep-scheduler.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JoinProgress {
  status: "running" | "waiting" | "sleeping" | "cooldown" | "paused" | "done" | "stopped" | "error";
  total:           number;
  processed:       number;
  joined:          number;
  ignored:         number;
  failed:          number;
  skipped_ads:     number;
  pendingApproval: number;   // joins submitted but awaiting admin acceptance
  kicked:          number;   // account was removed/banned from the group; link still valid
  currentLink?: string;
  stopReason?:  string;
  startedAt:    string;
  completedAt?: string;
  windowNumber:    number;
  nextJoinAt?:     string;
  sleepUntil?:     string;
  cooldownUntil?:  string;
  telemetry?: {
    avgLatencyMs:  number;
    lastLatencyMs: number;
    cooldownActive: boolean;
    warning?:      string;
  };
}

// ── Per-workspace state ────────────────────────────────────────────────────────

interface WState {
  progress:       JoinProgress | null;
  stopRequested:  boolean;
  pauseRequested: boolean;
  autoPaused:     boolean;
  joiningCache:   Set<string>;
  /** True while start() is executing — prevents concurrent invocations */
  running:        boolean;
}

const _stateByWid = new Map<string, WState>();

function _st(wid: string): WState {
  if (!_stateByWid.has(wid)) {
    _stateByWid.set(wid, {
      progress:       null,
      stopRequested:  false,
      pauseRequested: false,
      autoPaused:     false,
      joiningCache:   new Set(),
      running:        false,
    });
  }
  return _stateByWid.get(wid)!;
}

// ── Core sleep helper ──────────────────────────────────────────────────────────

async function interruptibleSleep(
  wid: string,
  totalMs: number,
  label: string,
  status: JoinProgress["status"] = "waiting",
  nextAt?: () => string
): Promise<"done" | "stopped"> {
  const s = _st(wid);
  let remaining = totalMs;
  const TICK = 300;

  console.log(`[JoinManager:${wid}] ⏱ ${label} — ${Math.round(totalMs / 1000)}s`);

  while (remaining > 0) {
    if (s.stopRequested) return "stopped";

    if (s.pauseRequested) {
      if (s.progress && s.progress.status !== "paused") {
        s.progress.status    = "paused";
        s.progress.nextJoinAt = nextAt?.();
        await systemState.setExtra(wid, { joinProgress: s.progress }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, TICK));
      continue;
    }

    if (s.progress && s.progress.status !== status) {
      s.progress.status = status;
      if (nextAt) s.progress.nextJoinAt = nextAt();
    }

    const step = Math.min(TICK, remaining);
    await new Promise(r => setTimeout(r, step));
    remaining -= step;
  }

  return "done";
}

async function pauseGate(wid: string): Promise<"ok" | "stopped"> {
  const s = _st(wid);
  while (s.pauseRequested && !s.stopRequested) {
    if (s.progress && s.progress.status !== "paused") {
      s.progress.status = "paused";
      await systemState.setExtra(wid, { joinProgress: s.progress }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (s.stopRequested) return "stopped";
  return "ok";
}

// ── Join one link ──────────────────────────────────────────────────────────────

async function joinOne(
  wid: string,
  record: { url: string },
  consecutiveFailures: number,
  currentPhone?: string,
  retryCount = 0,
  requiresAdminApproval = false   // pre-computed flag; passed through recursive retries
): Promise<{ result: "joined" | "ignored" | "pending_approval" | "kicked" | "failed" | "network_failed" | "stop_all" | "stop_join"; waitMs?: number; isAd?: boolean }> {
  const s   = _st(wid);
  const tel = getTelemetryFor(wid);

  // Guard: skip internal sync-tracking URLs (wa-sync/<jid> or synced-<jid>).
  // These are not real WhatsApp invite links and must never be joined.
  if (/chat\.whatsapp\.com\/(wa-sync\/|synced-)/.test(record.url)) {
    console.log(`[JoinManager:${wid}] ⏭ Skipping internal sync URL: ${record.url}`);
    return { result: "ignored" };
  }

  const codeMatch    = record.url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  const channelMatch = record.url.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/);

  if (channelMatch) {
    await linksRepository.setStatus(wid, record.url, "Ignored");
    return { result: "ignored" };
  }
  if (!codeMatch) {
    await linksRepository.setStatus(wid, record.url, "Ignored");
    return { result: "ignored" };
  }

  const inviteCode = codeMatch[1];

  // Guard: if the extracted code looks like an internal tracking key, skip it.
  if (/^(wa-sync|synced-)/.test(inviteCode)) {
    console.log(`[JoinManager:${wid}] ⏭ Skipping internal invite code: ${inviteCode}`);
    return { result: "ignored" };
  }

  if (s.joiningCache.has(inviteCode)) {
    console.log(`[JoinManager:${wid}] ℹ Cache hit — already joining: ${inviteCode}`);
    return { result: "ignored" };
  }
  s.joiningCache.add(inviteCode);

  // Pre-flight MongoDB check — skip if this phone already joined this link
  try {
    const db  = (await import("../mongo-auth-state.js")).getDb;
    const c   = (await db()).collection("Links_Repository");
    const doc = await c.findOne({ workspaceId: wid, url: record.url }, { projection: { status: 1, joinedByPhone: 1, joinedByPhones: 1 } });
    const alreadyJoined = currentPhone && (
      (Array.isArray(doc?.joinedByPhones) && doc.joinedByPhones.includes(currentPhone)) ||
      (!doc?.joinedByPhones && doc?.joinedByPhone === currentPhone)
    );
    if (alreadyJoined) {
      console.log(`[JoinManager:${wid}] ℹ Pre-flight: already joined by ${currentPhone} — skipping`);
      s.joiningCache.delete(inviteCode);
      return { result: "joined" };
    }
  } catch { /* non-fatal */ }

  // ── Pre-check: does this group require admin approval? ────────────────────────
  // On the FIRST attempt, call groupGetInviteInfo to inspect joinApprovalMode BEFORE
  // calling groupAcceptInvite. Groups with joinApprovalMode=true submit a join REQUEST;
  // WhatsApp then drops the WS connection instead of returning a clean JID, which Baileys
  // reports as a network error. We must NOT retry — we should mark as pending_approval.
  if (retryCount === 0) {
    try {
      const sockState = baileysManager.getActiveStateForWorkspace(wid);
      if (sockState?.sock) {
        const invInfo = await Promise.race([
          sockState.sock.groupGetInviteInfo(inviteCode),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8_000)),
        ]) as any;

        if (invInfo?.joinApprovalMode === true) {
          requiresAdminApproval = true;
          console.log(`[JoinManager:${wid}] ⚠ مجموعة تشترط موافقة المشرف: ${record.url}`);
        }

        // Update progress with group name if we got it from invite info
        const preCheckName: string | undefined = invInfo?.subject || invInfo?.name || undefined;
        if (preCheckName && s.progress) {
          s.progress.currentLink = `${preCheckName} — ${record.url}`;
        }
      }
    } catch { /* non-fatal: proceed without pre-check */ }
  }

  const t0 = Date.now();

  try {
    const groupJid = await baileysManager.joinGroupForWorkspace(inviteCode, wid);
    const latency  = Date.now() - t0;
    tel.record(latency);

    // Check if group requires admin approval — bot must appear in participants, not pendingParticipants
    let capturedMeta: any = null;
    if (groupJid) {
      try {
        // Wait briefly so WhatsApp has time to update group state after the join request
        await new Promise((r) => setTimeout(r, 2000));

        let meta = await baileysManager.getGroupMetadataForWorkspace(groupJid, wid);

        // If first attempt returned null (timing issue), retry once more after another 2s
        if (!meta) {
          await new Promise((r) => setTimeout(r, 2000));
          meta = await baileysManager.getGroupMetadataForWorkspace(groupJid, wid);
        }
        capturedMeta = meta;

        const botJid = baileysManager.getActiveStateForWorkspace(wid)?.sock?.user?.id;
        const botId  = botJid ? botJid.split(":")[0] + "@s.whatsapp.net" : null;

        if (meta && botId) {
          const normalize = (p: any) =>
            (typeof p === "string" ? p : p?.id ?? "").split(":")[0] + "@s.whatsapp.net";

          // Check if bot is among full participants (confirmed member)
          const allParticipants: any[] = meta.participants ?? [];
          const isMember = allParticipants.some((p: any) => normalize(p) === botId);

          // Check if bot is in the pending-approval queue
          const pendingParts: any[] = meta.pendingParticipants ?? [];
          const isInPending = pendingParts.some((p: any) => normalize(p) === botId);

          // If bot is NOT a confirmed member (either explicitly pending or not visible yet)
          if (!isMember) {
            console.log(
              `[JoinManager:${wid}] ⏳ Admin-approval required` +
              ` (inPending=${isInPending}, isMember=false) — ${record.url}`
            );
            // Keep status as "Ignored" so findPendingForJoin skips it (avoids re-join attempt).
            // The group-participants.update watcher will auto-update to "Joined" once approved.
            await linksRepository.setStatus(wid, record.url, "Ignored");
            const _db2 = await (await import("../mongo-auth-state.js")).getDb();
            await _db2.collection("Links_Repository").updateOne(
              { workspaceId: wid, url: record.url },
              { $set: {
                  pendingAdminApproval: true,
                  pendingApprovalSince: new Date(),
                  groupJid: groupJid ?? undefined,
                  updatedAt: new Date(),
              }}
            );
            s.joiningCache.delete(inviteCode);
            // Return "pending_approval" (not "ignored") so the UI shows it as awaiting approval,
            // and consecutiveFailures is NOT incremented for this result.
            return { result: "pending_approval" };
          }
        }
        // meta is null after retries → can't verify; assume joined (log warning)
        if (!meta) {
          console.warn(`[JoinManager:${wid}] ⚠ Could not fetch metadata for ${groupJid} — assuming joined`);
        }
      } catch (metaErr) {
        console.warn(`[JoinManager:${wid}] ⚠ Metadata check error for ${groupJid}:`, (metaErr as Error).message);
      }
    }

    await linksRepository.setStatus(wid, record.url, "Joined", currentPhone);
    await linksRepository.recordCheck(wid, record.url, undefined, undefined, undefined);
    if (groupJid) {
      const db = (await import("../mongo-auth-state.js")).getDb();
      const c  = (await db).collection("Links_Repository");
      await c.updateOne({ workspaceId: wid, url: record.url }, { $set: { groupJid, updatedAt: new Date() } });
    }

    // Ad-group / banned keyword detection: add to leave queue
    let isAdDetected = false;
    if (capturedMeta) {
      const combinedText = `${capturedMeta.subject ?? ""} ${capturedMeta.desc ?? ""}`;
      const isAdByMedical = isAdOnlyMedicalGroup(capturedMeta.subject ?? "", capturedMeta.desc ?? "");
      const isAdByKw      = keywordFilter.isAdOnlySync(wid, combinedText);
      const isBannedByKw  = keywordFilter.isBannedSync(wid, combinedText);

      if (isAdByMedical || isAdByKw || isBannedByKw) {
        isAdDetected = true;
        const reason = isBannedByKw
          ? "اكتشاف تلقائي — مجموعة محظورة (كلمة مفتاحية)"
          : isAdByKw
            ? "اكتشاف تلقائي — مجموعة إعلانية (كلمة مفتاحية)"
            : "اكتشاف تلقائي — مجموعة إعلانية";
        try {
          await getLeaveManagerFor(wid).enqueue(record.url, reason);
          console.log(`[JoinManager:${wid}] 📤 ${reason} → قائمة المغادرة: ${record.url}`);
        } catch (e) {
          console.warn(`[JoinManager:${wid}] ⚠ تعذّر الإضافة لقائمة المغادرة:`, (e as Error).message);
        }
      }
    }

    console.log(`[JoinManager:${wid}] ✓ Joined${isAdDetected ? " [إعلانات]" : ""} (${latency}ms) [${currentPhone ?? "?"}]: ${record.url}`);
    return { result: "joined", isAd: isAdDetected };

  } catch (err: unknown) {
    const latency    = Date.now() - t0;
    const classified = classifyWAError(err, consecutiveFailures);

    switch (classified.action) {
      case "stop_all":
        tel.triggerEmergency(classified.reason, 30 * 60_000);
        return { result: "stop_all" };

      case "stop_join":
        tel.triggerEmergency(classified.reason, classified.waitMs ?? 15 * 60_000);
        return { result: "stop_join", waitMs: classified.waitMs };

      case "kicked":
        // Account was removed/banned from this specific group.
        // The invite link is still valid — mark as Ignored with kickedFromGroup flag
        // so it doesn't waste slots in future runs. NOT a consecutive failure.
        await linksRepository.setStatus(wid, record.url, "Ignored");
        try {
          const _kickDb = await (await import("../mongo-auth-state.js")).getDb();
          await _kickDb.collection("Links_Repository").updateOne(
            { workspaceId: wid, url: record.url },
            { $set: { kickedFromGroup: true, kickedAt: new Date(), updatedAt: new Date() } }
          );
        } catch {}
        console.warn(`[JoinManager:${wid}] 🚫 مطرود من المجموعة: ${record.url}`);
        return { result: "kicked" };

      case "already_member":
        await linksRepository.setStatus(wid, record.url, "Joined", currentPhone);
        console.log(`[JoinManager:${wid}] ℹ Already member: ${record.url}`);
        return { result: "joined" };

      case "community":
        try {
          const communityJid = await baileysManager.joinCommunityForWorkspace(inviteCode, wid);
          await linksRepository.setStatus(wid, record.url, "Joined", currentPhone);
          if (communityJid) {
            const db = (await import("../mongo-auth-state.js")).getDb();
            const c  = (await db).collection("Links_Repository");
            await c.updateOne({ workspaceId: wid, url: record.url }, { $set: { groupJid: communityJid, type: "Group", updatedAt: new Date() } });
          }
          return { result: "joined" };
        } catch {
          await linksRepository.setStatus(wid, record.url, "Ignored");
          return { result: "ignored" };
        }

      case "pending_approval": {
        // 406 not-acceptable: WhatsApp confirmed the invite code is valid but a
        // join request from this account is ALREADY PENDING admin approval.
        // Do NOT retry — just mark as PendingApproval and move on.
        // The group-participants.update watcher will flip it to Joined when approved.
        await linksRepository.setStatus(wid, record.url, "Ignored");
        try {
          const _paDb = await (await import("../mongo-auth-state.js")).getDb();
          await _paDb.collection("Links_Repository").updateOne(
            { workspaceId: wid, url: record.url },
            { $set: {
                pendingAdminApproval: true,
                pendingApprovalSince: new Date(),
                updatedAt:            new Date(),
            }}
          );
        } catch { /* non-fatal */ }
        console.log(`[JoinManager:${wid}] ⏳ طلب انضمام مُرسَل مسبقاً — ينتظر موافقة المشرف: ${record.url}`);
        s.joiningCache.delete(inviteCode);
        return { result: "pending_approval" };
      }

      case "wait_and_retry": {
        // Rate-limited — keep the link as Pending so it is retried in the next session.
        // Return "network_failed" so consecutiveFailures is NOT incremented.
        tel.record(latency);
        const waitMs = classified.waitMs ?? 60_000;
        console.warn(
          `[JoinManager:${wid}] ⏳ حد المعدل — الرابط يبقى معلقاً للجلسة التالية (backoff ${Math.round(waitMs / 1000)}s): ${record.url}`
        );
        s.joiningCache.delete(inviteCode);
        return { result: "network_failed" };
      }

      case "retry": {
        // ── Admin-approval fast-path ──────────────────────────────────────────────
        // If we confirmed BEFORE joining that the group requires admin approval, the
        // join REQUEST was submitted but WhatsApp dropped the WS connection instead of
        // returning a clean JID (this is WhatsApp's expected behaviour for approval groups).
        // Do NOT retry — that would spam the admin. Mark as pending immediately.
        if (requiresAdminApproval) {
          console.log(
            `[JoinManager:${wid}] ⏳ مجموعة تشترط موافقة المشرف — الطلب أُرسل ولن تُعاد المحاولة: ${record.url}`
          );
          await linksRepository.setStatus(wid, record.url, "Ignored");
          try {
            const _paDb = await (await import("../mongo-auth-state.js")).getDb();
            await _paDb.collection("Links_Repository").updateOne(
              { workspaceId: wid, url: record.url },
              { $set: { pendingAdminApproval: true, pendingApprovalSince: new Date(), updatedAt: new Date() } }
            );
          } catch { /* non-fatal */ }
          s.joiningCache.delete(inviteCode);
          return { result: "pending_approval" };
        }

        // ── True network error — retry up to 3 times ─────────────────────────────
        // Legacy post-error check (kept as secondary detection for unknown approval groups):
        try {
          const sockState = baileysManager.getActiveStateForWorkspace(wid);
          if (sockState?.sock) {
            // Give WhatsApp ~1.5s to update group state after the connection drop
            await new Promise(r => setTimeout(r, 1_500));
            const invInfo = await Promise.race([
              sockState.sock.groupGetInviteInfo(inviteCode),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5_000)),
            ]) as any;

            if (invInfo?.id) {
              const groupJidCandidate: string = invInfo.id;
              const meta = await baileysManager.getGroupMetadataForWorkspace(groupJidCandidate, wid);
              if (meta) {
                const botJid = sockState.sock?.user?.id;
                const botId  = botJid ? botJid.split(":")[0] + "@s.whatsapp.net" : null;
                if (botId) {
                  const normalize = (p: any) =>
                    (typeof p === "string" ? p : p?.id ?? "").split(":")[0] + "@s.whatsapp.net";
                  const isInPending = (meta.pendingParticipants ?? []).some((p: any) => normalize(p) === botId);
                  const isNowMember = (meta.participants        ?? []).some((p: any) => normalize(p) === botId);

                  if (isNowMember) {
                    // Race: got accepted instantly between the error and our check
                    await linksRepository.setStatus(wid, record.url, "Joined", currentPhone);
                    console.log(`[JoinManager:${wid}] ✓ Joined (race-detect after network drop): ${record.url}`);
                    s.joiningCache.delete(inviteCode);
                    return { result: "joined" };
                  }

                  if (isInPending) {
                    // Join request WAS submitted — WhatsApp just dropped the conn after accepting it.
                    // Mark as pending_approval; do NOT retry.
                    console.log(
                      `[JoinManager:${wid}] ⏳ طلب الانضمام أُرسل بنجاح لكن الاتصال انقطع — ينتظر موافقة المشرف: ${record.url}`
                    );
                    await linksRepository.setStatus(wid, record.url, "Ignored");
                    try {
                      const _paDb = await (await import("../mongo-auth-state.js")).getDb();
                      await _paDb.collection("Links_Repository").updateOne(
                        { workspaceId: wid, url: record.url },
                        { $set: {
                            pendingAdminApproval: true,
                            pendingApprovalSince: new Date(),
                            groupJid: groupJidCandidate,
                            updatedAt: new Date(),
                        }}
                      );
                    } catch { /* non-fatal */ }
                    s.joiningCache.delete(inviteCode);
                    return { result: "pending_approval" };
                  }
                }
              }
            }
          }
        } catch {
          /* non-fatal — fall through to normal retry logic */
        }

        const MAX_NET_RETRIES = 3;
        if (retryCount < MAX_NET_RETRIES) {
          const delayMs = Math.min(15_000 * (retryCount + 1), 60_000);
          console.warn(
            `[JoinManager:${wid}] 🔌 خطأ شبكي حقيقي (محاولة ${retryCount + 1}/${MAX_NET_RETRIES}) — انتظار ${delayMs / 1000}ث: ${record.url}`
          );
          s.joiningCache.delete(inviteCode);
          await new Promise((r) => setTimeout(r, delayMs));
          if (s.stopRequested) return { result: "network_failed" };
          if (!baileysManager.isConnectedForWorkspace(wid)) {
            console.log(`[JoinManager:${wid}] ⏳ واتساب منقطع — انتظار إعادة الاتصال (max 60s)…`);
            let waited = 0;
            while (!baileysManager.isConnectedForWorkspace(wid) && waited < 60_000 && !s.stopRequested) {
              await new Promise(r => setTimeout(r, 2_000));
              waited += 2_000;
            }
            if (!baileysManager.isConnectedForWorkspace(wid)) {
              console.warn(`[JoinManager:${wid}] ⚠ واتساب لا يزال منقطعاً — تأجيل الرابط: ${record.url}`);
              return { result: "network_failed" };
            }
          }
          return joinOne(wid, record, consecutiveFailures, currentPhone, retryCount + 1, requiresAdminApproval);
        }
        // After 3 retries, permanently ignore the link so it's not re-queued on next start.
        // These links are likely: already-joined (kicked), or truly dead network endpoints.
        console.warn(`[JoinManager:${wid}] ✗ فشل الاتصال بعد ${MAX_NET_RETRIES} محاولات — تم تجاهل الرابط: ${record.url}`);
        await linksRepository.setStatus(wid, record.url, "Ignored").catch(() => {});
        return { result: "network_failed" };
      }

      default:
        // "skip" action = confirmed dead link (revoked / expired / group deleted).
        await linksRepository.setStatus(wid, record.url, "Ignored");
        console.warn(`[JoinManager:${wid}] ✗ رابط منتهٍ: ${classified.reason} | ${record.url}`);
        return { result: "ignored" };
    }
  } finally {
    s.joiningCache.delete(inviteCode);
  }
}

// ── Telemetry sync ─────────────────────────────────────────────────────────────

function syncTelemetry(wid: string): void {
  const s   = _st(wid);
  const tel = getTelemetryFor(wid);
  if (!s.progress) return;
  const r = tel.getReport();
  s.progress.telemetry = {
    avgLatencyMs:   r.avgLatencyMs,
    lastLatencyMs:  r.lastLatencyMs,
    cooldownActive: r.cooldownActive,
    warning:        r.warning,
  };
  if (r.cooldownActive && r.cooldownUntil) {
    s.progress.cooldownUntil = r.cooldownUntil.toISOString();
  } else {
    s.progress.cooldownUntil = undefined;
  }
}

// ── Manager factory ────────────────────────────────────────────────────────────

function _createManager(wid: string) {
  return {
    getProgress(): JoinProgress | null { return _st(wid).progress; },

    requestStop(): void {
      const s = _st(wid);
      s.stopRequested  = true;
      s.pauseRequested = false;
      if (s.progress && s.progress.status !== "done") s.progress.status = "stopped";
      console.log(`[JoinManager:${wid}] 🛑 Stop requested`);
    },

    requestPause(): void {
      const s = _st(wid);
      if (!s.progress || s.progress.status === "done" || s.progress.status === "stopped") return;
      s.pauseRequested = true;
      console.log(`[JoinManager:${wid}] ⏸ Pause requested`);
    },

    requestResume(): void {
      const s = _st(wid);
      if (!s.progress) return;
      s.pauseRequested = false;
      if (s.progress.status === "paused") s.progress.status = "waiting";
      console.log(`[JoinManager:${wid}] ▶ Resume requested`);
    },

    isPaused(): boolean { return _st(wid).pauseRequested; },

    autoPause(): void {
      const s = _st(wid);
      if (!s.progress) return;
      const st = s.progress.status;
      if (st === "done" || st === "stopped") return;
      if (s.pauseRequested) return;
      s.autoPaused     = true;
      s.pauseRequested = true;
      if (s.progress) s.progress.stopReason = "انقطع الاتصال بـ WhatsApp — سيُستأنف تلقائياً عند إعادة الاتصال";
      console.log(`[JoinManager:${wid}] ⏸ Auto-paused (WhatsApp disconnected)`);
    },

    autoResume(): void {
      const s = _st(wid);
      if (!s.autoPaused) return;
      s.autoPaused     = false;
      s.pauseRequested = false;
      if (s.progress && s.progress.status === "paused") {
        s.progress.status    = "waiting";
        s.progress.stopReason = undefined;
      }
      console.log(`[JoinManager:${wid}] ▶ Auto-resumed (WhatsApp reconnected)`);
    },

    async start(maxLinks?: number): Promise<void> {
      const coord = getCoordinatorFor(wid);
      const tel   = getTelemetryFor(wid);

      // ── Guard: prevent concurrent invocations ──────────────────────────────
      // This is the PRIMARY protection against duplicate concurrent runs.
      // The coordinator lock alone is not sufficient because acquire() is async
      // and a race window exists between the running check and the actual lock.
      const s = _st(wid);
      if (s.running) {
        console.warn(`[JoinManager:${wid}] ⚠ start() ignored — session already running`);
        return;
      }
      s.running = true;

      if (!baileysManager.isConnectedForWorkspace(wid)) {
        s.running = false;
        throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
      }

      const acquired = await coord.acquire("joining");
      if (!acquired) {
        s.running = false;
        const active = coord.getActive();
        throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً. يُرجى الانتظار.`);
      }

      s.stopRequested  = false;
      s.pauseRequested = false;
      tel.reset();

      try {
        await systemState.setActiveFunction(wid, "joining");

        const currentPhone = baileysManager.getConnectedPhoneForWorkspace(wid) ?? undefined;
        console.log(`[JoinManager:${wid}] 🚀 Starting — phone: ${currentPhone ?? "unknown"}, maxLinks: ${maxLinks ?? "all"}`);

        // Pre-join sync: fetch all currently-joined WA groups and update DB.
        // This marks already-joined links as "Joined" so they don't waste join slots,
        // and resolves any pending-approval links that were accepted since last run.
        try {
          const syncResult = await baileysManager.syncGroupsForWorkspace(wid);
          console.log(`[JoinManager:${wid}] 🔄 Pre-sync: ${syncResult.synced} synced, ${syncResult.markedLeft} marked Left`);
        } catch (syncErr) {
          console.warn(`[JoinManager:${wid}] ⚠ Pre-sync skipped (non-fatal):`, (syncErr as Error).message);
        }

        const pendingLinks = await linksRepository.findPendingForJoin(wid, currentPhone);
        if (!pendingLinks.length) {
          throw new Error("لا توجد روابط معلقة في المستودع للانضمام إليها.");
        }

        const allLinks = shuffle(pendingLinks);
        const queue    = (maxLinks && maxLinks > 0) ? allLinks.slice(0, maxLinks) : allLinks;

        console.log(`[JoinManager:${wid}] Queue: ${queue.length} links`);

        s.progress = {
          status:          "waiting",
          total:           queue.length,
          processed:       0,
          joined:          0,
          ignored:         0,
          failed:          0,
          skipped_ads:     0,
          pendingApproval: 0,
          kicked:          0,
          startedAt:       new Date().toISOString(),
          windowNumber:    0,
        };

        await systemState.setExtra(wid, { joinProgress: s.progress });

        let queueIdx            = 0;
        let consecutiveFailures = 0;

        // ── Main window loop ───────────────────────────────────────────────────
        while (queueIdx < queue.length) {
          const gateResult = await pauseGate(wid);
          if (gateResult === "stopped") break;
          if (s.stopRequested) break;

          // Daily sleep check
          if (isSleepTime()) {
            const wakeMs  = msUntilWakeUp();
            const wakeISO = new Date(Date.now() + wakeMs).toISOString();
            console.log(`[JoinManager:${wid}] 🌙 Daily sleep — waking at ${new Date(wakeISO).toLocaleTimeString()}`);
            if (s.progress) {
              s.progress.status     = "sleeping";
              s.progress.sleepUntil = wakeISO;
              s.progress.nextJoinAt = wakeISO;
            }
            const outcome = await interruptibleSleep(wid, wakeMs, "نوم ليلي", "sleeping");
            if (s.progress) s.progress.sleepUntil = undefined;
            if (outcome === "stopped") break;
            continue;
          }

          // Connection check
          if (!baileysManager.isConnectedForWorkspace(wid)) {
            console.warn(`[JoinManager:${wid}] ⚠ Connection lost — waiting 60s`);
            if (s.progress) { s.progress.status = "paused"; s.progress.stopReason = "انقطع الاتصال بـ WhatsApp"; }
            const outcome = await interruptibleSleep(wid, 60_000, "انتظار إعادة الاتصال", "paused");
            if (outcome === "stopped") break;
            continue;
          }

          // User-activity guard — scoped to THIS workspace's phone only
          if (baileysManager.isUserActiveForWorkspace(wid, 90_000)) {
            console.log(`[JoinManager:${wid}] 👤 User is active — pausing 3 min`);
            if (s.progress) s.progress.status = "waiting";
            const outcome = await interruptibleSleep(wid, 3 * 60_000, "المستخدم نشط — انتظار", "waiting");
            if (outcome === "stopped") break;
            continue;
          }

          // Telemetry cooldown check
          if (tel.isCoolingDown()) {
            const coolMs  = tel.cooldownRemaining();
            const coolISO = new Date(Date.now() + coolMs).toISOString();
            console.log(`[JoinManager:${wid}] 🧊 Telemetry cooldown — ${Math.round(coolMs / 60_000)} min`);
            syncTelemetry(wid);
            if (s.progress) { s.progress.status = "cooldown"; s.progress.nextJoinAt = coolISO; }
            const outcome = await interruptibleSleep(
              wid, coolMs, "تبريد وقائي", "cooldown",
              () => new Date(Date.now() + tel.cooldownRemaining()).toISOString()
            );
            if (outcome === "stopped") break;
            continue;
          }

          // Open a new 10-minute window
          const windowStart    = Date.now();
          const windowEnd      = windowStart + WINDOW_DURATION_MS;
          const windowNum      = (s.progress?.windowNumber ?? 0) + 1;
          const slotsPerWindow = getJoinConfigSync().slotsPerWindow;

          if (s.progress) { s.progress.windowNumber = windowNum; s.progress.status = "waiting"; }

          const offsets   = computeSlotOffsets(slotsPerWindow);
          const slotTimes = offsets.map(off => windowStart + off);

          console.log(
            `[JoinManager:${wid}] 🪟 Window ${windowNum} (${slotsPerWindow} slots): ` +
            offsets.map((o, i) => `s${i}@+${Math.round(o / 1000)}s`).join(", ") +
            ` — queue[${queueIdx}/${queue.length}]`
          );

          coord.setWindowActive(true);
          let windowBroken = false;

          for (let slotIdx = 0; slotIdx < slotsPerWindow; slotIdx++) {
            if (queueIdx >= queue.length || s.stopRequested) break;

            const joinAt   = slotTimes[slotIdx];
            const slotLink = queue[queueIdx];
            const waitMs   = joinAt - Date.now();

            if (waitMs > 0) {
              if (s.progress) s.progress.nextJoinAt = new Date(joinAt).toISOString();
              const outcome = await interruptibleSleep(
                wid, waitMs,
                `نافذة ${windowNum} — فتحة ${slotIdx + 1}/${slotsPerWindow}`,
                "waiting",
                () => new Date(joinAt).toISOString()
              );
              if (outcome === "stopped") { windowBroken = true; break; }
            }

            if ((await pauseGate(wid)) === "stopped") { windowBroken = true; break; }
            if (s.stopRequested) { windowBroken = true; break; }
            if (!baileysManager.isConnectedForWorkspace(wid)) break;
            if (baileysManager.isUserActiveForWorkspace(wid, 60_000)) {
              console.log(`[JoinManager:${wid}] 👤 User active before slot ${slotIdx} — skipping`);
              continue;
            }

            if (s.progress) { s.progress.status = "running"; s.progress.currentLink = slotLink.url; }
            console.log(`[JoinManager:${wid}] ▶ [W${windowNum}] Slot ${slotIdx}: ${slotLink.url}`);

            const r = await joinOne(wid, slotLink, consecutiveFailures, currentPhone);

            if (r.result === "stop_all") {
              if (s.progress) { s.progress.status = "stopped"; s.progress.stopReason = "⚠️ حساب تحت التهديد — تم إيقاف كل شيء"; }
              windowBroken = true; break;
            }
            if (r.result === "stop_join") {
              const wMs = r.waitMs ?? 15 * 60_000;
              syncTelemetry(wid);
              const outcome = await interruptibleSleep(wid, wMs, "توقف واتساب المؤقت", "cooldown");
              if (outcome === "stopped") { windowBroken = true; }
              break;
            }

            if (r.result === "joined")               { consecutiveFailures = 0; if (s.progress) { s.progress.joined++; if (r.isAd) s.progress.skipped_ads++; } }
            else if (r.result === "pending_approval"){ if (s.progress) s.progress.pendingApproval++; /* NOT a failure — awaiting admin acceptance */ }
            else if (r.result === "kicked")          { if (s.progress) s.progress.kicked++; /* removed from group — NOT a consecutive failure */ }
            else if (r.result === "ignored")         { if (s.progress) s.progress.ignored++; /* dead link — NOT a failure */ }
            else if (r.result === "network_failed")  { if (s.progress) s.progress.failed++; /* network — no consecutiveFailures++ */ }
            else                                     { consecutiveFailures++; if (s.progress) s.progress.failed++; }

            queueIdx++;
            if (s.progress) { s.progress.processed++; s.progress.currentLink = undefined; }
            syncTelemetry(wid);
            await systemState.setExtra(wid, { joinProgress: s.progress }).catch(() => {});
          }

          // Note: coord.setWindowActive(false) is called in the finally block — NOT here.
          // Calling it here AND in finally caused duplicate "Join window CLOSED" log lines.

          {
            const snap = s.progress;
            if (snap) {
              const report = tel.getReport();
              tel.recordWindow({
                windowNumber:  windowNum,
                slotsExecuted: Math.min(slotsPerWindow, queueIdx),
                joined:        snap.joined,
                failed:        snap.failed,
                ignored:       snap.ignored,
                startedAt:     new Date(windowStart).toISOString(),
                completedAt:   new Date().toISOString(),
                durationMs:    Date.now() - windowStart,
                avgLatencyMs:  report.avgLatencyMs,
                hadCooldown:   report.cooldownActive,
              });
            }
          }

          if (windowBroken) break;

          if (queueIdx < queue.length && !s.stopRequested) {
            const remainingWindow = windowEnd - Date.now();
            if (remainingWindow > 1000) {
              if (s.progress) s.progress.nextJoinAt = new Date(windowEnd).toISOString();
              const outcome = await interruptibleSleep(
                wid, remainingWindow,
                `نافذة ${windowNum} — انتظار نهاية النافذة`,
                "waiting",
                () => new Date(windowEnd).toISOString()
              );
              if (outcome === "stopped") break;
            }
          }
        }

        // Session complete
        if (s.progress) {
          if (s.progress.status === "running" || s.progress.status === "waiting") {
            s.progress.status      = "done";
            s.progress.completedAt = new Date().toISOString();
          }
          s.progress.nextJoinAt  = undefined;
          s.progress.currentLink = undefined;
        }

        console.log(
          `[JoinManager:${wid}] ✅ Session complete — joined: ${s.progress?.joined ?? 0}, ` +
          `failed: ${s.progress?.failed ?? 0}, ignored: ${s.progress?.ignored ?? 0}`
        );

      } finally {
        s.running = false;
        coord.setWindowActive(false);
        coord.release();
        await systemState.setActiveFunction(wid, null).catch(() => {});
        if (s.progress && !s.progress.completedAt && s.progress.status !== "stopped") {
          s.progress.completedAt = new Date().toISOString();
        }
      }
    },
  };
}

// ── Per-workspace manager cache ────────────────────────────────────────────────

const _managerCache = new Map<string, ReturnType<typeof _createManager>>();

export function getJoinManagerFor(workspaceId: string): ReturnType<typeof _createManager> {
  if (!_managerCache.has(workspaceId)) {
    _managerCache.set(workspaceId, _createManager(workspaceId));
  }
  return _managerCache.get(workspaceId)!;
}

// ── Auto-pause / auto-resume on per-workspace WhatsApp status events ───────────

baileysManager.on("workspace-status", ({ workspaceId: wid, status }: { workspaceId: string; status: string }) => {
  if (!_stateByWid.has(wid)) return; // no active state for this workspace
  const mgr = getJoinManagerFor(wid);
  if (status === "disconnected" || status === "connecting") {
    mgr.autoPause();
  } else if (status === "connected") {
    mgr.autoResume();
  }
});
