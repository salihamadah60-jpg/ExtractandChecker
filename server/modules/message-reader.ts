/**
 * message-reader.ts — Real-time message reader from joined groups
 *
 * Uses Baileys messages.upsert event (real-time push) to receive
 * new messages from all joined groups as they arrive.
 *
 * Features:
 *   - Registers message handler with baileysManager
 *   - Filters: group messages only (JID ends with @g.us)
 *   - NLP classifier: skips advertising messages
 *   - Extracts WhatsApp/Telegram group links from clean messages
 *   - Saves new links to Links_Repository (source: "message")
 *   - Tracks last_read_message_id in System_State for crash recovery
 *   - Coordinator lock: blocks other functions while active
 *   - Sequential pipeline: reader → check → filter → save to DB → join → resume
 */

import { baileysManager } from "../baileys-manager.js";
import { coordinator } from "./function-coordinator.js";
import { systemState } from "./system-state.js";
import { linksRepository } from "./links-repository.js";
import { classifyMessage } from "./nlp-classifier.js";
import { extractGroupLinks } from "./link-filter.js";
import { isAdOnlyMedicalGroup } from "../link-store.js";

export interface ReaderStats {
  status: "running" | "stopped" | "error";
  messagesReceived: number;
  messagesSkippedAds: number;
  linksFound: number;
  linksNew: number;
  startedAt: string;
  stoppedAt?: string;
  lastMessageId?: string;
  pipelineRuns?: number;
}

let _stats: ReaderStats | null = null;
let _running = false;

// ── Pipeline buffer ────────────────────────────────────────────────────────────
// Accumulates newly discovered links between pipeline runs
let _pipelineBuffer: string[] = [];
let _pipelineLock = false;
let _pipelineDebounce: ReturnType<typeof setTimeout> | null = null;
const PIPELINE_DEBOUNCE_MS = 30_000; // trigger pipeline 30s after last new link

function _cleanLink(link: string): string {
  try { const u = new URL(link.trim()); return `${u.origin}${u.pathname}`; }
  catch { return link.trim(); }
}

/** Run the sequential pipeline: pause reader → check → filter → save → join → resume. */
async function _runPipeline(): Promise<void> {
  _pipelineDebounce = null;
  if (_pipelineLock || _pipelineBuffer.length === 0 || !_running) return;
  _pipelineLock = true;

  const linksToCheck = [..._pipelineBuffer];
  _pipelineBuffer = [];

  console.log(`[Pipeline] Starting pipeline with ${linksToCheck.length} buffered links`);

  try {
    // 1. Pause reader — release coordinator so joinManager can later acquire it
    _running = false;
    baileysManager.clearMessageHandler();
    coordinator.release();
    await systemState.setActiveFunction(null);
    if (_stats) {
      _stats.status = "stopped";
      _stats.stoppedAt = new Date().toISOString();
    }
    console.log("[Pipeline] Reader paused");

    // 2. Check links via Baileys (with anti-ban delays)
    const checkResults = await baileysManager.checkLinksForPipeline(linksToCheck);

    // 3. Filter results using same logic as getFilteredSummary
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

    // 4. Save to DB and start join manager if anything was found
    if (groups.length + ads.length > 0) {
      await linksRepository.saveFilteredLinks(groups, ads);
      console.log(`[Pipeline] Saved ${groups.length} groups + ${ads.length} ads to DB`);

      // 5. Trigger join manager (it acquires coordinator internally)
      try {
        const { joinManager } = await import("./join-manager.js");
        await joinManager.start();
        console.log("[Pipeline] Join manager completed");
      } catch (err) {
        console.warn("[Pipeline] Join manager skipped:", (err as Error).message);
      }
    } else {
      console.log("[Pipeline] No valid groups after filtering — skipping join");
    }

    if (_stats) {
      _stats.pipelineRuns = (_stats.pipelineRuns ?? 0) + 1;
    }
  } catch (err) {
    console.error("[Pipeline] Error during pipeline:", (err as Error).message);
  } finally {
    // 6. Always try to resume reader if WhatsApp is still connected
    if (baileysManager.isConnected()) {
      try {
        const acquired = await coordinator.acquire("reading");
        if (acquired) {
          await systemState.setActiveFunction("reading");
          _running = true;
          if (_stats) {
            _stats.status = "running";
            _stats.stoppedAt = undefined;
          }
          baileysManager.setMessageHandler(async (msgs: any[]) => {
            for (const msg of msgs) {
              if (!_running) break;
              await messageReader._handleMessage(msg);
            }
          });
          console.log("[Pipeline] Reader resumed after pipeline");
        } else {
          console.warn("[Pipeline] Could not re-acquire coordinator — reader not resumed");
        }
      } catch (err) {
        console.error("[Pipeline] Failed to resume reader:", (err as Error).message);
      }
    }
    _pipelineLock = false;
  }
}

