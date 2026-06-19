---
name: User activity tracking — per-workspace
description: Why isUserActive was wrong and how it was fixed; required pattern for join/publish managers.
---

## The rule
Always call `baileysManager.isUserActiveForWorkspace(wid, withinMs)` in join-manager.ts and publisher.ts, never the global `isUserActive()`.

**Why:** The old `_lastUserActivity` was a single global timestamp. If phone A (workspace A) sent a message, workspace B's join manager would pause — completely unrelated. With multiple workspaces connected simultaneously this caused constant false pauses.

**How to apply:** Any new manager that needs to respect user activity must use `isUserActiveForWorkspace(wid)`.

## The content-whitelist filter
`_onMessagesFromSession` must pass THREE guards before recording activity:
1. `fromMe: true` AND not in `_botSentIds`
2. Not a group/broadcast JID (`@g.us`, `@broadcast`, `status@broadcast`)
3. `hasRealContent` — message must contain one of: conversation, extendedTextMessage, imageMessage, videoMessage, audioMessage, documentMessage, stickerMessage, contactMessage, locationMessage, liveLocationMessage, pollCreationMessage, listMessage, buttonsMessage, templateMessage, interactiveMessage, contactsArrayMessage

**Why:** WhatsApp delivers reaction messages, protocol messages (delete/ephemeral), senderKeyDistribution, and multi-device sync echoes all with `fromMe:true`. Without the whitelist these all look like user activity. The `A5*` message ID prefix was a symptom of these meta-messages being wrongly counted.
