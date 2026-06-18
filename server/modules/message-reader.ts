/**
 * message-reader.ts — Real-time message reader (per-workspace, anti-ban hardened)
 *
 * Ad classification is based on NLP (message content), NOT member count.
 * Links found in ad messages → auto-enqueued for leaving.
 * Links found in non-ad messages → classified as groups to join.
 */

import { baileysManager }    from "../baileys-manager.js";
import { getCoordinatorFor } from "./function-coordinator.js";
import { getTelemetryFor }   from "./telemetry.js";
import { systemState }       from "./system-state.js";
import { linksRepository }   from "./links-repository.js";
import { classifyMessage }   from "./nlp-classifier.js";
import { extractGroupLinks } from "./link-filter.js";
import { isAdOnlyMedicalGroup } from "../link-store.js";
import { keywordFilter } from "./keyword-filter.js";

export interface ReaderStats {
  status: "running" | "stopped" | "paused" | "error";
  continuous:           boolean;
  // ── Session counters (reset on each start) ──────────────────────────────────
  messagesReceived:     number;
  messagesFromAds:      number;
  linksFound:           number;
  linksNew:             number;
  startedAt:            string;
  stoppedAt?:           string;
  pausedAt?:            string;
  lastMessageId?:       string;
  pipelineRuns?:        number;
  pipelineSkipped?:     number;
  bufferSize?:          number;
  // ── Last pipeline run results ───────────────────────────────────────────────
  lastPipelineAt?:      string;
  lastPipelineChecked?: number;
  lastPipelineGroups?:  number;
  lastPipelineAds?:     number;
  // ── Cumulative totals (loaded from MongoDB, survive restarts) ────────────────
  totalMessages:        number;
  totalLinksFound:      number;
  totalLinksNew:        number;
  totalPipelineRuns:    number;
}

// ── Per-workspace state ────────────────────────────────────────────────────────

const PIPELINE_DEBOUNCE_MS  = 45_000;
const PIPELINE_BUFFER_CAP   = 30;
const PIPELINE_MIN_INTERVAL = 10 * 60_000;
const MAX_HANDLER_ERRORS    = 10;

interface BufferEntry { url: string; isAdMessage: boolean; }

const FLUSH_EVERY = 50; // flush delta to MongoDB every N messages

interface BufferDelta { messages: number; linksFound: number; linksNew: number; }

interface AdGroupStats { ads: number; total: number; enqueued: boolean; }

interface WState {
  stats:              ReaderStats | null;
  running:            boolean;
  /** True between the `if (s.running) return` check and s.running=true — closes the async race window */
  starting:           boolean;
  paused:             boolean;
  shouldBeRunning:    boolean;
  pipelineBuffer:     Map<string, BufferEntry>;  // url → entry (non-ad wins)
  pipelineLock:       boolean;
  pipelineDebounce:   ReturnType<typeof setTimeout> | null;
  lastPipelineRun:    number;
  handlerErrors:      number;
  pendingDelta:       BufferDelta;  // unflushed increment waiting to be written to MongoDB
  adRatioByGroup:     Map<string, AdGroupStats>; // tracks ad-message ratio per group JID
}

const _stateByWid = new Map<string, WState>();

function _st(wid: string): WState {
  if (!_stateByWid.has(wid)) {
    _stateByWid.set(wid, {
      stats:            null,
      running:          false,
      starting:         false,
      paused:           false,
      shouldBeRunning:  false,
      pipelineBuffer:   new Map(),
      pipelineLock:     false,
      pipelineDebounce: null,
      lastPipelineRun:  0,
      handlerErrors:    0,
      pendingDelta:     { messages: 0, linksFound: 0, linksNew: 0 },
      adRatioByGroup:   new Map(),
    });
  }
  return _stateByWid.get(wid)!;
}

