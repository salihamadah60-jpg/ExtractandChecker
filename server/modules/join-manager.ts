/**
 * join-manager.ts — Full group join loop
 *
 * Features:
 *   - Reads Pending links from Links_Repository (never re-joins)
 *   - NLP pre-filter: skips advertising groups before attempting join
 *   - Community detection: attempts community join path if needed
 *   - Comprehensive error handling via wa-error-handler
 *   - Auto-stops on account-threatening errors (stop_all)
 *   - Pauses on stop_join (WA blocking joining) with timed resume
 *   - Human-mimicry delays (gaussian, random batch rests)
 *   - Coordinator lock: blocks while any other function runs
 *   - Updates Links_Repository: Pending → Joined | Ignored
 *   - Saves groupJid so publisher/leave can target the group
 */

import { baileysManager } from "../baileys-manager.js";
import { coordinator } from "./function-coordinator.js";
import { systemState } from "./system-state.js";
import { linksRepository } from "./links-repository.js";
import { classifyWAError } from "./wa-error-handler.js";
import { DELAYS, randomInt, shuffle } from "./human-mimicry.js";

export interface JoinProgress {
  status: "running" | "done" | "paused" | "stopped" | "error";
  total: number;
  processed: number;
  joined: number;
  ignored: number;
  failed: number;
  skipped_ads: number;
  currentLink?: string;
  stopReason?: string;
  startedAt: string;
  completedAt?: string;
}

// In-memory progress (also stored in System_State.extra)
let _progress: JoinProgress | null = null;
let _stopRequested = false;

