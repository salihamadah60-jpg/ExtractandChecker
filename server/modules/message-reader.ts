/**
 * message-reader.ts — Real-time message reader (anti-ban hardened)
 *
 * Safety improvements:
 *   1. Pipeline buffer capped at 30 links — prevents flooding join queue
 *   2. Pipeline skips if join session is already running (coordinator busy)
 *   3. Minimum cooldown between consecutive pipeline runs (10 min)
 *   4. Telemetry integrated: pipeline waits if cooldown is active
 *   5. Hard stop on consecutive handler errors (self-healing)
 *   6. Better logging: shows buffer state and pipeline skip reasons
 *   7. Reader resumes only if WhatsApp is still connected AND idle
 */

import { baileysManager }   from "../baileys-manager.js";
import { coordinator }      from "./function-coordinator.js";
import { systemState }      from "./system-state.js";
import { linksRepository }  from "./links-repository.js";
import { classifyMessage }  from "./nlp-classifier.js";
import { extractGroupLinks } from "./link-filter.js";
import { isAdOnlyMedicalGroup } from "../link-store.js";
import { telemetry }        from "./telemetry.js";

export interface ReaderStats {
  status: "running" | "stopped" | "error";
  messagesReceived:    number;
  messagesSkippedAds:  number;
  linksFound:          number;
  linksNew:            number;
  startedAt:           string;
  stoppedAt?:          string;
  lastMessageId?:      string;
  pipelineRuns?:       number;
  pipelineSkipped?:    number;
  bufferSize?:         number;
}

let _stats:   ReaderStats | null = null;
let _running  = false;

// ── Pipeline config ───────────────────────────────────────────────────────────
const PIPELINE_DEBOUNCE_MS   = 45_000;  // wait 45s of inactivity before running
const PIPELINE_BUFFER_CAP    = 30;      // max queued links before forced flush
const PIPELINE_MIN_INTERVAL  = 10 * 60_000; // min 10 min between pipeline runs
const MAX_HANDLER_ERRORS     = 10;      // stop reader after this many consecutive errors

let _pipelineBuffer:   string[] = [];
let _pipelineLock      = false;
let _pipelineDebounce: ReturnType<typeof setTimeout> | null = null;
let _lastPipelineRun   = 0;
let _handlerErrors     = 0;

function _cleanLink(link: string): string {
  try { const u = new URL(link.trim()); return `${u.origin}${u.pathname}`; }
  catch { return link.trim(); }
}

function _schedulePipeline() {
  if (_pipelineDebounce) clearTimeout(_pipelineDebounce);
  _pipelineDebounce = setTimeout(() => _runPipeline(), PIPELINE_DEBOUNCE_MS);
}