/** Flush pending delta to MongoDB if there is anything to write. */
async function _flushDelta(wid: string): Promise<void> {
  const s = _st(wid);
  const d = s.pendingDelta;
  if (d.messages === 0 && d.linksFound === 0 && d.linksNew === 0) return;
  const snapshot = { ...d };
  s.pendingDelta = { messages: 0, linksFound: 0, linksNew: 0 };
  try {
    await systemState.incrementReaderCounters(wid, snapshot);
    // Keep cumulative totals in stats up-to-date
    if (s.stats) {
      s.stats.totalMessages   = (s.stats.totalMessages   ?? 0) + snapshot.messages;
      s.stats.totalLinksFound = (s.stats.totalLinksFound ?? 0) + snapshot.linksFound;
      s.stats.totalLinksNew   = (s.stats.totalLinksNew   ?? 0) + snapshot.linksNew;
    }
  } catch (err) {
    // Non-fatal: restore delta so it gets flushed next time
    s.pendingDelta.messages   += snapshot.messages;
    s.pendingDelta.linksFound += snapshot.linksFound;
    s.pendingDelta.linksNew   += snapshot.linksNew;
    console.warn(`[MessageReader:${wid}] Delta flush failed:`, (err as Error).message);
  }
}

function _cleanLink(link: string): string {
  try { const u = new URL(link.trim()); return `${u.origin}${u.pathname}`; }
  catch { return link.trim(); }
}

// ── Pipeline (per-workspace) ───────────────────────────────────────────────────

function _schedulePipeline(wid: string): void {
  const s = _st(wid);
  if (s.pipelineDebounce) clearTimeout(s.pipelineDebounce);
  s.pipelineDebounce = setTimeout(() => _runPipeline(wid), PIPELINE_DEBOUNCE_MS);
}

