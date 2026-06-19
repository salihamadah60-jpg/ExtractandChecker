---
name: Workspace isolation + admin aggregation
description: Architecture rules for workspace isolation, admin aggregation, and 30-day TTL on regular workspace links.
---

## The rule
Regular workspaces are completely isolated — they ONLY see links they uploaded themselves.
Admin workspace (`workspaceId === "main"`) accumulates ALL filtered groups from ALL workspaces.

**Why:** The bug that created 2737 links was caused by auto-populating every new workspace with ALL CentralLinks on creation (routes.ts). New workspaces must start empty.

**How to apply:**
- NEVER add back the auto-populate block in `/api/workspaces/create`
- When any non-main workspace saves filtered results (routes.ts ~line 924), also call `linksRepository.saveFilteredLinks("main", groups, [])` — this is the admin aggregation flow
- CentralLinks store (global deduplication) is separate from admin aggregation and serves the admin panel download/stats

## TTL for regular workspaces
- `links-repository.ts` has TTL index: `{ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true }`
- Helper `linkExpiresAt(workspaceId)` returns `Date + 30 days` for non-"main" workspaces, `undefined` for "main"
- `$setOnInsert` in `directImport` and `saveFilteredLinks` includes `expiresAt` conditionally
- `sparse: true` means admin ("main") documents (no `expiresAt` field) are NEVER touched by MongoDB TTL monitor

## Admin workspace identification
- `ADMIN_WORKSPACE_IDS = new Set(["main"])` in links-repository.ts
- To add more admin workspaces: add their workspaceId to this set
- Admin workspaces: no `expiresAt`, links never auto-deleted, see all aggregated groups

## Data flow summary
1. User uploads → runs link checker → `/api/whatsapp/filtered-summary`
2. Valid groups saved to: user's workspace `Links_Repository` (isolated, 30-day TTL)
3. Valid groups ALSO saved to: `CentralLinks` (global dedup store for admin panel)
4. Valid groups ALSO pushed to: `main` workspace `Links_Repository` as Pending (admin can join them)
5. Ads go ONLY to user's workspace Links_Repository — never to admin or CentralLinks
