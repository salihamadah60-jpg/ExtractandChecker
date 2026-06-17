---
name: Keyword filter integration
description: How the custom keyword filter (ad_only/banned) plugs into the pipeline classification in message-reader.ts
---

## Rule
`keywordFilter.isAdOnlySync(wid, text)` and `isBannedSync(wid, text)` must be called inside `_runPipeline()` before `isAdOnlyMedicalGroup`. Banned groups are excluded from both groups and ads arrays. ad_only groups are moved to ads array.

**Why:** The sync variants use an in-memory cache populated by `keywordFilter.init()` at startup and refreshed on writes. Calling async variants inside a tight pipeline loop would stall the event loop.

**How to apply:** Import `keywordFilter` from `./keyword-filter.js` inside `message-reader.ts`. Call `keywordFilter.init()` in `server/index.ts` startup sequence.