async function _runPipeline(wid: string): Promise<void> {
  const s     = _st(wid);
  const coord = getCoordinatorFor(wid);
  const tel   = getTelemetryFor(wid);

  s.pipelineDebounce = null;
  if (s.pipelineLock || s.pipelineBuffer.size === 0 || !s.running) return;

  // Only defer if a genuinely incompatible function is running (joining/leaving/publishing).
  // "reading" is not a blocker — the pipeline's step 1 pauses the reader itself.
  // Previously this blocked the pipeline indefinitely whenever the message reader was active.
  const activeFunc = coord.getActive();
  if (coord.isRunning() && activeFunc !== "reading") {
    console.log(`[Pipeline:${wid}] Coordinator busy (${activeFunc}) — deferred`);
    if (s.stats) s.stats.pipelineSkipped = (s.stats.pipelineSkipped ?? 0) + 1;
    s.pipelineDebounce = setTimeout(() => _runPipeline(wid), 5 * 60_000);
    return;
  }

  const elapsed = Date.now() - s.lastPipelineRun;
  if (s.lastPipelineRun > 0 && elapsed < PIPELINE_MIN_INTERVAL) {
    const wait = PIPELINE_MIN_INTERVAL - elapsed;
    console.log(`[Pipeline:${wid}] Too soon (${Math.round(elapsed / 60_000)} min ago) — waiting ${Math.round(wait / 60_000)} min`);
    if (s.stats) s.stats.pipelineSkipped = (s.stats.pipelineSkipped ?? 0) + 1;
    s.pipelineDebounce = setTimeout(() => _runPipeline(wid), wait);
    return;
  }

  if (tel.isCoolingDown()) {
    const wait = tel.cooldownRemaining();
    console.log(`[Pipeline:${wid}] Telemetry cooldown — deferring ${Math.round(wait / 60_000)} min`);
    s.pipelineDebounce = setTimeout(() => _runPipeline(wid), wait + 5000);
    return;
  }

  s.pipelineLock = true;

  const entries: BufferEntry[] = [...s.pipelineBuffer.values()];
  s.pipelineBuffer = new Map();
  if (s.stats) s.stats.bufferSize = 0;

  const linksToCheck = entries.map(e => e.url);
  console.log(`[Pipeline:${wid}] Starting — ${linksToCheck.length} buffered links`);

  try {
    // Reading continues in the background — pipeline runs concurrently (safe: read-only API calls).
    s.lastPipelineRun = Date.now();

    // 2. Check links
    const checkResults = await baileysManager.checkLinksForPipelineForWorkspace(linksToCheck, wid);

    // 3a. Valid group links only
    const validGroups = checkResults.filter(
      (r) => r.status === "valid" && r.url.includes("chat.whatsapp.com")
    );

    // 3b. Mark invalid as Ignored
    for (const r of checkResults) {
      if (r.status !== "valid") {
        await linksRepository.setStatus(wid, _cleanLink(r.url), "Ignored").catch(() => {});
      }
    }

    // 3c. NLP-based classification
    //     • isAdOnlyMedicalGroup (name/description keyword match) → ad
    //     • custom "ad_only" keyword match (keywordFilter)        → ad
    //     • came from an ad message (NLP flagged)                → ad
    //     • everything else with members > 10                    → group
    const _isAdByKeyword = (name: string | undefined, desc: string | undefined): boolean => {
      const text = `${name ?? ""} ${desc ?? ""}`;
      return keywordFilter.isAdOnlySync(wid, text);
    };
    const _isBannedByKeyword = (name: string | undefined, desc: string | undefined): boolean => {
      const text = `${name ?? ""} ${desc ?? ""}`;
      return keywordFilter.isBannedSync(wid, text);
    };

    const groups = validGroups
      .filter((r) => {
        const m = r.members ?? 0;
        if (m <= 10) return false;
        if (_isBannedByKeyword(r.name, r.description)) return false;
        if (isAdOnlyMedicalGroup(r.name, r.description)) return false;
        if (_isAdByKeyword(r.name, r.description)) return false;
        const entry = entries.find(e => _cleanLink(e.url) === _cleanLink(r.url));
        if (entry?.isAdMessage) return false;
        return true;
      })
      .map((r) => ({ link: _cleanLink(r.url), name: r.name, members: r.members, description: r.description }));

    const ads = validGroups
      .filter((r) => {
        const m = r.members ?? 0;
        if (m <= 10) return false;
        if (_isBannedByKeyword(r.name, r.description)) return false;
        if (isAdOnlyMedicalGroup(r.name, r.description)) return true;
        if (_isAdByKeyword(r.name, r.description)) return true;
        const entry = entries.find(e => _cleanLink(e.url) === _cleanLink(r.url));
        return entry?.isAdMessage === true;
      })
      .map((r) => ({ link: _cleanLink(r.url), name: r.name, members: r.members, description: r.description }));

    // 4. Save GROUPS only — ad-source links are intentionally discarded to prevent DB pollution.
    //    Per-group ad detection (for the leave queue) happens live in _handleMessage.
    if (s.stats) {
      s.stats.lastPipelineAt      = new Date().toISOString();
      s.stats.lastPipelineChecked = linksToCheck.length;
      s.stats.lastPipelineGroups  = groups.length;
      s.stats.lastPipelineAds     = ads.length;
    }

    if (groups.length > 0) {
      await linksRepository.saveFilteredLinks(wid, groups, []);
      console.log(`[Pipeline:${wid}] ✓ ${groups.length} groups saved | ${ads.length} ad-links discarded`);
      // NOTE: Join does NOT auto-start — user must trigger it manually (prevents unexpected auto-resume).
    } else {
      console.log(`[Pipeline:${wid}] No valid groups — ${ads.length} ad-links discarded`);
    }

    if (s.stats) {
      s.stats.pipelineRuns = (s.stats.pipelineRuns ?? 0) + 1;
      s.stats.totalPipelineRuns = (s.stats.totalPipelineRuns ?? 0) + 1;
    }
    // Persist totalPipelineRuns to MongoDB (non-blocking)
    systemState.incrementPipelineRuns(wid).catch(() => {});

  } catch (err) {
    console.error(`[Pipeline:${wid}] Error:`, (err as Error).message);
  } finally {
    // Reading was never paused — nothing to resume.
    s.pipelineLock = false;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

const _listenerRegistered = new Set<string>();

function _createManager(wid: string) {
  // Register coordinator event listeners once per workspace
  if (!_listenerRegistered.has(wid)) {
    _listenerRegistered.add(wid);
    const coord = getCoordinatorFor(wid);

    // Reading runs on its own independent track — it is NEVER preempted and NEVER
    // auto-resumes based on coordinator events (it runs continuously on its own).
  }

  return {
    getStats(): ReaderStats | null { return _st(wid).stats; },
    isRunning(): boolean { return _st(wid).running; },
    isPaused(): boolean { return _st(wid).paused; },
    isContinuous(): boolean { return _st(wid).shouldBeRunning; },

    async start(): Promise<void> {
      const s = _st(wid);
      // Close the async race window: check both running AND starting flags.
      // Without `starting`, two concurrent calls both pass `if (s.running)` before
      // either sets it to true, causing two handlers to be registered simultaneously.
      if (s.running || s.starting) return;
      s.starting = true;

      if (!baileysManager.isConnectedForWorkspace(wid)) {
        s.starting = false;
        throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
      }

      const coord    = getCoordinatorFor(wid);
      const acquired = await coord.acquire("reading");
      if (!acquired) {
        s.starting = false;
        const active = coord.getActive();
        throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
      }

      s.shouldBeRunning = true;
      s.running         = true;
      s.starting        = false;  // fully started — release the race-window lock
      s.paused          = false;
      s.pipelineBuffer  = new Map();
      s.adRatioByGroup  = new Map();
      s.handlerErrors   = 0;
      s.pendingDelta    = { messages: 0, linksFound: 0, linksNew: 0 };

      const [state, totals, totalPipelineRuns] = await Promise.all([
        systemState.get(wid),
        systemState.getReaderTotals(wid),
        systemState.getPipelineRunsTotal(wid),
      ]);
      const lastId = state.last_read_message_id;

      s.stats = {
        status:           "running",
        continuous:       true,
        messagesReceived: 0,
        messagesFromAds:  0,
        linksFound:       0,
        linksNew:         0,
        startedAt:        new Date().toISOString(),
        pipelineRuns:     0,
        pipelineSkipped:  0,
        bufferSize:       0,
        lastMessageId:    lastId ?? undefined,
        totalMessages:    totals.messages,
        totalLinksFound:  totals.linksFound,
        totalLinksNew:    totals.linksNew,
        totalPipelineRuns,
      };

      await systemState.setActiveFunction(wid, "reading");
      await systemState.setReaderContinuous(wid, true);
      console.log(`[MessageReader:${wid}] Started — continuous mode — checkpoint: ${lastId ?? "none"}`);

      const self = getMessageReaderFor(wid);
      baileysManager.setMessageHandlerForWorkspace(wid, async (msgs: any[]) => {
        for (const msg of msgs) {
          if (!s.running) break;
          await self._handleMessage(msg);
        }
      });
    },

    pause(): void {
      const s = _st(wid);
      if (!s.running) return;
      s.paused = true;
      if (s.stats) { s.stats.status = "paused"; s.stats.pausedAt = new Date().toISOString(); }
      console.log(`[MessageReader:${wid}] Paused`);
    },

    resume(): void {
      const s = _st(wid);
      if (!s.shouldBeRunning) return;
      s.paused = false;
      if (s.stats && s.running) { s.stats.status = "running"; s.stats.pausedAt = undefined; }
      console.log(`[MessageReader:${wid}] Resumed`);
    },

    async stop(): Promise<void> {
      const s = _st(wid);
      s.shouldBeRunning = false;
      s.paused          = false;
      if (s.pipelineDebounce) { clearTimeout(s.pipelineDebounce); s.pipelineDebounce = null; }
      s.running = false;
      baileysManager.clearMessageHandlerForWorkspace(wid);
      if (s.stats) { s.stats.status = "stopped"; s.stats.continuous = false; s.stats.stoppedAt = new Date().toISOString(); }
      // Explicitly release the reading track (not the heavy track) even when joining is active
      getCoordinatorFor(wid).release("reading");
      await Promise.all([
        systemState.setActiveFunction(wid, null),
        systemState.setReaderContinuous(wid, false),
        _flushDelta(wid),
      ]);
      console.log(`[MessageReader:${wid}] Stopped — session messages: ${s.stats?.messagesReceived ?? 0}, total: ${s.stats?.totalMessages ?? 0}, new links: ${s.stats?.linksNew ?? 0}`);
    },

    async autoStartIfEnabled(): Promise<void> {
      try {
        const enabled = await systemState.getReaderContinuous(wid);
        const s       = _st(wid);
        // NOTE: coord.isRunning() check intentionally removed — reading is fully independent
        // and must auto-resume even when joining/publishing/leaving is active.
        if (!enabled || s.running) return;
        await getMessageReaderFor(wid).start();
        console.log(`[MessageReader:${wid}] Auto-started on WhatsApp connect`);
      } catch (err) {
        console.warn(`[MessageReader:${wid}] Auto-start skipped:`, (err as Error).message);
      }
    },

    async _handleMessage(msg: any): Promise<void> {
      const s = _st(wid);
      try {
        // If paused, silently drop (we still receive but don't process)
        if (s.paused) return;

        const jid: string = msg.key?.remoteJid ?? "";
        if (!jid.endsWith("@g.us")) return;

        const text: string =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          msg.message?.imageMessage?.caption ??
          msg.message?.videoMessage?.caption ?? "";

        if (!text.trim()) return;
        if (s.stats) s.stats.messagesReceived++;
        s.pendingDelta.messages++;

        // Log every 10th message to prove real traffic (not just UI illusion)
        if (s.stats && s.stats.messagesReceived % 10 === 1) {
          console.log(`[MessageReader:${wid}] 📩 Real msg #${s.stats.messagesReceived} (total: ${(s.stats.totalMessages ?? 0) + s.pendingDelta.messages}) from group ${jid.split("@")[0].slice(-6)}`);
        }

        const embeddedLinks = extractGroupLinks(text);
        const cls           = classifyMessage(text, embeddedLinks.whatsapp);

        // Track ad messages (don't skip — extract links and flag them as ad-source)
        if (cls.isAd) {
          if (s.stats) s.stats.messagesFromAds++;
        }

        // Per-group ad-ratio tracking: detect groups we are IN that are mostly ads
        // and auto-enqueue them in the leave queue when ratio exceeds threshold.
        {
          const grpStats = s.adRatioByGroup.get(jid) ?? { ads: 0, total: 0, enqueued: false };
          grpStats.total++;
          if (cls.isAd) grpStats.ads++;
          s.adRatioByGroup.set(jid, grpStats);

          if (!grpStats.enqueued && grpStats.total >= 10 && grpStats.ads / grpStats.total > 0.7) {
            grpStats.enqueued = true; // prevent duplicate enqueues
            (async () => {
              try {
                const { getLeaveManagerFor } = await import("./leave-manager.js");
                const db  = await (await import("../mongo-auth-state.js")).getDb();
                const rec = await db.collection("Links_Repository").findOne(
                  { workspaceId: wid, groupJid: jid }
                ) as any;
                if (rec?.url) {
                  const ratio = Math.round(grpStats.ads / grpStats.total * 100);
                  await getLeaveManagerFor(wid).enqueue(
                    rec.url,
                    `اكتشاف تلقائي — مجموعة إعلانية (${ratio}% من رسائلها إعلانات)`
                  );
                  console.log(`[MessageReader:${wid}] 📤 مجموعة إعلانية → قائمة المغادرة (${jid.split("@")[0].slice(-6)})`);
                }
              } catch (e) {
                console.warn(`[MessageReader:${wid}] Ad-group enqueue skip:`, (e as Error).message);
              }
            })();
          }
        }

        const allLinks = [...embeddedLinks.whatsapp];
        if (s.stats) s.stats.linksFound += allLinks.length;
        s.pendingDelta.linksFound += allLinks.length;

        for (const url of allLinks) {
          if (s.pipelineBuffer.size >= PIPELINE_BUFFER_CAP) {
            console.log(`[MessageReader:${wid}] Buffer cap (${PIPELINE_BUFFER_CAP}) — flushing early`);
            if (s.pipelineDebounce) clearTimeout(s.pipelineDebounce);
            s.pipelineDebounce = setTimeout(() => _runPipeline(wid), 5_000);
            break;
          }

          const cleanUrl = _cleanLink(url);

          // Only buffer — do NOT write to DB yet.
          // Links are saved to DB only after pipeline validation (checkLinks + NLP filter).
          // This prevents expired/invalid links from polluting the Links_Repository.
          const alreadyInDb     = await linksRepository.exists(wid, cleanUrl);
          const alreadyInBuffer = s.pipelineBuffer.has(cleanUrl);

          if (!alreadyInDb && !alreadyInBuffer) {
            if (s.stats) { s.stats.linksNew++; s.stats.bufferSize = s.pipelineBuffer.size + 1; }
            s.pendingDelta.linksNew++;
            s.pipelineBuffer.set(cleanUrl, { url: cleanUrl, isAdMessage: cls.isAd });
            _schedulePipeline(wid);
          } else if (alreadyInBuffer) {
            // Non-ad message wins over ad classification for same buffered URL
            const existing = s.pipelineBuffer.get(cleanUrl);
            if (existing && existing.isAdMessage && !cls.isAd) {
              s.pipelineBuffer.set(cleanUrl, { url: cleanUrl, isAdMessage: false });
            }
          }
        }

        // Flush delta to MongoDB every FLUSH_EVERY messages (non-blocking)
        if (s.stats && s.stats.messagesReceived % FLUSH_EVERY === 0) {
          _flushDelta(wid).catch(() => {});
        }

        const msgId = msg.key?.id;
        if (msgId) {
          if (s.stats) s.stats.lastMessageId = msgId;
          await systemState.setLastReadMessageId(wid, msgId);
        }

        s.handlerErrors = 0;
      } catch (err) {
        s.handlerErrors++;
        console.warn(`[MessageReader:${wid}] Handler error #${s.handlerErrors}:`, (err as Error).message);
        if (s.handlerErrors >= MAX_HANDLER_ERRORS) {
          console.error(`[MessageReader:${wid}] Too many errors — stopping for safety`);
          await getMessageReaderFor(wid).stop().catch(() => {});
        }
      }
    },
  };
}

const _managerCache = new Map<string, ReturnType<typeof _createManager>>();

export function getMessageReaderFor(workspaceId: string): ReturnType<typeof _createManager> {
  if (!_managerCache.has(workspaceId)) {
    _managerCache.set(workspaceId, _createManager(workspaceId));
  }
  return _managerCache.get(workspaceId)!;
}

/**
 * Manually trigger the pipeline for a workspace, bypassing the debounce timer.
 * Useful for the "Run Pipeline Now" button in the UI.
 * Returns { ok: true } if triggered, or { ok: false, reason } if skipped.
 */
export async function triggerPipelineFor(workspaceId: string): Promise<{ ok: boolean; reason?: string }> {
  const s = _st(workspaceId);

  if (!s.running) {
    return { ok: false, reason: "القارئ متوقف — شغّل القراءة أولاً" };
  }
  if (s.pipelineLock) {
    return { ok: false, reason: "Pipeline يعمل حالياً — انتظر اكتماله" };
  }
  if (s.pipelineBuffer.size === 0) {
    return { ok: false, reason: "لا توجد روابط في المخزن المؤقت حالياً" };
  }

  // Cancel any pending debounce and run immediately
  if (s.pipelineDebounce) {
    clearTimeout(s.pipelineDebounce);
    s.pipelineDebounce = null;
  }

  // Run async — don't block the HTTP response
  _runPipeline(workspaceId).catch(err => {
    console.warn(`[Pipeline:${workspaceId}] Manual trigger error:`, (err as Error).message);
  });

  return { ok: true };
}
