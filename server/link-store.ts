import fs from "fs/promises";
import path from "path";

const STATE_FILE = path.resolve(".session-state.json");
const STATE_FILE_TMP = STATE_FILE + ".tmp";
const DESC_LINKS_FILE = path.resolve("description-links.json");

const LINKS_JSON_DIR = path.resolve("Linksjson");
const LINKS_JSON_END_DIR = path.resolve("LinksjsonEndRe");

async function ensureDirs() {
  await fs.mkdir(LINKS_JSON_DIR, { recursive: true }).catch(() => {});
  await fs.mkdir(LINKS_JSON_END_DIR, { recursive: true }).catch(() => {});
}

export interface ExtractedLinks {
  whatsapp: string[];
  telegram: string[];
}

export interface CheckResult {
  link: string;
  status: "pending" | "valid" | "invalid" | "error";
  info?: string;
  name?: string;
  members?: number;
  description?: string;
}

export interface CheckSession {
  id: string;
  links: string[];
  results: CheckResult[];
  progress: number;
  total: number;
  status: "idle" | "running" | "done" | "error";
  startedAt: string;
  completedAt?: string;
}

export interface JoinSession {
  status: "running" | "done" | "error" | "paused";
  total: number;
  progress: number;
  joined: number;
  failed: number;
  startedAt: string;
  completedAt?: string;
  currentLink?: string;
  joinedLinks: string[];
  failedLinks: string[];
}

export interface FilteredGroup {
  link: string;
  name?: string;
  members: number;
  description?: string;
}

export interface FilteredSummary {
  groups: FilteredGroup[];
  ads: FilteredGroup[];
  descriptionLinks: string[];
}

interface PersistedState {
  extractedLinks: ExtractedLinks;
  checkSession: CheckSession | null;
  joinSession: JoinSession | null;
  uploadedFileName?: string;
  newRoundLinks?: ExtractedLinks;
}

function linksMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

