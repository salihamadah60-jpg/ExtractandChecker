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

export interface ReaderStats {
  status: "running" | "stopped" | "paused" | "error";
  continuous:           boolean;
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
}

// ── Per-workspace state ────────────────────────────────────────────────────────

const PIPELINE_DEBOUNCE_MS  = 45_000;
const PIPELINE_BUFFER_CAP   = 30;
const PIPELINE_MIN_INTERVAL = 10 * 60_000;
const MAX_HANDLER_ERRORS    = 10;

interface BufferEntry { url: string; isAdMessage: boolean; }

interface WState {
  stats:              ReaderStats | null;
  running:            boolean;
  paused:             boolean;
  shouldBeRunning:    boolean;
  pipelineBuffer:     Map<string, BufferEntry>;  // url → entry (non-ad wins)
  pipelineLock:       boolean;
  pipelineDebounce:   ReturnType<typeof setTimeout> | null;
  lastPipelineRun:    number;
  handlerErrors:      number;
}

const _stateByWid = new Map<string, WState>();

function _st(wid: string): WState {
  if (!_stateByWid.has(wid)) {
    _stateByWid.set(wid, {
      stats:           null,
      running:         false,
      paused:          false,
      shouldBeRunning: false,
      pipelineBuffer:  new Map(),
      pipelineLock:    false,
      pipelineDebounce: null,
      lastPipelineRun: 0,
      handlerErrors:   0,
    });
  }
  return _stateByWid.get(wid)!;
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

  if (coord.isRunning()) {
    console.log(`[Pipeline:${wid}] Coordinator busy (${coord.getActive()}) — deferred`);
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
    // 1. Pause reader
    s.running = false;
    baileysManager.clearMessageHandlerForWorkspace(wid);
    coord.release();
    await systemState.setActiveFunction(wid, null);
    if (s.stats) { s.stats.status = "stopped"; s.stats.stoppedAt = new Date().toISOString(); s.stats.pausedAt = new Date().toISOString(); }
    console.log(`[Pipeline:${wid}] Reader paused`);

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
    //     • came from an ad message (NLP flagged)                → ad
    //     • everything else with members > 10                    → group
    const groups = validGroups
      .filter((r) => {
        const m = r.members ?? 0;
        if (m <= 10) return false;
        if (isAdOnlyMedicalGroup(r.name, r.description)) return false;
        const entry = entries.find(e => _cleanLink(e.url) === _cleanLink(r.url));
        if (entry?.isAdMessage) return false;
        return true;
      })
      .map((r) => ({ link: _cleanLink(r.url), name: r.name, members: r.members, description: r.description }));

    const ads = validGroups
      .filter((r) => {
        const m = r.members ?? 0;
        if (m <= 10) return false;
        if (isAdOnlyMedicalGroup(r.name, r.description)) return true;
        const entry = entries.find(e => _cleanLink(e.url) === _cleanLink(r.url));
        return entry?.isAdMessage === true;
      })
      .map((r) => ({ link: _cleanLink(r.url), name: r.name, members: r.members, description: r.description }));

    // 4. Save + trigger join + auto-enqueue ads for leaving
    if (groups.length + ads.length > 0) {
      await linksRepository.saveFilteredLinks(wid, groups, ads);
      console.log(`[Pipeline:${wid}] Saved ${groups.length} groups + ${ads.length} ads`);

      // Auto-enqueue ads into the leave queue
      if (ads.length > 0) {
        try {
          const { getLeaveManagerFor } = await import("./leave-manager.js");
          const lm = getLeaveManagerFor(wid);
          let enqueued = 0;
          for (const ad of ads) {
            const added = await lm.enqueue(ad.link, "ad-auto-detected");
            if (added) enqueued++;
          }
          if (enqueued > 0) {
            console.log(`[Pipeline:${wid}] Auto-enqueued ${enqueued} ad groups for leaving`);
            if (!coord.isRunning()) {
              lm.processQueue().catch((err: Error) =>
                console.warn(`[Pipeline:${wid}] Leave deferred:`, err.message)
              );
            }
          }
        } catch (err) {
          console.warn(`[Pipeline:${wid}] Leave enqueue skip:`, (err as Error).message);
        }
      }

      if (!coord.isRunning()) {
        try {
          const { getJoinManagerFor } = await import("./join-manager.js");
          getJoinManagerFor(wid).start().catch((err: Error) =>
            console.warn(`[Pipeline:${wid}] Join deferred:`, err.message)
          );
        } catch (err) {
          console.warn(`[Pipeline:${wid}] Join skip:`, (err as Error).message);
        }
      }
    } else {
      console.log(`[Pipeline:${wid}] No valid groups — skipping join`);
    }

    if (s.stats) s.stats.pipelineRuns = (s.stats.pipelineRuns ?? 0) + 1;

  } catch (err) {
    console.error(`[Pipeline:${wid}] Error:`, (err as Error).message);
  } finally {
    // 5. Resume reader if still wanted
    if (s.shouldBeRunning && baileysManager.isConnectedForWorkspace(wid) && !coord.isRunning()) {
      try {
        const acquired = await coord.acquire("reading");
        if (acquired) {
          await systemState.setActiveFunction(wid, "reading");
          s.running = true;
          s.paused  = false;
          if (s.stats) { s.stats.status = "running"; s.stats.stoppedAt = undefined; s.stats.pausedAt = undefined; }
          s.handlerErrors = 0;

          const self = getMessageReaderFor(wid);
          baileysManager.setMessageHandlerForWorkspace(wid, async (msgs: any[]) => {
            for (const msg of msgs) {
              if (!s.running) break;
              await self._handleMessage(msg);
            }
          });
          console.log(`[Pipeline:${wid}] Reader resumed`);
        } else {
          console.warn(`[Pipeline:${wid}] Cannot re-acquire coordinator — reader stays paused`);
        }
      } catch (err) {
        console.warn(`[Pipeline:${wid}] Resume error:`, (err as Error).message);
      }
    }
    s.pipelineLock = false;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

const _listenerRegistered = new Set<string>();

function _createManager(wid: string) {
  // Register coordinator "released" listener once per workspace
  if (!_listenerRegistered.has(wid)) {
    _listenerRegistered.add(wid);
    getCoordinatorFor(wid).on("released", () => {
      const s = _st(wid);
      if (!s.shouldBeRunning || s.running || s.pipelineLock) return;
      setTimeout(async () => {
        const s2 = _st(wid);
        if (!s2.shouldBeRunning || s2.running || s2.pipelineLock) return;
        if (!baileysManager.isConnectedForWorkspace(wid)) return;
        try {
          await getMessageReaderFor(wid).start();
          console.log(`[MessageReader:${wid}] Auto-resumed after coordinator released`);
        } catch { /* coordinator may have been re-acquired already */ }
      }, 3_000);
    });
  }

  return {
    getStats(): ReaderStats | null { return _st(wid).stats; },
    isRunning(): boolean { return _st(wid).running; },
    isPaused(): boolean { return _st(wid).paused; },
    isContinuous(): boolean { return _st(wid).shouldBeRunning; },

    async start(): Promise<void> {
      const s = _st(wid);
      if (s.running) return;

      if (!baileysManager.isConnectedForWorkspace(wid)) {
        throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
      }

      const coord   = getCoordinatorFor(wid);
      const acquired = await coord.acquire("reading");
      if (!acquired) {
        const active = coord.getActive();
        throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
      }

      s.shouldBeRunning = true;
      s.running         = true;
      s.paused          = false;
      s.pipelineBuffer  = new Map();
      s.handlerErrors   = 0;

      const state  = await systemState.get(wid);
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
      getCoordinatorFor(wid).release();
      await systemState.setActiveFunction(wid, null);
      await systemState.setReaderContinuous(wid, false);
      console.log(`[MessageReader:${wid}] Stopped — messages: ${s.stats?.messagesReceived ?? 0}, new links: ${s.stats?.linksNew ?? 0}`);
    },

    async autoStartIfEnabled(): Promise<void> {
      try {
        const enabled = await systemState.getReaderContinuous(wid);
        const s       = _st(wid);
        const coord   = getCoordinatorFor(wid);
        if (!enabled || s.running || coord.isRunning()) return;
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

        // Log every 10th message to prove real traffic (not just UI illusion)
        if (s.stats && s.stats.messagesReceived % 10 === 1) {
          console.log(`[MessageReader:${wid}] 📩 Real msg #${s.stats.messagesReceived} from group ${jid.split("@")[0].slice(-6)}`);
        }

        const embeddedLinks = extractGroupLinks(text);
        const cls           = classifyMessage(text, embeddedLinks.whatsapp);

        // Track ad messages (don't skip — extract links and flag them as ad-source)
        if (cls.isAd) {
          if (s.stats) s.stats.messagesFromAds++;
        }

        const allLinks = [...embeddedLinks.whatsapp];
        if (s.stats) s.stats.linksFound += allLinks.length;

        for (const url of allLinks) {
          if (s.pipelineBuffer.size >= PIPELINE_BUFFER_CAP) {
            console.log(`[MessageReader:${wid}] Buffer cap (${PIPELINE_BUFFER_CAP}) — flushing early`);
            if (s.pipelineDebounce) clearTimeout(s.pipelineDebounce);
            s.pipelineDebounce = setTimeout(() => _runPipeline(wid), 5_000);
            break;
          }

          const cleanUrl = _cleanLink(url);

          // Add to DB if new
          const added = await linksRepository.addIfNew(wid, cleanUrl, "Group", "message");
          if (added) {
            if (s.stats) { s.stats.linksNew++; s.stats.bufferSize = s.pipelineBuffer.size + 1; }

            // Non-ad message wins over ad message for same URL
            const existing = s.pipelineBuffer.get(cleanUrl);
            if (!existing || (existing.isAdMessage && !cls.isAd)) {
              s.pipelineBuffer.set(cleanUrl, { url: cleanUrl, isAdMessage: cls.isAd });
            }
            _schedulePipeline(wid);
          }
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
