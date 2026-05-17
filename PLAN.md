# Link Checker Pro — Master Plan

> Mark each item ✅ when **fully** implemented and tested.  
> Items marked 🔲 are planned but not yet implemented.  
> Items marked ⚠️ are partially done (stub/framework ready).

---

## Phase 0 — Foundation & Architecture

| # | Item | Status | File |
|---|------|--------|------|
| 0.1 | Atomic module file structure under `server/modules/` | ✅ | `server/modules/` |
| 0.2 | Export `getDb()` from `mongo-auth-state.ts` for shared use | ✅ | `server/mongo-auth-state.ts` |
| 0.3 | `function-coordinator.ts` — one function runs, others block | ✅ | `server/modules/function-coordinator.ts` |
| 0.4 | `human-mimicry.ts` — all delays random, no fixed timing | ✅ | `server/modules/human-mimicry.ts` |
| 0.5 | MongoDB module init called at server startup with recovery | ✅ | `server/index.ts` |
| 0.6 | PLAN.md created and maintained | ✅ | `PLAN.md` |

---

## Phase 1 — Link Filtering (Personal vs Group)

| # | Item | Status | File |
|---|------|--------|------|
| 1.1 | `link-filter.ts` — `classifyWhatsAppLink()` categorizes every WA URL | ✅ | `server/modules/link-filter.ts` |
| 1.2 | `isGroupOrChannel()` helper for quick filtering | ✅ | `server/modules/link-filter.ts` |
| 1.3 | Updated `WA_GROUP_REGEX` — only captures `chat.whatsapp.com/` and `whatsapp.com/channel/` | ✅ | `server/modules/link-filter.ts` |
| 1.4 | Fix `WA_REGEX` in `server/link-store.ts` — exclude `wa.me/phone`, `wa.me/message/`, `api.whatsapp.com/send` | ✅ | `server/link-store.ts` |
| 1.5 | Fix `waRegex` in `server/routes.ts` — same exclusions applied to upload extraction | ✅ | `server/routes.ts` |
| 1.6 | Channel links (`whatsapp.com/channel/CODE`) now extracted | ✅ | `server/link-store.ts`, `server/routes.ts` |
| 1.7 | Community links: detected at join time via Baileys error → alternate join path | ✅ | `server/modules/join-manager.ts` |

---

## Phase 2 — MongoDB Collections

| # | Item | Status | File |
|---|------|--------|------|
| 2.1 | `Links_Repository` collection — all links, type, status | ✅ | `server/modules/links-repository.ts` |
| 2.2 | `Links_Repository` indexes (url unique, status+type) | ✅ | `server/modules/links-repository.ts` |
| 2.3 | `addIfNew()` — prevents duplicate links across all rounds | ✅ | `server/modules/links-repository.ts` |
| 2.4 | `setStatus()` — Pending → Joined / Ignored / Left | ✅ | `server/modules/links-repository.ts` |
| 2.5 | `findByStatus()`, `findJoined()`, `findPendingForJoin()` | ✅ | `server/modules/links-repository.ts` |
| 2.6 | `System_State` collection — is_running, active_function, last_read_message_id | ✅ | `server/modules/system-state.ts` |
| 2.7 | `checkRecovery()` — detects interrupted functions on restart | ✅ | `server/modules/system-state.ts` |
| 2.8 | `last_read_message_id` persisted for resumable message reading | ✅ | `server/modules/system-state.ts` |
| 2.9 | `last_published_ad_index` persisted for resumable publishing | ✅ | `server/modules/system-state.ts` |
| 2.10 | `Keywords_Config` collection — stores user ad messages | ✅ | `server/modules/publisher.ts` |
| 2.11 | `LeavingQueue` collection — groups queued for leaving | ✅ | `server/modules/leave-manager.ts` |
| 2.12 | `groupJid` field saved on Links_Repository after joining | ✅ | `server/modules/join-manager.ts` |
| 2.13 | Links found in messages saved to Links_Repository (source: "message") | ✅ | `server/modules/message-reader.ts` |
| 2.14 | API routes for Links_Repository CRUD | ✅ | `server/routes.ts` |

---

## Phase 3 — Function Isolation