/** Run the sequential pipeline: pause reader → check → filter → save → join → resume */
async function _runPipeline(): Promise<void> {
  _pipelineDebounce = null;
  if (_pipelineLock || _pipelineBuffer.length === 0 || !_running) return;

  // ── Guard: skip if coordinator is busy (join session running) ─────────────
  if (coordinator.isRunning()) {
    console.log(`[Pipeline] Coordinator busy (${coordinator.getActive()}) — pipeline deferred`);
    if (_stats) _stats.pipelineSkipped = (_stats.pipelineSkipped ?? 0) + 1;
    // Reschedule — try again in 5 minutes
    _pipelineDebounce = setTimeout(() => _runPipeline(), 5 * 60_000);
    return;
  }

  // ── Guard: minimum interval between pipeline runs ─────────────────────────
  const elapsed = Date.now() - _lastPipelineRun;
  if (_lastPipelineRun > 0 && elapsed < PIPELINE_MIN_INTERVAL) {
    const wait = PIPELINE_MIN_INTERVAL - elapsed;
    console.log(`[Pipeline] Too soon since last run (${Math.round(elapsed / 60_000)} min ago) — waiting ${Math.round(wait / 60_000)} min`);
    if (_stats) _stats.pipelineSkipped = (_stats.pipelineSkipped ?? 0) + 1;
    _pipelineDebounce = setTimeout(() => _runPipeline(), wait);
    return;
  }

  // ── Guard: telemetry cooldown ─────────────────────────────────────────────
  if (telemetry.isCoolingDown()) {
    const wait = telemetry.cooldownRemaining();
    console.log(`[Pipeline] Telemetry cooldown — deferring ${Math.round(wait / 60_000)} min`);
    _pipelineDebounce = setTimeout(() => _runPipeline(), wait + 5000);
    return;
  }

  _pipelineLock = true;

  const linksToCheck = [..._pipelineBuffer];
  _pipelineBuffer    = [];
  if (_stats) _stats.bufferSize = 0;

  console.log(`[Pipeline] Starting — ${linksToCheck.length} buffered links`);

  try {
    // 1. Pause reader — release coordinator
    _running = false;
    baileysManager.clearMessageHandler();
    coordinator.release();
    await systemState.setActiveFunction(null);
    if (_stats) { _stats.status = "stopped"; _stats.stoppedAt = new Date().toISOString(); }
    console.log("[Pipeline] Reader paused");

    _lastPipelineRun = Date.now();

    // 2. Check links
    const checkResults = await baileysManager.checkLinksForPipeline(linksToCheck);

    // 3. Filter
    const validGroups = checkResults.filter(
      (r) => r.status === "valid" && r.url.includes("chat.whatsapp.com")
    );

    const groups = validGroups
      .filter((r) => {
        if (isAdOnlyMedicalGroup(r.name, r.description)) return false;
        const m = r.members ?? 0;
        return m > 150 || (m > 10 && m <= 150 && !r.description?.trim());
      })
      .map((r) => ({ link: _cleanLink(r.url), name: r.name, members: r.members, description: r.description }));

    const ads = validGroups
      .filter((r) => {
        const m = r.members ?? 0;
        if (m <= 10) return false;
        if (isAdOnlyMedicalGroup(r.name, r.description)) return true;
        return m <= 150 && !!r.description?.trim();
      })
      .map((r) => ({ link: _cleanLink(r.url), name: r.name, members: r.members, description: r.description }));

    // 4. Save & trigger join
    if (groups.length + ads.length > 0) {
      await linksRepository.saveFilteredLinks(groups, ads);
      console.log(`[Pipeline] Saved ${groups.length} groups + ${ads.length} ads`);

      // Only trigger join if coordinator is now free
      if (!coordinator.isRunning()) {
        try {
          const { joinManager } = await import("./join-manager.js");
          // Non-blocking: join manager runs the new safe scheduler independently
          joinManager.start().catch((err: Error) =>
            console.warn("[Pipeline] Join manager deferred:", err.message)
          );
          console.log("[Pipeline] Join manager triggered (will run with safe scheduler)");
        } catch (err) {
          console.warn("[Pipeline] Join manager skip:", (err as Error).message);
        }
      } else {
        console.log("[Pipeline] Coordinator busy — join will start when free");
      }
    } else {
      console.log("[Pipeline] No valid groups — skipping join");
    }

    if (_stats) _stats.pipelineRuns = (_stats.pipelineRuns ?? 0) + 1;

  } catch (err) {
    console.error("[Pipeline] Error:", (err as Error).message);
  } finally {
    // 5. Always try to resume reader
    if (baileysManager.isConnected() && !coordinator.isRunning()) {
      try {
        const acquired = await coordinator.acquire("reading");
        if (acquired) {
          await systemState.setActiveFunction("reading");
          _running = true;
          if (_stats) { _stats.status = "running"; _stats.stoppedAt = undefined; }
          _handlerErrors = 0;
          baileysManager.setMessageHandler(async (msgs: any[]) => {
            for (const msg of msgs) {
              if (!_running) break;
              await messageReader._handleMessage(msg);
            }
          });
          console.log("[Pipeline] Reader resumed");
        } else {
          console.warn("[Pipeline] Cannot re-acquire coordinator — reader stays paused");
        }
      } catch (err) {
        console.error("[Pipeline] Resume failed:", (err as Error).message);
      }
    } else {
      console.log("[Pipeline] Reader NOT resumed — WA disconnected or coordinator busy");
    }
    _pipelineLock = false;
  }
}

