import { EventEmitter } from "events";
import qrcode from "qrcode";
import fs from "fs/promises";
import { linkStore } from "./link-store.js";

export type WAStatus =
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "pairing"
  | "connected"
  | "auth_failed";

const AUTH_DIR = ".baileys-auth";

let makeWASocket: any;
let useMultiFileAuthState: any;
let DisconnectReason: any;
let fetchLatestBaileysVersion: any;

async function loadBaileys() {
  if (makeWASocket) return;
  const baileys = await import("@whiskeysockets/baileys");
  makeWASocket = (baileys as any).makeWASocket ?? (baileys as any).default;
  useMultiFileAuthState = (baileys as any).useMultiFileAuthState;
  DisconnectReason = (baileys as any).DisconnectReason;
  fetchLatestBaileysVersion = (baileys as any).fetchLatestBaileysVersion;
}

async function clearAuthDir() {
  try {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    console.log("[Baileys] Auth dir cleared");
  } catch (_) {}
}

class BaileysManager extends EventEmitter {
  private sock: any = null;
  private status: WAStatus = "disconnected";
  private qrCodeDataUrl: string | null = null;
  private pairingCodeValue: string | null = null;
  private isStarting = false;

  getStatus(): WAStatus { return this.status; }
  getQrCode(): string | null { return this.qrCodeDataUrl; }
  getPairingCode(): string | null { return this.pairingCodeValue; }

  private setStatus(s: WAStatus) {
    this.status = s;
    this.emit("status", s);
  }

  // ── Connect ────────────────────────────────────────────────────────────────
  // skipClearAuth = true  → keep saved credentials (reconnect after pairing confirmed)
  // skipClearAuth = false → wipe auth and start fresh
  async connect(
    usePairing = false,
    phoneNumber?: string,
    skipClearAuth = false
  ): Promise<void> {
    if (this.isStarting || this.sock) return;

    this.isStarting = true;
    this.setStatus("connecting");

    // Only clear auth on a truly fresh attempt; keep it when reconnecting
    // after the phone has confirmed the pairing code (WhatsApp code 515/440).
    if (!skipClearAuth) {
      await clearAuthDir();
    }

    try {
      await loadBaileys();
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Link Checker Pro", "Chrome", "120.0.0"],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 10_000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
      });
      this.sock = sock;

      // ── Pairing code: request OUTSIDE the event handler.
      //    Uses local `sock` ref so it stays valid even if this.sock is reset.
      //    Don't request a new code when reconnecting after pairing confirmation.
      if (usePairing && phoneNumber && !skipClearAuth) {
        const phone = phoneNumber.replace(/\D/g, "");
        this.setStatus("pairing");

        // 2 s matches official Baileys examples; requestPairingCode handles
        // its own internal readiness after the WebSocket handshakes.
        setTimeout(async () => {
          try {
            console.log("[Baileys] Requesting pairing code for:", phone);
            const code = await sock.requestPairingCode(phone);
            this.pairingCodeValue = code;
            console.log("[Baileys] Pairing code:", code);
          } catch (err) {
            console.error("[Baileys] Pairing code error:", err);
          }
        }, 2000);
      }

      // ── Connection events
      sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        // QR mode only — pairing handles its own flow above
        if (qr && !usePairing) {
          try {
            this.qrCodeDataUrl = await qrcode.toDataURL(qr, {
              width: 280,
              margin: 2,
              color: { dark: "#111827", light: "#ffffff" },
            });
            this.setStatus("qr_ready");
          } catch (err) {
            console.error("[Baileys] QR gen error:", err);
          }
        }

        if (connection === "close") {
          const code = (lastDisconnect?.error as any)?.output?.statusCode;
          console.log("[Baileys] Connection closed, code:", code);

          this.sock = null;
          this.isStarting = false;
          this.qrCodeDataUrl = null;
          // Keep pairingCodeValue visible until we know what happened

          if (code === 401 || code === 403) {
            // Truly rejected — clear auth and tell the user
            await clearAuthDir();
            this.pairingCodeValue = null;
            this.setStatus("auth_failed");

          } else if (code === 515 || code === 440) {
            // 515 = restartRequired  → WhatsApp confirmed pairing, needs reconnect
            // 440 = connectionReplaced → same session opened elsewhere, reconnect
            // DO NOT clear auth — credentials were just saved by saveCreds
            console.log("[Baileys] Pairing confirmed or reconnect needed — reconnecting with saved creds");
            this.pairingCodeValue = null;
            this.setStatus("connecting");
            setTimeout(() => this.connect(usePairing, phoneNumber, true /* keepAuth */), 2000);

          } else if (code === 428 || code === 408 || !code) {
            // Transient network error — fresh reconnect
            this.pairingCodeValue = null;
            this.setStatus("connecting");
            setTimeout(() => this.connect(usePairing, phoneNumber, false), 3000);

          } else {
            this.pairingCodeValue = null;
            this.setStatus("disconnected");
          }
        }