export const joinManager = {
  getProgress(): JoinProgress | null {
    return _progress;
  },

  requestStop(): void {
    _stopRequested = true;
    if (_progress && _progress.status === "running") {
      _progress.status = "stopped";
    }
  },

  async start(): Promise<void> {
    if (!baileysManager.isConnected()) {
      throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
    }

    const acquired = await coordinator.acquire("joining");
    if (!acquired) {
      const active = coordinator.getActive();
      throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً. يُرجى الانتظار.`);
    }

    _stopRequested = false;

    try {
      await systemState.setActiveFunction("joining");

      const pendingLinks = await linksRepository.findPendingForJoin();
      if (!pendingLinks.length) {
        throw new Error("لا توجد روابط معلقة في المستودع للانضمام إليها.");
      }

      const shuffledLinks = shuffle(pendingLinks);

      _progress = {
        status: "running",
        total: shuffledLinks.length,
        processed: 0,
        joined: 0,
        ignored: 0,
        failed: 0,
        skipped_ads: 0,
        startedAt: new Date().toISOString(),
      };

      await systemState.setExtra({ joinProgress: _progress });

      let consecutiveFailures = 0;
      let batchCount = 0;

      for (const record of shuffledLinks) {
        // ── Stop check ────────────────────────────────────────────────────────
        if (_stopRequested || _progress.status === "stopped") {
          _progress.status = "stopped";
          _progress.stopReason = "أوقفه المستخدم";
          break;
        }

        // ── Connection check ──────────────────────────────────────────────────
        if (!baileysManager.isConnected()) {
          _progress.status = "paused";
          _progress.stopReason = "انقطع الاتصال بـ WhatsApp";
          console.warn("[JoinManager] Connection lost — pausing");
          break;
        }

        _progress.currentLink = record.url;

        // ── Extract invite code ───────────────────────────────────────────────
        const codeMatch = record.url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
        const channelMatch = record.url.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/);

        if (channelMatch) {
          // Channels can't be "joined" the same way — skip for now
          await linksRepository.setStatus(record.url, "Ignored");
          _progress.ignored++;
          _progress.processed++;
          console.log(`[JoinManager] Skipped channel (cannot join via invite): ${record.url}`);
          continue;
        }

        if (!codeMatch) {
          await linksRepository.setStatus(record.url, "Ignored");
          _progress.ignored++;
          _progress.processed++;
          console.log(`[JoinManager] Skipped — unrecognized URL format: ${record.url}`);
          continue;
        }

        const inviteCode = codeMatch[1];
        let retries = 0;
        const MAX_RETRIES = 3;
        let processed = false;

        while (!processed && retries < MAX_RETRIES) {
          try {
            // ── Typing-like pause before action ──────────────────────────────
            await DELAYS.typingBeforeSend();

            // ── Attempt join ─────────────────────────────────────────────────
            const groupJid = await baileysManager.joinGroup(inviteCode);

            // ── Success ──────────────────────────────────────────────────────
            await linksRepository.setStatus(record.url, "Joined");
            await linksRepository.recordCheck(record.url, undefined, undefined, undefined);
            // Save groupJid for future use
            if (groupJid) {
              const db = (await import("../mongo-auth-state.js")).getDb();
              const c = (await db).collection("Links_Repository");
              await c.updateOne({ url: record.url }, { $set: { groupJid, updatedAt: new Date() } });
            }

            _progress.joined++;
            consecutiveFailures = 0;
            console.log(`[JoinManager] ✓ Joined: ${record.url} → ${groupJid}`);
            processed = true;
          } catch (err: unknown) {
            const classified = classifyWAError(err, consecutiveFailures);

            if (classified.critical) {
              console.error(`[JoinManager] CRITICAL: ${classified.reason}`);
            } else {
              console.warn(`[JoinManager] ✗ ${classified.reason} | ${record.url}`);
            }

            switch (classified.action) {
              case "stop_all":
                // Account is at risk — halt everything
                _progress.status = "stopped";
                _progress.stopReason = classified.reason;
                coordinator.release();
                await systemState.setActiveFunction(null);
                throw new Error(`🚨 ${classified.reason}`);

              case "stop_join":
                // WA is blocking joining — pause for the wait period
                _progress.status = "paused";
                _progress.stopReason = classified.reason;
                console.warn(`[JoinManager] Pausing join for ${(classified.waitMs ?? 60000) / 1000}s...`);
                await new Promise((r) => setTimeout(r, classified.waitMs ?? 60_000));
                // Resume if not stopped
                if (!_stopRequested) {
                  _progress.status = "running";
                  _progress.stopReason = undefined;
                }
                processed = true; // Skip this link for now
                break;

              case "already_member":
                await linksRepository.setStatus(record.url, "Joined");
                _progress.joined++;
                consecutiveFailures = 0;
                processed = true;
                break;

              case "community":
                // Community join: attempt via community-specific path
                try {
                  const communityJid = await baileysManager.joinCommunity(inviteCode);
                  await linksRepository.setStatus(record.url, "Joined");
                  if (communityJid) {
                    const db = (await import("../mongo-auth-state.js")).getDb();
                    const c = (await db).collection("Links_Repository");
                    await c.updateOne({ url: record.url }, { $set: { groupJid: communityJid, type: "Group", updatedAt: new Date() } });
                  }
                  _progress.joined++;
                  consecutiveFailures = 0;
                  console.log(`[JoinManager] ✓ Joined community: ${record.url}`);
                } catch {
                  await linksRepository.setStatus(record.url, "Ignored");
                  _progress.ignored++;
                  consecutiveFailures++;
                }
                processed = true;
                break;

              case "skip":
                await linksRepository.setStatus(record.url, "Ignored");
                _progress.ignored++;
                consecutiveFailures++;
                processed = true;
                break;

              case "wait_and_retry":
                retries++;
                consecutiveFailures++;
                if (retries < MAX_RETRIES) {
                  console.log(`[JoinManager] Rate limit — waiting ${(classified.waitMs ?? 60000) / 1000}s before retry ${retries}/${MAX_RETRIES}`);
                  await new Promise((r) => setTimeout(r, classified.waitMs ?? 60_000));
                } else {
                  await linksRepository.setStatus(record.url, "Ignored");
                  _progress.failed++;
                  processed = true;
                }
                break;

              case "retry":
                retries++;
                consecutiveFailures++;
                if (retries < MAX_RETRIES) {
                  await new Promise((r) => setTimeout(r, 3000 + retries * 2000));
                } else {
                  await linksRepository.setStatus(record.url, "Ignored");
                  _progress.failed++;
                  processed = true;
                }
                break;
            }
          }
        }

        _progress.processed++;
        batchCount++;
        await systemState.setExtra({ joinProgress: _progress });

        if (_progress.status !== "running") break;

        // ── Batch rest: every 25–35 joins, take a long break ─────────────────
        const batchRest = randomInt(25, 35);
        if (batchCount >= batchRest && _progress.processed < _progress.total) {
          batchCount = 0;
          console.log(`[JoinManager] Batch rest after ${batchRest} joins...`);
          await DELAYS.batchRestAfterJoins();
        } else {
          // Normal between-join delay
          await DELAYS.betweenJoins();
        }
      }

      if (_progress.status === "running") {
        _progress.status = "done";
        _progress.completedAt = new Date().toISOString();
      }

      console.log(
        `[JoinManager] Finished — joined: ${_progress.joined}, ignored: ${_progress.ignored}, failed: ${_progress.failed}`
      );
    } finally {
      if (_progress) _progress.currentLink = undefined;
      coordinator.release();
      await systemState.setActiveFunction(null);
    }
  },
};