export const messageReader = {
  getStats(): ReaderStats | null { return _stats; },
  isRunning(): boolean { return _running; },

  async start(): Promise<void> {
    if (!baileysManager.isConnected()) {
      throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
    }

    const acquired = await coordinator.acquire("reading");
    if (!acquired) {
      const active = coordinator.getActive();
      throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
    }

    _running       = true;
    _pipelineBuffer = [];
    _handlerErrors  = 0;
    _stats = {
      status:              "running",
      messagesReceived:    0,
      messagesSkippedAds:  0,
      linksFound:          0,
      linksNew:            0,
      startedAt:           new Date().toISOString(),
      pipelineRuns:        0,
      pipelineSkipped:     0,
      bufferSize:          0,
    };

    await systemState.setActiveFunction("reading");
    console.log("[MessageReader] Started — listening for group messages");

    const state = await systemState.get();
    if (state.last_read_message_id) _stats.lastMessageId = state.last_read_message_id;

    baileysManager.setMessageHandler(async (msgs: any[]) => {
      for (const msg of msgs) {
        if (!_running) break;
        await messageReader._handleMessage(msg);
      }
    });
  },

  async stop(): Promise<void> {
    if (_pipelineDebounce) { clearTimeout(_pipelineDebounce); _pipelineDebounce = null; }
    _running = false;
    baileysManager.clearMessageHandler();
    if (_stats) { _stats.status = "stopped"; _stats.stoppedAt = new Date().toISOString(); }
    coordinator.release();
    await systemState.setActiveFunction(null);
    console.log(`[MessageReader] Stopped — messages: ${_stats?.messagesReceived ?? 0}, new links: ${_stats?.linksNew ?? 0}`);
  },

  async _handleMessage(msg: any): Promise<void> {
    try {
      const jid: string = msg.key?.remoteJid ?? "";
      if (!jid.endsWith("@g.us")) return;

      const text: string =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.imageMessage?.caption ??
        msg.message?.videoMessage?.caption ?? "";

      if (!text.trim()) return;

      if (_stats) _stats.messagesReceived++;

      const embeddedLinks = extractGroupLinks(text);
      const cls = classifyMessage(text, embeddedLinks.whatsapp);
      if (cls.isAd) {
        if (_stats) _stats.messagesSkippedAds++;
        return;
      }

      const allLinks = [...embeddedLinks.whatsapp];
      if (_stats) _stats.linksFound += allLinks.length;

      for (const url of allLinks) {
        // ── Buffer cap: flush early if too many links queued ─────────────
        if (_pipelineBuffer.length >= PIPELINE_BUFFER_CAP) {
          console.log(`[MessageReader] Buffer cap reached (${PIPELINE_BUFFER_CAP}) — flushing early`);
          if (_pipelineDebounce) clearTimeout(_pipelineDebounce);
          _pipelineDebounce = setTimeout(() => _runPipeline(), 5_000);
          break; // stop processing more links from this message
        }

        const added = await linksRepository.addIfNew(url, "Group", "message");
        if (added) {
          if (_stats) { _stats.linksNew++; _stats.bufferSize = (_stats.bufferSize ?? 0) + 1; }
          _pipelineBuffer.push(url);
          _schedulePipeline();
          console.log(`[MessageReader] New link → buffer (${_pipelineBuffer.length}/${PIPELINE_BUFFER_CAP}): ${url}`);
        }
      }

      const msgId = msg.key?.id;
      if (msgId) {
        if (_stats) _stats.lastMessageId = msgId;
        await systemState.setLastReadMessageId(msgId);
      }

      _handlerErrors = 0; // reset on success
    } catch (err) {
      _handlerErrors++;
      console.warn(`[MessageReader] Handler error #${_handlerErrors}:`, (err as Error).message);

      if (_handlerErrors >= MAX_HANDLER_ERRORS) {
        console.error(`[MessageReader] Too many errors (${MAX_HANDLER_ERRORS}) — stopping reader for safety`);
        await messageReader.stop().catch(() => {});
      }
    }
  },
};
