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
| 1.6 | Channel links (`whatsapp.com/channel/CODE`) now extracted (were missing before) | ✅ | `server/link-store.ts`, `server/routes.ts` |
| 1.7 | Community links: detected by Baileys at join time (look like groups) | 🔲 | `server/modules/join-manager.ts` (planned) |

**What is excluded (personal contacts):**
- `wa.me/+9627XXXXXXX` — direct phone number
- `wa.me/9647XXXXXXX` — phone without +
- `wa.me/message/CODE` — personal contact page
- `wa.me/qr/CODE` — QR contact link
- `api.whatsapp.com/send?phone=...` — API direct message

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
| 2.11 | `groupsLinks` collection (separate from Links_Repository) | 🔲 | Planned — may merge with Links_Repository (type=Group) |
| 2.12 | `adLinks` collection | 🔲 | Planned — may merge with Links_Repository (type=Channel) |
| 2.13 | `ExtractedLinks` collection — links found in messages/descriptions | 🔲 | Planned — use `source: "message"` in Links_Repository |
| 2.14 | API routes for Links_Repository CRUD | 🔲 | `server/routes.ts` |

---

## Phase 3 — Function Isolation

| # | Item | Status | File |
|---|------|--------|------|
| 3.1 | `FunctionCoordinator` class with acquire/release mutex | ✅ | `server/modules/function-coordinator.ts` |
| 3.2 | `coordinator.acquire()` blocks second function if one is running | ✅ | `server/modules/function-coordinator.ts` |
| 3.3 | State persisted to MongoDB `System_State.active_function` | ✅ | `server/modules/system-state.ts` |
| 3.4 | Publisher uses coordinator | ✅ | `server/modules/publisher.ts` |
| 3.5 | Message reader uses coordinator | ✅ | `server/modules/message-reader.ts` |
| 3.6 | Join manager uses coordinator | 🔲 | `server/modules/join-manager.ts` (planned) |
| 3.7 | Leave manager uses coordinator | 🔲 | `server/modules/leave-manager.ts` (planned) |
| 3.8 | Frontend shows "another function is running" error message | 🔲 | `client/src/pages/home.tsx` |
| 3.9 | Frontend sidebar buttons disabled while any function is active | 🔲 | `client/src/pages/home.tsx` |

---

## Phase 4 — NLP Ad Classifier

| # | Item | Status | File |
|---|------|--------|------|
| 4.1 | `nlp-classifier.ts` — cost-free heuristic classifier | ✅ | `server/modules/nlp-classifier.ts` |
| 4.2 | `classifyMessage()` — link density + text length + keywords + phone + emoji | ✅ | `server/modules/nlp-classifier.ts` |
| 4.3 | `classifyGroup()` — analyze message history to classify group nature | ✅ | `server/modules/nlp-classifier.ts` |
| 4.4 | Ad signals: link density >8%, message length >400 chars, phone numbers, ad keywords | ✅ | `server/modules/nlp-classifier.ts` |
| 4.5 | Group nature: "normal" / "ads" / "mixed" based on ad ratio | ✅ | `server/modules/nlp-classifier.ts` |
| 4.6 | Integrate NLP classifier into message reader (skip ad messages) | ✅ | `server/modules/message-reader.ts` |
| 4.7 | Integrate NLP classifier into join manager (skip ad groups) | 🔲 | `server/modules/join-manager.ts` (planned) |
| 4.8 | Expose group classification result in filtered summary API | 🔲 | `server/routes.ts` |

---

## Phase 5 — Publisher (Send Ads to Groups)

| # | Item | Status | File |
|---|------|--------|------|
| 5.1 | Publisher framework: coordinator lock, state, progress callback | ✅ | `server/modules/publisher.ts` |
| 5.2 | `addAd()` / `removeAd()` / `listAds()` in MongoDB Keywords_Config | ✅ | `server/modules/publisher.ts` |
| 5.3 | Random ad rotation (shuffle on each run, no fixed order) | ✅ | `server/modules/publisher.ts` |
| 5.4 | Human mimicry delays between sends | ✅ | `server/modules/publisher.ts` |
| 5.5 | **Baileys `sendMessage()` integration** (actual send to groups) | 🔲 | `server/modules/publisher.ts` |
| 5.6 | API routes: `POST /api/publisher/ads`, `DELETE /api/publisher/ads/:id`, `GET /api/publisher/ads` | 🔲 | `server/routes.ts` |
| 5.7 | API routes: `POST /api/publisher/start`, `POST /api/publisher/stop` | 🔲 | `server/routes.ts` |
| 5.8 | Frontend UI: input field for ad messages, list of saved ads, start button | 🔲 | `client/src/pages/home.tsx` |
| 5.9 | Ad sent count and last-sent timestamp shown in UI | 🔲 | `client/src/pages/home.tsx` |
| 5.10 | Resumable: if interrupted, restart from last_published_ad_index | 🔲 | `server/modules/publisher.ts` |

---

## Phase 6 — Message Reader