export const messageReader = {
  getStats(): ReaderStats | null {
    return _stats;
  },

  isRunning(): boolean {
    return _running;
  },

  /** Start listening for messages from all joined groups. */
  async start(): Promise<void> {
    if (!baileysManager.isConnected()) {
      throw new Error("واتساب غير متصل. يُرجى الاتصال أولاً.");
    }

    const acquired = await coordinator.acquire("reading");
    if (!acquired) {
      const active = coordinator.getActive();
      throw new Error(`لا يمكن البدء — وظيفة "${active}" تعمل حالياً.`);
    }

    _running = true;
    _pipelineBuffer = [];
    _stats = {
      status: "running",
      messagesReceived: 0,
      messagesSkippedAds: 0,
      linksFound: 0,
      linksNew: 0,
      startedAt: new Date().toISOString(),
      pipelineRuns: 0,
    };

    await systemState.setActiveFunction("reading");
    console.log("[MessageReader] Started — listening for group messages");

    // Get last processed message ID from System_State for recovery
    const state = await systemState.get();
    if (state.last_read_message_id) {
      _stats.lastMessageId = state.last_read_message_id;
    }

    // Register the real-time message handler with baileysManager
    baileysManager.setMessageHandler(async (msgs: any[]) => {
      for (const msg of msgs) {
        if (!_running) break;
        await messageReader._handleMessage(msg);
      }
    });
  },

  /** Stop listening for messages. */
  async stop(): Promise<void> {
    // Cancel any pending pipeline
    if (_pipelineDebounce) {
      clearTimeout(_pipelineDebounce);
      _pipelineDebounce = null;
    }

    _running = false;
    baileysManager.clearMessageHandler();

    if (_stats) {
      _stats.status = "stopped";
      _stats.stoppedAt = new Date().toISOString();
    }

    coordinator.release();
    await systemState.setActiveFunction(null);
    console.log(
      `[MessageReader] Stopped — messages: ${_stats?.messagesReceived ?? 0}, new links: ${_stats?.linksNew ?? 0}`
    );
  },

  /** Internal: process a single Baileys message object. */
  async _handleMessage(msg: any): Promise<void> {
    try {
      // Only process group messages (JID ends with @g.us)
      const jid: string = msg.key?.remoteJid ?? "";
      if (!jid.endsWith("@g.us")) return;

      // Extract text content
      const text: string =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.imageMessage?.caption ??
        msg.message?.videoMessage?.caption ??
        "";

      if (!text.trim()) return;

      if (_stats) _stats.messagesReceived++;

      // NLP: skip ad messages
      const embeddedLinks = extractGroupLinks(text);
      const cls = classifyMessage(text, embeddedLinks.whatsapp);
      if (cls.isAd) {
        if (_stats) _stats.messagesSkippedAds++;
        return;
      }

      // Extract group/channel links from the clean message
      const allLinks = [...embeddedLinks.whatsapp];
      if (_stats) _stats.linksFound += allLinks.length;

      for (const url of allLinks) {
        const added = await linksRepository.addIfNew(url, "Group", "message");
        if (added) {
          if (_stats) _stats.linksNew++;
          // Add to pipeline buffer and schedule debounced pipeline run
          _pipelineBuffer.push(url);
          if (_pipelineDebounce) clearTimeout(_pipelineDebounce);
          _pipelineDebounce = setTimeout(() => _runPipeline(), PIPELINE_DEBOUNCE_MS);
          console.log(`[MessageReader] New link → buffer (${_pipelineBuffer.length}): ${url}`);
        }
      }

      // Save last message ID for crash recovery
      const msgId = msg.key?.id;
      if (msgId) {
        if (_stats) _stats.lastMessageId = msgId;
        await systemState.setLastReadMessageId(msgId);
      }
    } catch (err) {
      console.warn("[MessageReader] Error processing message:", (err as Error).message);
    }
  },
};