| # | Item | Status | File |
|---|------|--------|------|
| 3.1 | `FunctionCoordinator` class with acquire/release mutex | ✅ | `server/modules/function-coordinator.ts` |
| 3.2 | `coordinator.acquire()` blocks second function if one is running | ✅ | `server/modules/function-coordinator.ts` |
| 3.3 | State persisted to MongoDB `System_State.active_function` | ✅ | `server/modules/system-state.ts` |
| 3.4 | Publisher uses coordinator | ✅ | `server/modules/publisher.ts` |
| 3.5 | Message reader uses coordinator | ✅ | `server/modules/message-reader.ts` |
| 3.6 | Join manager uses coordinator | ✅ | `server/modules/join-manager.ts` |
| 3.7 | Leave manager uses coordinator | ✅ | `server/modules/leave-manager.ts` |
| 3.8 | Frontend shows "another function is running" error message | ✅ | `client/src/pages/home.tsx` |
| 3.9 | Frontend sidebar shows coordinator status panel | ✅ | `client/src/pages/home.tsx` |

---

## Phase 4 — NLP Ad Classifier

| # | Item | Status | File |
|---|------|--------|------|
| 4.1 | `nlp-classifier.ts` — cost-free heuristic classifier | ✅ | `server/modules/nlp-classifier.ts` |
| 4.2 | `classifyMessage()` — link density + text length + keywords + phone + emoji | ✅ | `server/modules/nlp-classifier.ts` |
| 4.3 | `classifyGroup()` — analyze message history to classify group nature | ✅ | `server/modules/nlp-classifier.ts` |
| 4.4 | Ad signals: link density >8%, message length >400 chars, phone numbers, ad keywords | ✅ | `server/modules/nlp-classifier.ts` |
| 4.5 | Group nature: "normal" / "ads" / "mixed" based on ad ratio | ✅ | `server/modules/nlp-classifier.ts` |
| 4.6 | NLP classifier integrated into message reader (skip ad messages) | ✅ | `server/modules/message-reader.ts` |
| 4.7 | NLP classifier skips ad messages from groups being read | ✅ | `server/modules/message-reader.ts` |

---

## Phase 5 — Publisher (Send Ads to Groups)

| # | Item | Status | File |
|---|------|--------|------|
| 5.1 | Publisher framework: coordinator lock, state, progress callback | ✅ | `server/modules/publisher.ts` |
| 5.2 | `addAd()` / `removeAd()` / `listAds()` in MongoDB Keywords_Config | ✅ | `server/modules/publisher.ts` |
| 5.3 | Random group order (shuffle on each run) | ✅ | `server/modules/publisher.ts` |
| 5.4 | Human mimicry delays between sends | ✅ | `server/modules/publisher.ts` |
| 5.5 | **Baileys `sendTextMessage()` integration** (real send via socket) | ✅ | `server/baileys-manager.ts`, `server/modules/publisher.ts` |
| 5.6 | API: `GET/POST /api/publisher/ads`, `DELETE /api/publisher/ads/:id` | ✅ | `server/routes.ts` |
| 5.7 | API: `POST /api/publisher/start`, `POST /api/publisher/stop`, `GET /api/publisher/progress` | ✅ | `server/routes.ts` |
| 5.8 | Error handling via `wa-error-handler.ts` (stop_all on account threat) | ✅ | `server/modules/publisher.ts` |
| 5.9 | Resumable: restarts from `last_published_ad_index` in System_State | ✅ | `server/modules/publisher.ts` |
| 5.10 | Frontend UI: ad management panel + start/stop + progress | ✅ | `client/src/pages/home.tsx` |

---

## Phase 6 — Message Reader