        if (connection === "open") {
          console.log("[Baileys] Connected!");
          this.qrCodeDataUrl = null;
          this.pairingCodeValue = null;
          this.setStatus("connected");

          // Auto-resume checking if there's a paused session with pending links
          const session = linkStore.checkSession;
          if (
            session &&
            (session.status === "idle" || session.status === "running") &&
            session.results.some((r) => r.status === "pending")
          ) {
            const remaining = session.results.filter((r) => r.status === "pending").length;
            console.log(`[Baileys] Auto-resuming check session — ${remaining} links remaining`);
            setTimeout(() => this.startLinkChecking().catch(console.error), 2000);
          }
        }
      });

      sock.ev.on("creds.update", saveCreds);

    } catch (err) {
      console.error("[Baileys] Init error:", err);
      this.sock = null;
      this.isStarting = false;
      this.setStatus("disconnected");
    }
  }

  // ── Resend pairing code ───────────────────────────────────────────────────
  async resendPairingCode(phoneNumber: string): Promise<string> {
    const phone = phoneNumber.replace(/\D/g, "");

    if (!this.sock) {
      // Socket gone — restart fresh pairing
      await this.connect(true, phone, false);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (this.pairingCodeValue) return this.pairingCodeValue;
      }
      throw new Error("انتهت المهلة. حاول مرة أخرى.");
    }

    const code = await this.sock.requestPairingCode(phone);
    this.pairingCodeValue = code;
    return code;
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  async disconnect(): Promise<void> {
    const s = this.sock;
    this.sock = null;
    this.isStarting = false;
    this.qrCodeDataUrl = null;
    this.pairingCodeValue = null;

    if (s) {
      try { s.end(undefined); } catch (_) {}
    }
    await clearAuthDir();
    this.setStatus("disconnected");
  }

  isConnected(): boolean {
    return this.status === "connected" && this.sock !== null;
  }

  // ── Auto-connect on startup using saved credentials ────────────────────────
  async autoConnect(): Promise<void> {
    try {
      const credsFile = `${AUTH_DIR}/creds.json`;
      await fs.access(credsFile);
      // Credentials file exists — reconnect silently without clearing auth
      console.log("[Baileys] Saved credentials found — auto-connecting...");
      await this.connect(false, undefined, true);
    } catch {
      // No credentials saved yet — wait for manual connect
      console.log("[Baileys] No saved credentials — waiting for manual connect");
    }
  }

  // ── Link checking ─────────────────────────────────────────────────────────
  async checkGroupLink(inviteCode: string): Promise<{ status: "valid" | "invalid"; name?: string; members?: number }> {
    try {
      const info = await this.sock.groupGetInviteInfo(inviteCode);
      if (info && (info.subject || info.id)) {
        const name: string = ((info.subject ?? "").trim().split(/\s+/).slice(0, 3).join(" ")) || undefined!;
        const members: number | undefined =
          typeof info.size === "number" ? info.size :
          Array.isArray(info.participants) ? info.participants.length :
          undefined;
        return { status: "valid", name: name || undefined, members };
      }
      return { status: "invalid" };
    } catch (e: any) {
      const msg = (e?.message ?? "").toLowerCase();
      if (
        msg.includes("invalid") ||
        msg.includes("not-authorized") ||
        msg.includes("404") ||
        msg.includes("gone") ||
        msg.includes("bad")
      ) {
        return { status: "invalid" };
      }
      throw e;
    }
  }

  async checkPhoneNumber(rawNumber: string): Promise<"valid" | "invalid"> {
    const results = await this.sock.onWhatsApp(rawNumber + "@s.whatsapp.net");
    if (Array.isArray(results) && results.length > 0 && results[0].exists)
      return "valid";
    return "invalid";
  }

  async startLinkChecking(): Promise<void> {
    if (!this.isConnected()) throw new Error("WhatsApp غير متصل");
    const { whatsapp } = linkStore.extractedLinks;
    if (!whatsapp.length) throw new Error("لا توجد روابط واتساب للفحص");
    const session = linkStore.startSession(whatsapp);
    this.runChecks(session).catch(console.error);
  }

  private async runChecks(
    session: ReturnType<typeof linkStore.startSession>
  ): Promise<void> {
    for (let i = 0; i < session.links.length; i++) {
      const result = session.results[i];

      // Skip links already processed in a previous run
      if (result.status !== "pending") continue;

      if (!this.isConnected()) {
        session.status = "idle";
        linkStore.updateProgress();
        this.emit("session", session);
        return;
      }

      const link = session.links[i];

      try {
        const groupMatch = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
        const phoneMatch =
          link.match(/wa\.me\/([\d+]+)/) ?? link.match(/phone=([\d+]+)/);

        const t0 = Date.now();
        if (groupMatch) {
          const checkResult = await this.checkGroupLink(groupMatch[1]);
          const elapsed = Date.now() - t0;
          result.status = checkResult.status;
          result.name = checkResult.name;
          result.members = checkResult.members;
          result.info =
            result.status === "valid"
              ? "مجموعة نشطة"
              : "الرابط منتهٍ أو غير موجود";
          console.log(
            `[Check] ${result.status.toUpperCase()} | ${elapsed}ms | ${link}${result.name ? ` | ${result.name}` : ""}${result.members !== undefined ? ` | ${result.members} عضو` : ""}`
          );
        } else if (phoneMatch) {
          result.status = await this.checkPhoneNumber(
            phoneMatch[1].replace(/\D/g, "")
          );
          const elapsed = Date.now() - t0;
          result.info =
            result.status === "valid"
              ? "رقم مسجل في واتساب"
              : "رقم غير مسجل";
          console.log(`[Check] ${result.status.toUpperCase()} | ${elapsed}ms | ${link}`);
        } else {
          result.status = "error";
          result.info = "صيغة رابط غير معروفة";
          console.log(`[Check] ERROR | unknown format | ${link}`);
        }
      } catch (err: any) {
        result.status = "error";
        result.info = err.message ?? "خطأ في الفحص";
        console.log(`[Check] ERROR | ${err.message} | ${link}`);
      }

      session.progress = session.results.filter((r) => r.status !== "pending").length;
      linkStore.updateProgress();
      this.emit("session", session);

      if (i < session.links.length - 1) {
        const delay = 1000 + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    session.status = "done";
    session.completedAt = new Date().toISOString();
    linkStore.updateProgress();
    this.emit("session", session);
  }
}

export const baileysManager = new BaileysManager();