| # | Item | Status | File |
|---|------|--------|------|
| 6.1 | Message reader framework: coordinator, state, progress | ✅ | `server/modules/message-reader.ts` |
| 6.2 | NLP integration: skip ad messages, only process normal messages | ✅ | `server/modules/message-reader.ts` |
| 6.3 | Extracted links saved to Links_Repository with source="message" | ✅ | `server/modules/message-reader.ts` |
| 6.4 | Human mimicry delays between group reads | ✅ | `server/modules/message-reader.ts` |
| 6.5 | **Baileys `fetchMessages()` integration** (actual message fetch) | 🔲 | `server/modules/message-reader.ts` |
| 6.6 | `last_read_message_id` updated in System_State for resumability | 🔲 | `server/modules/message-reader.ts` |
| 6.7 | API routes: `POST /api/reader/start`, `POST /api/reader/stop`, `GET /api/reader/progress` | 🔲 | `server/routes.ts` |
| 6.8 | Frontend UI: start/stop reading, progress bar, found links count | 🔲 | `client/src/pages/home.tsx` |

---

## Phase 7 — Join Manager

| # | Item | Status | File |
|---|------|--------|------|
| 7.1 | Join manager atomic file | 🔲 | `server/modules/join-manager.ts` |
| 7.2 | Coordinator lock (one function at a time) | 🔲 | `server/modules/join-manager.ts` |
| 7.3 | Only joins Pending links from Links_Repository | 🔲 | `server/modules/join-manager.ts` |
| 7.4 | Community detection via Baileys API (communities join differently) | 🔲 | `server/modules/join-manager.ts` |
| 7.5 | Status update: Pending → Joined / Ignored on result | 🔲 | `server/modules/join-manager.ts` |
| 7.6 | Human mimicry: gaussian delays between joins, rest pause after batches | 🔲 | `server/modules/join-manager.ts` |
| 7.7 | NLP classifier: detect and skip ad groups before joining | 🔲 | `server/modules/join-manager.ts` |
| 7.8 | Error handling: rate limit, banned link, already member, invite revoked | 🔲 | `server/modules/join-manager.ts` |
| 7.9 | Frontend join progress wired to Links_Repository (not just JSON) | 🔲 | `client/src/pages/home.tsx` |

---

## Phase 8 — Leave Manager (LeavingQueue)

| # | Item | Status | File |
|---|------|--------|------|
| 8.1 | Leave manager atomic file | 🔲 | `server/modules/leave-manager.ts` |
| 8.2 | `LeavingQueue` MongoDB collection | 🔲 | `server/modules/leave-manager.ts` |
| 8.3 | Enqueue groups to leave (from UI or automatic) | 🔲 | `server/modules/leave-manager.ts` |
| 8.4 | Process queue with coordinator lock | 🔲 | `server/modules/leave-manager.ts` |
| 8.5 | Status update: Joined → Left after leaving | 🔲 | `server/modules/leave-manager.ts` |
| 8.6 | Human mimicry delays before each leave action | 🔲 | `server/modules/leave-manager.ts` |
| 8.7 | API routes and frontend UI for leave queue | 🔲 | `server/routes.ts` |

---

## Phase 9 — Error Handling & Resilience

| # | Item | Status | File |
|---|------|--------|------|
| 9.1 | All functions wrapped in try/finally to always release coordinator | ✅ | All modules |
| 9.2 | System_State recovery on server restart | ✅ | `server/modules/system-state.ts` |
| 9.3 | MongoDB connection failure: graceful fallback, warning logged | ✅ | `server/index.ts` |
| 9.4 | Baileys: handle `403 Forbidden` (banned invite link) → mark Ignored | 🔲 | `server/modules/join-manager.ts` |
| 9.5 | Baileys: handle `409 Conflict` (already member) → mark Joined | 🔲 | `server/modules/join-manager.ts` |
| 9.6 | Baileys: handle rate limit → exponential backoff (already in baileys-manager) | ✅ | `server/baileys-manager.ts` |
| 9.7 | Baileys: handle `408 / timeout` → retry with delay | 🔲 | `server/modules/join-manager.ts` |
| 9.8 | Baileys: handle community invite (different API path) | 🔲 | `server/modules/join-manager.ts` |
| 9.9 | Anti-detection: randomize order of links on every run | ✅ | `server/modules/human-mimicry.ts` (`shuffle`) |
| 9.10 | Anti-detection: gaussian delay distribution (not uniform) | ✅ | `server/modules/human-mimicry.ts` |

---

## Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Foundation & Architecture | ✅ Done |
| 1 | Link Filtering (personal vs group) | ✅ Done |
| 2 | MongoDB Collections | ✅ Framework done, API routes 🔲 |
| 3 | Function Isolation | ✅ Done |
| 4 | NLP Ad Classifier | ✅ Done |
| 5 | Publisher | ⚠️ Framework done, Baileys send 🔲 |
| 6 | Message Reader | ⚠️ Framework done, Baileys fetch 🔲 |
| 7 | Join Manager | 🔲 Planned |
| 8 | Leave Manager | 🔲 Planned |
| 9 | Error Handling | ✅ Core done, edge cases 🔲 |
