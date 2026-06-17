/**
 * keyword-filter.ts — Dynamic keyword lists for group classification (per-workspace)
 *
 * Two lists:
 *  - "ad_only"  : group name/desc matches → treat as ad-group (leave queue / ads file)
 *  - "banned"   : group name/desc matches → exclude the group entirely
 *
 * Results are cached per workspace (60-second TTL) to avoid hammering MongoDB.
 */

import { getDb } from "../mongo-auth-state.js";
import { randomUUID } from "crypto";

export type KeywordCategory = "ad_only" | "banned";

export interface KeywordDoc {
  _id: string;
  workspaceId: string;
  category: KeywordCategory;
  keyword: string;
  addedAt: Date;
}

const COL = "Keyword_Filters";

async function col() {
  const db = await getDb();
  return db.collection<KeywordDoc>(COL);
}

interface CacheEntry { adOnly: string[]; banned: string[]; loadedAt: number; }
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60_000;

async function _load(workspaceId: string): Promise<CacheEntry> {
  const hit = _cache.get(workspaceId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL) return hit;

  const c    = await col();
  const docs = await c.find({ workspaceId }).toArray() as KeywordDoc[];
  const entry: CacheEntry = {
    adOnly:   docs.filter(d => d.category === "ad_only").map(d => d.keyword.toLowerCase()),
    banned:   docs.filter(d => d.category === "banned").map(d => d.keyword.toLowerCase()),
    loadedAt: Date.now(),
  };
  _cache.set(workspaceId, entry);
  return entry;
}

function _invalidate(wid: string): void { _cache.delete(wid); }

function _matches(keywords: string[], name: string, desc: string): boolean {
  if (!keywords.length) return false;
  const hay = `${name} ${desc}`.toLowerCase();
  return keywords.some(kw => hay.includes(kw));
}

export const keywordFilter = {
  async init(): Promise<void> {
    const c = await col();
    await (c.createIndex as any)({ workspaceId: 1 }, { background: true });
    await (c.createIndex as any)(
      { workspaceId: 1, category: 1, keyword: 1 },
      { unique: true, background: true, name: "kf_unique" }
    );
    console.log("[KeywordFilter] Ready");
  },

  async list(workspaceId: string): Promise<KeywordDoc[]> {
    const c = await col();
    return c.find({ workspaceId }).sort({ category: 1, keyword: 1 }).toArray() as Promise<KeywordDoc[]>;
  },

  async add(workspaceId: string, keyword: string, category: KeywordCategory): Promise<{ ok: boolean; error?: string }> {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return { ok: false, error: "الكلمة فارغة" };
    try {
      const c = await col();
      await (c.insertOne as any)({
        _id:         randomUUID(),
        workspaceId,
        category,
        keyword:     kw,
        addedAt:     new Date(),
      });
      _invalidate(workspaceId);
      return { ok: true };
    } catch {
      return { ok: false, error: "الكلمة موجودة بالفعل" };
    }
  },

  async remove(workspaceId: string, id: string): Promise<void> {
    const c = await col();
    await (c.deleteOne as any)({ _id: id, workspaceId });
    _invalidate(workspaceId);
  },

  /** True if the group name/desc matches any "ad_only" custom keyword. */
  async isAdOnly(workspaceId: string, name = "", desc = ""): Promise<boolean> {
    const { adOnly } = await _load(workspaceId);
    return _matches(adOnly, name, desc);
  },

  /** True if the group name/desc matches any "banned" custom keyword. */
  async isBanned(workspaceId: string, name = "", desc = ""): Promise<boolean> {
    const { banned } = await _load(workspaceId);
    return _matches(banned, name, desc);
  },

  /** Synchronous check using the last cached values (for hot paths). Returns false if cache is empty/cold. */
  isAdOnlySync(workspaceId: string, name = "", desc = ""): boolean {
    const entry = _cache.get(workspaceId);
    if (!entry) return false;
    return _matches(entry.adOnly, name, desc);
  },

  isBannedSync(workspaceId: string, name = "", desc = ""): boolean {
    const entry = _cache.get(workspaceId);
    if (!entry) return false;
    return _matches(entry.banned, name, desc);
  },
};