| # | Item | Status | File |
|---|------|--------|------|
| 6.1 | Message reader framework: coordinator, state, stats | ✅ | `server/modules/message-reader.ts` |
| 6.2 | NLP integration: skip ad messages, only process normal messages | ✅ | `server/modules/message-reader.ts` |
| 6.3 | Extracted links saved to Links_Repository with source="message" | ✅ | `server/modules/message-reader.ts` |
| 6.4 | **Baileys `messages.upsert` event integration** (real-time) | ✅ | `server/baileys-manager.ts`, `server/modules/message-reader.ts` |
| 6.5 | `setMessageHandler()` / `clearMessageHandler()` on baileysManager | ✅ | `server/baileys-manager.ts` |
| 6.6 | Handler auto-attached to new sockets in `_connectSession()` | ✅ | `server/baileys-manager.ts` |
| 6.7 | `last_read_message_id` updated in System_State for crash recovery | ✅ | `server/modules/message-reader.ts` |
| 6.8 | API: `POST /api/reader/start`, `POST /api/reader/stop`, `GET /api/reader/stats` | ✅ | `server/routes.ts` |
| 6.9 | Frontend UI: start/stop reader, live stats panel | ✅ | `client/src/pages/home.tsx` |

---

## Phase 7 — Join Manager

| # | Item | Status | File |
|---|------|--------|------|
| 7.1 | `join-manager.ts` atomic module | ✅ | `server/modules/join-manager.ts` |
| 7.2 | Coordinator lock (one function at a time) | ✅ | `server/modules/join-manager.ts` |
| 7.3 | Only joins Pending links from Links_Repository | ✅ | `server/modules/join-manager.ts` |
| 7.4 | Community detection: falls back to `joinCommunity()` if needed | ✅ | `server/modules/join-manager.ts`, `server/baileys-manager.ts` |
| 7.5 | Status update: Pending → Joined / Ignored on result | ✅ | `server/modules/join-manager.ts` |
| 7.6 | Human mimicry: gaussian delays, batch rests every 25–35 joins | ✅ | `server/modules/join-manager.ts` |
| 7.7 | Channel links (whatsapp.com/channel) skipped with reason logged | ✅ | `server/modules/join-manager.ts` |
| 7.8 | All errors routed through `wa-error-handler.ts` | ✅ | `server/modules/join-manager.ts` |
| 7.9 | `groupJid` saved to Links_Repository after successful join | ✅ | `server/modules/join-manager.ts` |
| 7.10 | Low-level `joinGroup()` / `joinCommunity()` added to baileysManager | ✅ | `server/baileys-manager.ts` |
| 7.11 | API: `POST /api/join/start`, `POST /api/join/stop`, `GET /api/join/progress` | ✅ | `server/routes.ts` |
| 7.12 | Frontend join progress panel | ✅ | `client/src/pages/home.tsx` |

---

## Phase 8 — Leave Manager (LeavingQueue)

| # | Item | Status | File |
|---|------|--------|------|
| 8.1 | `leave-manager.ts` atomic module | ✅ | `server/modules/leave-manager.ts` |
| 8.2 | `LeavingQueue` MongoDB collection with unique index on URL | ✅ | `server/modules/leave-manager.ts` |
| 8.3 | `enqueue()` / `dequeue()` / `listQueue()` | ✅ | `server/modules/leave-manager.ts` |
| 8.4 | `processQueue()` with coordinator lock | ✅ | `server/modules/leave-manager.ts` |
| 8.5 | Status update: Joined → Left after leaving | ✅ | `server/modules/leave-manager.ts` |
| 8.6 | Human mimicry delays before each leave | ✅ | `server/modules/leave-manager.ts` |
| 8.7 | "Already left" / "not a member" handled gracefully (mark Left anyway) | ✅ | `server/modules/leave-manager.ts` |
| 8.8 | Low-level `leaveGroup()` added to baileysManager | ✅ | `server/baileys-manager.ts` |
| 8.9 | API: `GET /api/leave/queue`, `POST /api/leave/enqueue`, `DELETE /api/leave/dequeue`, `POST /api/leave/start`, `POST /api/leave/stop`, `GET /api/leave/progress` | ✅ | `server/routes.ts` |
| 8.10 | Frontend leave queue panel | ✅ | `client/src/pages/home.tsx` |

---

## Phase 9 — Error Handling & Resilience

