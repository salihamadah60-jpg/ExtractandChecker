/**
 * message-reader.ts — Read messages from joined groups and extract links
 *
 * - Iterates over all Joined groups in Links_Repository
 * - Fetches messages via Baileys
 * - Classifies messages (ad vs normal) using NLP
 * - Extracts WhatsApp/Telegram links from non-ad messages
 * - Saves extracted links back to Links_Repository (source: "message")
 * - Tracks last_read_message_id in System_State for resumability
 * - Blocked if another function is running (function-coordinator)
 *
 * Status: STUB — framework ready, Baileys message fetch integration pending
 */

import { coordinator } from "./function-coordinator.js";
import { systemState } from "./system-state.js";
import { linksRepository } from "./links-repository.js";
import { classifyMessage } from "./nlp-classifier.js";
import { extractGroupLinks } from "./link-filter.js";
import { DELAYS } from "./human-mimicry.js";

export interface ReadProgress {
  groupsTotal: number;
  groupsDone: number;
  messagesRead: number;
  linksFound: number;
  adsSkipped: number;
  currentGroup?: string;
}

export const messageReader = {
  /**
   * Start reading messages from all joined groups.
   *
   * STUB: Baileys fetchMessages integration is pending.
   * See TODO comment below.
   */
  async start(
    onProgress?: (p: ReadProgress) => void
  ): Promise<ReadProgress> {
    const acquired = await coordinator.acquire("reading");
    if (!acquired) {
      throw new Error("وظيفة أخرى تعمل حالياً. يُرجى الانتظار حتى تنتهي.");
    }

    const progress: ReadProgress = {
      groupsTotal: 0,
      groupsDone: 0,
      messagesRead: 0,
      linksFound: 0,
      adsSkipped: 0,
    };

    try {
      await systemState.setActiveFunction("reading");
      const state = await systemState.get();
      const lastId = state.last_read_message_id;

      const joinedGroups = await linksRepository.findJoined();
      progress.groupsTotal = joinedGroups.length;

      if (!joinedGroups.length) {
        console.log("[MessageReader] No joined groups to read from");
        return progress;
      }

      for (const group of joinedGroups) {
        progress.currentGroup = group.url;
        onProgress?.(progress);

        // TODO: Integrate Baileys fetchGroupMessages here:
        // const inviteCode = group.url.split("/").pop()!;
        // const groupId = await baileysManager.resolveGroupId(inviteCode);
        // const messages = await baileysManager.fetchMessages(groupId, { since: lastId });

        // STUB: simulate empty message list
        const messages: string[] = [];
        console.log(`[MessageReader] STUB: would read from ${group.url}`);

        for (const text of messages) {
          progress.messagesRead++;

          // NLP classification — skip ad messages
          const embeddedLinks = extractGroupLinks(text);
          const cls = classifyMessage(text, embeddedLinks.whatsapp);
          if (cls.isAd) {
            progress.adsSkipped++;
            continue;
          }

          // Extract links and save to repository
          for (const url of embeddedLinks.whatsapp) {
            const added = await linksRepository.addIfNew(url, "Group", "message");
            if (added) progress.linksFound++;
          }

          await DELAYS.betweenGroupReads();
        }

        progress.groupsDone++;
        await DELAYS.betweenGroupReads();
      }

      return progress;
    } finally {
      coordinator.release();
      await systemState.setActiveFunction(null);
    }
  },
};
