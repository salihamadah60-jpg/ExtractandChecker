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
 */

import { baileysManager } from "../baileys-manager.js";
import { coordinator } from "./function-coordinator.js";
import { systemState } from "./system-state.js";
import { linksRepository } from "./links-repository.js";
import { classifyMessage } from "./nlp-classifier.js";
import { extractGroupLinks } from "./link-filter.js";

export interface ReaderStats {
  status: "running" | "stopped" | "error";
  messagesReceived: number;
  messagesSkippedAds: number;
  linksFound: number;
  linksNew: number;
  startedAt: string;
  stoppedAt?: string;
  lastMessageId?: string;
}

let _stats: ReaderStats | null = null;
let _running = false;

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
    _stats = {
      status: "running",
      messagesReceived: 0,
      messagesSkippedAds: 0,
      linksFound: 0,
      linksNew: 0,
      startedAt: new Date().toISOString(),
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
          console.log(`[MessageReader] New link found: ${url}`);
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
