import fs from "fs/promises";
import path from "path";

const STATE_FILE = path.resolve(".session-state.json");
const STATE_FILE_TMP = STATE_FILE + ".tmp";

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

interface PersistedState {
  extractedLinks: ExtractedLinks;
  checkSession: CheckSession | null;
  uploadedFileName?: string;
}

function linksMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

class LinkStore {
  extractedLinks: ExtractedLinks = { whatsapp: [], telegram: [] };
  checkSession: CheckSession | null = null;
  uploadedFileName: string = "";

  // ── Load saved state from disk on startup ──────────────────────────────────
  async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(STATE_FILE, "utf-8");
      const saved: PersistedState = JSON.parse(raw);
      this.extractedLinks = saved.extractedLinks ?? { whatsapp: [], telegram: [] };
      this.uploadedFileName = saved.uploadedFileName ?? "";
      if (saved.checkSession) {
        // If the session was mid-run when the app died, mark it paused so it can resume
        if (saved.checkSession.status === "running") {
          saved.checkSession.status = "idle";
        }
        this.checkSession = saved.checkSession;
        const done = saved.checkSession.results.filter(
          (r) => r.status !== "pending"
        ).length;
        console.log(
          `[LinkStore] Loaded saved state — ${done}/${saved.checkSession.total} links already checked`
        );
      } else {
        console.log("[LinkStore] Loaded saved state (no previous session)");
      }
    } catch {
      // No saved state yet — start fresh silently
    }
  }

  // ── Atomic persist — write to .tmp then rename to avoid corruption on crash ─
  async saveToDisk(): Promise<void> {
    try {
      const state: PersistedState = {
        extractedLinks: this.extractedLinks,
        checkSession: this.checkSession,
        uploadedFileName: this.uploadedFileName,
      };
      const json = JSON.stringify(state, null, 2);
      await fs.writeFile(STATE_FILE_TMP, json, "utf-8");
      await fs.rename(STATE_FILE_TMP, STATE_FILE);
    } catch (err) {
      console.error("[LinkStore] Failed to save state:", err);
    }
  }

  // ── Save extracted links to a named JSON file (same name as uploaded file) ─
  async saveLinksToFile(originalFileName: string, links: ExtractedLinks): Promise<void> {
    try {
      const baseName = originalFileName.replace(/\.docx?$/i, "");
      this.uploadedFileName = baseName;
      const filePath = path.resolve(`${baseName}.json`);
      const data = {
        fileName: baseName,
        savedAt: new Date().toISOString(),
        whatsapp: links.whatsapp,
        telegram: links.telegram,
      };
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      console.log(`[LinkStore] Links saved to ${baseName}.json (${links.whatsapp.length} WA, ${links.telegram.length} TG)`);
    } catch (err) {
      console.error("[LinkStore] Failed to save links to file:", err);
    }
  }

  setExtracted(links: ExtractedLinks) {
    this.extractedLinks = links;

    // ★ KEY FIX: only wipe the session if the WhatsApp links are actually different.
    // If the user re-uploads the same file to reconnect WhatsApp, we keep the
    // existing session so checking resumes from where it stopped.
    const sessionLinksMatch =
      this.checkSession &&
      linksMatch(this.checkSession.links, links.whatsapp);

    if (!sessionLinksMatch) {
      // Genuinely new file — start fresh
      this.checkSession = null;
    } else {
      // Same file re-uploaded — pause any running session so it can be resumed
      if (this.checkSession && this.checkSession.status === "running") {
        this.checkSession.status = "idle";
      }
      const done = this.checkSession!.results.filter(
        (r) => r.status !== "pending"
      ).length;
      console.log(
        `[LinkStore] Same file re-uploaded — preserving session (${done}/${this.checkSession!.total} already checked)`
      );
    }

    this.saveToDisk().catch(console.error);
  }

  startSession(links: string[]): CheckSession {
    // Resume if there is any existing session (idle OR running) with the same links
    if (
      this.checkSession &&
      (this.checkSession.status === "idle" || this.checkSession.status === "running") &&
      linksMatch(this.checkSession.links, links)
    ) {
      this.checkSession.status = "running";
      const done = this.checkSession.results.filter(
        (r) => r.status !== "pending"
      ).length;
      this.checkSession.progress = done;
      console.log(
        `[LinkStore] Resuming session — ${done}/${links.length} already checked`
      );
      this.saveToDisk().catch(console.error);
      return this.checkSession;
    }

    // Otherwise start a completely fresh session
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

  // Call this after every result update to keep disk in sync
  updateProgress() {
    this.saveToDisk().catch(console.error);
  }
}

export const linkStore = new LinkStore();
