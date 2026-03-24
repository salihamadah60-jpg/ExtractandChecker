export interface ExtractedLinks {
  whatsapp: string[];
  telegram: string[];
}

export interface CheckResult {
  link: string;
  status: "pending" | "valid" | "invalid" | "error";
  info?: string;
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

class LinkStore {
  extractedLinks: ExtractedLinks = { whatsapp: [], telegram: [] };
  checkSession: CheckSession | null = null;

  setExtracted(links: ExtractedLinks) {
    this.extractedLinks = links;
    this.checkSession = null;
  }

  startSession(links: string[]): CheckSession {
    this.checkSession = {
      id: Date.now().toString(),
      links,
      results: links.map((link) => ({ link, status: "pending" })),
      progress: 0,
      total: links.length,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    return this.checkSession;
  }
}

export const linkStore = new LinkStore();