const WA_REGEX = /https?:\/\/(?:chat\.whatsapp\.com\/[A-Za-z0-9_-]+|wa\.me\/[\d+]+|api\.whatsapp\.com\/send\?[^\s"'<>]*)/g;
const TG_REGEX = /https?:\/\/(?:t\.me\/[A-Za-z0-9_+/-]+|telegram\.me\/[A-Za-z0-9_]+|telegram\.org\/[^\s"'<>]*)/g;

function extractLinksFromText(text: string): string[] {
  const waLinks = [...text.matchAll(WA_REGEX)].map((m) => m[0].replace(/[.,;)>\]'"]+$/, ""));
  const tgLinks = [...text.matchAll(TG_REGEX)].map((m) => m[0].replace(/[.,;)>\]'"]+$/, ""));
  return [...new Set([...waLinks, ...tgLinks].map((l) => l.trim()).filter(Boolean))];
}

class LinkStore {
  extractedLinks: ExtractedLinks = { whatsapp: [], telegram: [] };
  checkSession: CheckSession | null = null;
  joinSession: JoinSession | null = null;
  newRoundLinks: ExtractedLinks = { whatsapp: [], telegram: [] };
  uploadedFileName: string = "";

  async loadFromDisk(): Promise<void> {
    await ensureDirs();
    try {
      const raw = await fs.readFile(STATE_FILE, "utf-8");
      const saved: PersistedState = JSON.parse(raw);
      this.extractedLinks = saved.extractedLinks ?? { whatsapp: [], telegram: [] };
      this.uploadedFileName = saved.uploadedFileName ?? "";
      this.newRoundLinks = saved.newRoundLinks ?? { whatsapp: [], telegram: [] };
      // Migrate old joinSession without joinedLinks/failedLinks
      if (saved.joinSession) {
        this.joinSession = {
          joinedLinks: [],
          failedLinks: [],
          ...saved.joinSession,
        };
      } else {
        this.joinSession = null;
      }
      if (saved.checkSession) {
        if (saved.checkSession.status === "running") {
          saved.checkSession.status = "idle";
        }
        this.checkSession = saved.checkSession;
        const done = saved.checkSession.results.filter((r) => r.status !== "pending").length;
        console.log(`[LinkStore] Loaded saved state — ${done}/${saved.checkSession.total} links already checked`);
      } else {
        console.log("[LinkStore] Loaded saved state (no previous session)");
      }
      // Pause any running join session on reload
      if (this.joinSession?.status === "running") {
        this.joinSession.status = "paused";
      }
    } catch {
      // No saved state yet
    }
  }

  async saveToDisk(): Promise<void> {
    try {
      const state: PersistedState = {
        extractedLinks: this.extractedLinks,
        checkSession: this.checkSession,
        joinSession: this.joinSession,
        uploadedFileName: this.uploadedFileName,
        newRoundLinks: this.newRoundLinks,
      };
      const json = JSON.stringify(state, null, 2);
      await fs.writeFile(STATE_FILE_TMP, json, "utf-8");
      await fs.rename(STATE_FILE_TMP, STATE_FILE);
    } catch (err) {
      console.error("[LinkStore] Failed to save state:", err);
    }
  }

  async saveLinksToFile(originalFileName: string, links: ExtractedLinks): Promise<void> {
    try {
      await ensureDirs();
      const baseName = originalFileName.replace(/\.docx?$/i, "");
      this.uploadedFileName = baseName;
      // Save to Linksjson folder
      const filePath = path.join(LINKS_JSON_DIR, `${baseName}.json`);
      const data = {
        fileName: baseName,
        savedAt: new Date().toISOString(),
        whatsapp: links.whatsapp,
        telegram: links.telegram,
      };
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      console.log(`[LinkStore] Links saved to Linksjson/${baseName}.json (${links.whatsapp.length} WA, ${links.telegram.length} TG)`);
    } catch (err) {
      console.error("[LinkStore] Failed to save links to file:", err);
    }
  }

  async saveFilteredResults(summary: FilteredSummary): Promise<void> {
    try {
      await ensureDirs();
      const baseName = this.uploadedFileName || "results";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const fileName = `${baseName}-filtered-${timestamp}.json`;
      const filePath = path.join(LINKS_JSON_END_DIR, fileName);
      const data = {
        fileName: baseName,
        savedAt: new Date().toISOString(),
        groups: summary.groups,
        ads: summary.ads,
        descriptionLinks: summary.descriptionLinks,
        totals: {
          groups: summary.groups.length,
          ads: summary.ads.length,
          descriptionLinks: summary.descriptionLinks.length,
        },
      };
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      console.log(`[LinkStore] Filtered results saved to LinksjsonEndRe/${fileName}`);
    } catch (err) {
      console.error("[LinkStore] Failed to save filtered results:", err);
    }
  }

  async saveDescriptionLinks(links: string[]): Promise<void> {
    try {
      const data = {
        savedAt: new Date().toISOString(),
        links,
        count: links.length,
      };
      await fs.writeFile(DESC_LINKS_FILE, JSON.stringify(data, null, 2), "utf-8");
      console.log(`[LinkStore] Description links saved: ${links.length}`);
    } catch (err) {
      console.error("[LinkStore] Failed to save description links:", err);
    }
  }

  setExtracted(links: ExtractedLinks) {
    this.extractedLinks = links;
    const sessionLinksMatch =
      this.checkSession && linksMatch(this.checkSession.links, links.whatsapp);

    if (!sessionLinksMatch) {
      this.checkSession = null;
    } else {
      if (this.checkSession && this.checkSession.status === "running") {
        this.checkSession.status = "idle";
      }
      const done = this.checkSession!.results.filter((r) => r.status !== "pending").length;
      console.log(`[LinkStore] Same file re-uploaded — preserving session (${done}/${this.checkSession!.total} already checked)`);
    }
    this.saveToDisk().catch(console.error);
  }

  startSession(links: string[]): CheckSession {
    if (
      this.checkSession &&
      (this.checkSession.status === "idle" || this.checkSession.status === "running") &&
      linksMatch(this.checkSession.links, links)
    ) {
      this.checkSession.status = "running";
      const done = this.checkSession.results.filter((r) => r.status !== "pending").length;
      this.checkSession.progress = done;
      console.log(`[LinkStore] Resuming session — ${done}/${links.length} already checked`);
      this.saveToDisk().catch(console.error);
      return this.checkSession;
    }

    this.checkSession = {
      id: Date.now().toString(),
      links,
      results: links.map((link) => ({ link, status: "pending" })),
      progress: 0,
      total: links.length,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.saveToDisk().catch(console.error);
    return this.checkSession;
  }

  prepareNewRound(newWhatsapp: string[], newTelegram: string[], originalFileName: string): {
    uniqueWhatsapp: string[];
    uniqueTelegram: string[];
    skipped: number;
  } {
    const known = new Set<string>();
    for (const r of this.checkSession?.results ?? []) {
      known.add(r.link);
    }
    for (const l of this.extractedLinks.whatsapp) known.add(l);
    for (const l of this.extractedLinks.telegram) known.add(l);

    const uniqueWhatsapp = [...new Set(newWhatsapp)].filter((l) => !known.has(l));
    const uniqueTelegram = [...new Set(newTelegram)].filter((l) => !known.has(l));
    const skipped = (newWhatsapp.length + newTelegram.length) - (uniqueWhatsapp.length + uniqueTelegram.length);

    this.newRoundLinks = { whatsapp: uniqueWhatsapp, telegram: uniqueTelegram };

    const baseName = originalFileName.replace(/\.docx?$/i, "");
    const roundNum = this.getRoundNumber();
    const roundFileName = `${baseName}-round${roundNum}.json`;
    ensureDirs().then(() => {
      fs.writeFile(path.join(LINKS_JSON_DIR, roundFileName), JSON.stringify({
        fileName: `${baseName}-round${roundNum}`,
        savedAt: new Date().toISOString(),
        whatsapp: uniqueWhatsapp,
        telegram: uniqueTelegram,
      }, null, 2), "utf-8").catch(console.error);
    }).catch(console.error);

    this.saveToDisk().catch(console.error);
    return { uniqueWhatsapp, uniqueTelegram, skipped };
  }

  startNewRoundSession(): CheckSession {
    const newLinks = this.newRoundLinks.whatsapp;
    if (!newLinks.length) throw new Error("لا توجد روابط جديدة للفحص");

    if (this.checkSession) {
      const existingLinkSet = new Set(this.checkSession.results.map((r) => r.link));
      const trulyNew = newLinks.filter((l) => !existingLinkSet.has(l));
      if (!trulyNew.length) throw new Error("جميع الروابط تم فحصها مسبقاً");

      this.checkSession.links = [...this.checkSession.links, ...trulyNew];
      this.checkSession.results = [
        ...this.checkSession.results,
        ...trulyNew.map((link) => ({ link, status: "pending" as const })),
      ];
      this.checkSession.total = this.checkSession.results.length;
      this.checkSession.progress = this.checkSession.results.filter((r) => r.status !== "pending").length;
      this.checkSession.status = "running";
      this.checkSession.completedAt = undefined;
      console.log(`[LinkStore] Extended session with ${trulyNew.length} new links (total: ${this.checkSession.total})`);
    } else {
      this.checkSession = {
        id: Date.now().toString(),
        links: newLinks,
        results: newLinks.map((link) => ({ link, status: "pending" })),
        progress: 0,
        total: newLinks.length,
        status: "running",
        startedAt: new Date().toISOString(),
      };
    }

    this.newRoundLinks = { whatsapp: [], telegram: [] };
    this.saveToDisk().catch(console.error);
    return this.checkSession;
  }

  private getRoundNumber(): number {
    return Math.floor((this.checkSession?.total ?? 0) / Math.max(this.extractedLinks.whatsapp.length, 1)) + 2;
  }

  // ── Get valid group links for joining ─────────────────────────────────────
  getValidGroupLinks(): CheckResult[] {
    return (this.checkSession?.results ?? []).filter(
      (r) => r.status === "valid" && r.link.includes("chat.whatsapp.com")
    );
  }

  // ── Compute filtered summary ───────────────────────────────────────────────
  getFilteredSummary(): FilteredSummary {
    const results = this.checkSession?.results ?? [];
    const validGroups = results.filter(
      (r) => r.status === "valid" && r.link.includes("chat.whatsapp.com")
    );

    // Groups file: >50 members  OR  (10 < members ≤ 50 AND no description)
    const groups: FilteredGroup[] = validGroups
      .filter((r) => {
        const m = r.members ?? 0;
        if (m > 50) return true;
        if (m > 10 && m <= 50 && !r.description?.trim()) return true;
        return false;
      })
      .map((r) => ({ link: r.link, name: r.name, members: r.members!, description: r.description }))
      .sort((a, b) => {
        // Sort by first word of name (directory grouping), then member count
        const dirA = (a.name ?? "").trim().split(/\s+/)[0] ?? "";
        const dirB = (b.name ?? "").trim().split(/\s+/)[0] ?? "";
        if (dirA !== dirB) return dirA.localeCompare(dirB, "ar");
        return a.members - b.members;
      });

    // Ads file: 10 < members ≤ 50 AND has non-empty description
    const ads: FilteredGroup[] = validGroups
      .filter((r) => {
        const m = r.members ?? 0;
        return m > 10 && m <= 50 && !!r.description?.trim();
      })
      .map((r) => ({ link: r.link, name: r.name, members: r.members!, description: r.description }));

    // Extract links from descriptions of groups>50
    const descLinkSet = new Set<string>();
    for (const g of groups.filter((g) => g.members > 50)) {
      if (g.description) {
        for (const l of extractLinksFromText(g.description)) {
          descLinkSet.add(l);
        }
      }
    }
    const sessionLinkSet = new Set(results.map((r) => r.link));
    const descriptionLinks = [...descLinkSet].filter((l) => !sessionLinkSet.has(l));

    return { groups, ads, descriptionLinks };
  }

  updateProgress() {
    this.saveToDisk().catch(console.error);
  }
}

export const linkStore = new LinkStore();
