import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg as any;
import qrcode from "qrcode";
import { EventEmitter } from "events";

export type SessionStatus = "disconnected" | "qr_ready" | "connecting" | "connected" | "auth_failed";

export interface CheckResult {
  link: string;
  status: "valid" | "invalid" | "pending" | "error";
  info?: string;
  checkedAt?: string;
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

class WhatsAppManager extends EventEmitter {
  private client: Client | null = null;
  private qrCodeData: string | null = null;
  private sessionStatus: SessionStatus = "disconnected";
  private currentSession: CheckSession | null = null;
  private isInitializing = false;

  getStatus(): SessionStatus {
    return this.sessionStatus;
  }

  getQrCode(): string | null {
    return this.qrCodeData;
  }

  getCurrentSession(): CheckSession | null {
    return this.currentSession;
  }

  async initialize(): Promise<void> {
    if (this.isInitializing || this.client) return;
    this.isInitializing = true;
    this.sessionStatus = "connecting";
    this.emit("status", this.sessionStatus);

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: ".whatsapp-session" }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--single-process",
            "--disable-gpu",
          ],
        },
      });

      this.client.on("qr", async (qr) => {
        try {
          this.qrCodeData = await qrcode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: { dark: "#111827", light: "#ffffff" },
          });
          this.sessionStatus = "qr_ready";
          this.emit("status", this.sessionStatus);
          this.emit("qr", this.qrCodeData);
        } catch (err) {
          console.error("QR generation error:", err);
        }
      });

      this.client.on("ready", () => {
        this.sessionStatus = "connected";
        this.qrCodeData = null;
        this.emit("status", this.sessionStatus);
        console.log("[WhatsApp] Client ready");
      });

      this.client.on("authenticated", () => {
        this.sessionStatus = "connecting";
        this.emit("status", this.sessionStatus);
        console.log("[WhatsApp] Authenticated");
      });

      this.client.on("auth_failure", (msg) => {
        this.sessionStatus = "auth_failed";
        this.emit("status", this.sessionStatus);
        console.error("[WhatsApp] Auth failure:", msg);
      });

      this.client.on("disconnected", (reason) => {
        this.sessionStatus = "disconnected";
        this.qrCodeData = null;
        this.client = null;
        this.isInitializing = false;
        this.emit("status", this.sessionStatus);
        console.log("[WhatsApp] Disconnected:", reason);
      });

      await this.client.initialize();
    } catch (err) {
      console.error("[WhatsApp] Init error:", err);
      this.sessionStatus = "disconnected";
      this.client = null;
      this.isInitializing = false;
      this.emit("status", this.sessionStatus);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (_) {}
      this.client = null;
    }
    this.sessionStatus = "disconnected";
    this.qrCodeData = null;
    this.isInitializing = false;
    this.emit("status", this.sessionStatus);
  }

  async checkLinks(links: string[]): Promise<string> {
    if (!this.client || this.sessionStatus !== "connected") {
      throw new Error("WhatsApp غير متصل");
    }

    if (this.currentSession?.status === "running") {
      throw new Error("جلسة فحص جارية بالفعل");
    }

    const sessionId = Date.now().toString();
    this.currentSession = {
      id: sessionId,
      links,
      results: links.map((link) => ({ link, status: "pending" })),
      progress: 0,
      total: links.length,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    this.emit("session", this.currentSession);

    // Run in background
    this.runCheckSession().catch(console.error);

    return sessionId;
  }

  private async runCheckSession(): Promise<void> {
    const session = this.currentSession;
    if (!session || !this.client) return;

    const MIN_DELAY = 2000;
    const MAX_DELAY = 5000;

    for (let i = 0; i < session.links.length; i++) {
      if (!this.client || this.sessionStatus !== "connected") {
        session.status = "error";
        this.emit("session", session);
        return;
      }

      const link = session.links[i];
      const result = session.results[i];

      try {
        result.status = await this.checkSingleLink(link);
        result.checkedAt = new Date().toISOString();

        if (result.status === "valid") {
          result.info = "الرابط صالح";
        } else if (result.status === "invalid") {
          result.info = "الرابط منتهي أو غير موجود";
        }
      } catch (err: any) {
        result.status = "error";
        result.info = err.message || "خطأ في الفحص";
        result.checkedAt = new Date().toISOString();
      }

      session.progress = i + 1;
      this.emit("session", session);

      // Random delay between checks to avoid ban
      if (i < session.links.length - 1) {
        const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    session.status = "done";
    session.completedAt = new Date().toISOString();
    this.emit("session", session);
  }

  private async checkSingleLink(link: string): Promise<"valid" | "invalid" | "error"> {
    const client = this.client;
    if (!client) throw new Error("Client not available");

    // Normalize the link
    const trimmed = link.trim();

    // Group invite link: chat.whatsapp.com/XXXXXX
    const groupMatch = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
    if (groupMatch) {
      const inviteCode = groupMatch[1];
      try {
        const info = await (client as any).getInviteInfo(inviteCode);
        if (info && info.subject) {
          return "valid";
        }
        return "invalid";
      } catch (err: any) {
        if (
          err.message?.includes("invalid") ||
          err.message?.includes("404") ||
          err.message?.includes("not found")
        ) {
          return "invalid";
        }
        throw err;
      }
    }

    // Phone number link: wa.me/XXXXXXX or api.whatsapp.com/send?phone=XXXXXXX
    const phoneMatch =
      trimmed.match(/wa\.me\/(\+?[\d]+)/) ||
      trimmed.match(/api\.whatsapp\.com\/send\?phone=(\+?[\d]+)/);
    if (phoneMatch) {
      const rawNumber = phoneMatch[1].replace(/\D/g, "");
      try {
        const isRegistered = await (client as any).isRegisteredUser(`${rawNumber}@c.us`);
        return isRegistered ? "valid" : "invalid";
      } catch (err) {
        throw err;
      }
    }

    // Unknown format
    return "error";
  }

  getSessionProgress(): CheckSession | null {
    return this.currentSession;
  }
}

export const whatsappManager = new WhatsAppManager();