| # | Item | Status | File |
|---|------|--------|------|
| 9.1 | All functions wrapped in try/finally to always release coordinator | ✅ | All modules |
| 9.2 | System_State recovery on server restart (clears stale lock) | ✅ | `server/modules/system-state.ts` |
| 9.3 | MongoDB connection failure: graceful fallback, warning logged | ✅ | `server/index.ts` |
| 9.4 | `wa-error-handler.ts` — single classifier for ALL WA errors | ✅ | `server/modules/wa-error-handler.ts` |
| 9.5 | `403 Forbidden` / `404 Not Found` / expired invite → `skip` → mark Ignored | ✅ | `server/modules/wa-error-handler.ts` |
| 9.6 | `409 Conflict` (already member) → `already_member` → mark Joined | ✅ | `server/modules/wa-error-handler.ts` |
| 9.7 | `421 Resource Limit` → `stop_join` — HALT joining, wait 15 minutes | ✅ | `server/modules/wa-error-handler.ts` |
| 9.8 | **"Unable to access group information" / "unable to join"** → `stop_join` | ✅ | `server/modules/wa-error-handler.ts` |
| 9.9 | **"Unable to join" repeated** → stops loop, waits before resuming | ✅ | `server/modules/join-manager.ts` |
| 9.10 | `429 Rate Limit` → `wait_and_retry`, exponential backoff (1→2→4→8→15 min) | ✅ | `server/modules/wa-error-handler.ts` |
| 9.11 | `408 Timeout` / `500` / `503` → `retry`, max 3 retries | ✅ | `server/modules/wa-error-handler.ts` |
| 9.12 | **Account ban / temporarily blocked** → `stop_all` — halts EVERYTHING | ✅ | `server/modules/wa-error-handler.ts` |
| 9.13 | `401 Unauthorized` → `stop_all` (account session revoked) | ✅ | `server/modules/wa-error-handler.ts` |
| 9.14 | 10+ consecutive failures → escalate to `stop_all` | ✅ | `server/modules/wa-error-handler.ts` |
| 9.15 | 5+ consecutive failures in join loop → `stop_join` with 5-min pause | ✅ | `server/modules/wa-error-handler.ts` |
| 9.16 | Community invite code → `community` action → `joinCommunity()` fallback | ✅ | `server/modules/join-manager.ts` |
| 9.17 | Group full / admin denied / join-denied → `skip` | ✅ | `server/modules/wa-error-handler.ts` |
| 9.18 | Lost connection mid-join → pause loop, wait for reconnect | ✅ | `server/modules/join-manager.ts` |
| 9.19 | Anti-detection: randomize link order on every run | ✅ | `server/modules/human-mimicry.ts` (`shuffle`) |
| 9.20 | Anti-detection: gaussian delay distribution (not uniform) | ✅ | `server/modules/human-mimicry.ts` |
| 9.21 | All new polling endpoints added to SILENT_POLL_PATHS (no log spam) | ✅ | `server/index.ts` |

---

## Phase 10 — Frontend UI

| # | Item | Status | File |
|---|------|--------|------|
| 10.1 | Coordinator status panel (which function is running) | ✅ | `client/src/pages/home.tsx` |
| 10.2 | Links Repository counts display (Pending / Joined / Ignored / Left) | ✅ | `client/src/pages/home.tsx` |
| 10.3 | Join manager: start/stop button + live progress | ✅ | `client/src/pages/home.tsx` |
| 10.4 | Leave manager: queue list + enqueue + start processing | ✅ | `client/src/pages/home.tsx` |
| 10.5 | Publisher: ad text input + saved ads list + start/stop + progress | ✅ | `client/src/pages/home.tsx` |
| 10.6 | Message reader: start/stop + live stats (msgs / new links) | ✅ | `client/src/pages/home.tsx` |
| 10.7 | Buttons disabled when any function is running (coordinator check) | ✅ | `client/src/pages/home.tsx` |

---

## Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Foundation & Architecture | ✅ Complete |
| 1 | Link Filtering (personal vs group) | ✅ Complete |
| 2 | MongoDB Collections | ✅ Complete |
| 3 | Function Isolation | ✅ Complete |
| 4 | NLP Ad Classifier | ✅ Complete |
| 5 | Publisher (send ads) | ✅ Complete |
| 6 | Message Reader (real-time) | ✅ Complete |
| 7 | Join Manager | ✅ Complete |
| 8 | Leave Manager | ✅ Complete |
| 9 | Error Handling & Resilience | ✅ Complete |
| 10 | Frontend UI | ✅ Complete |
