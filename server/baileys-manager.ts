import { EventEmitter } from "events";
import qrcode from "qrcode";
import { linkStore } from "./link-store.js";
import {
  initMongo,
  useMongoAuthState,
  deleteMongoSession,
  mongoSessionHasCreds,
  extractPhoneFromCreds,
  loadAppMeta,
  saveAppMeta,
  type SessionMeta,
  type AppMeta,
} from "./mongo-auth-state.js";

export type WAStatus =
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "pairing"
  | "connected"
  | "auth_failed";

export interface WASessionInfo {
  id: string;
  displayName: string;
  phoneNumber?: string;
  status: WAStatus;
  isActive: boolean;
}

interface SessionState {
  id: string;
  displayName: string;
  phoneNumber?: string;
  status: WAStatus;
  qrCode: string | null;
  pairingCode: string | null;
  sock: any | null;
  isStarting: boolean;
}

let makeWASocket: any;
let DisconnectReason: any;
let fetchLatestBaileysVersion: any;

async function loadBaileys() {
  if (makeWASocket) return;
  const baileys = await import("@whiskeysockets/baileys");
  makeWASocket = (baileys as any).makeWASocket ?? (baileys as any).default;
  DisconnectReason = (baileys as any).DisconnectReason;
  fetchLatestBaileysVersion = (baileys as any).fetchLatestBaileysVersion;
}

class SessionsManager extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private _activeSessionId: string | null = null;
  private _appMeta: AppMeta = { activeSessionId: null, sessions: [] };
  private _ready = false;
  private _checkPaused = false;
  private _checkStopped = false;
  private _messageHandler: ((msgs: any[]) => void) | null = null;

  pauseCheck(): void {
    this._checkPaused = true;
    if (linkStore.checkSession && linkStore.checkSession.status === "running") {
      linkStore.checkSession.status = "paused";
      linkStore.updateProgress();
    }
  }

  resumeCheck(): void {
    this._checkPaused = false;
    if (linkStore.checkSession?.status === "paused") {
      linkStore.checkSession.status = "running";
      linkStore.updateProgress();
    }
  }

  stopCheck(): void {
    this._checkStopped = true;
    this._checkPaused = false;
  }

  // ── Public accessors ────────────────────────────────────────────────────────

  getSessions(): WASessionInfo[] {
    return this._appMeta.sessions.map((meta) => {
      const state = this.sessions.get(meta.id);
      return {
        id: meta.id,
        displayName: state?.phoneNumber
          ? `+${state.phoneNumber}`
          : meta.displayName,
        phoneNumber: state?.phoneNumber ?? meta.phoneNumber,
        status: state?.status ?? "disconnected",
        isActive: meta.id === this._activeSessionId,
      };
    });
  }

  get activeSessionId(): string | null { return this._activeSessionId; }
  getActiveState(): SessionState | null {
    return this._activeSessionId
      ? (this.sessions.get(this._activeSessionId) ?? null)
      : null;
  }

  getStatus(): WAStatus { return this.getActiveState()?.status ?? "disconnected"; }
  getQrCode(): string | null { return this.getActiveState()?.qrCode ?? null; }
  getPairingCode(): string | null { return this.getActiveState()?.pairingCode ?? null; }

  isConnected(): boolean {
    const s = this.getActiveState();
    return s?.status === "connected" && !!s.sock;
  }

  async hasSavedCredentials(): Promise<boolean> {
    if (!this._activeSessionId) return false;
    return mongoSessionHasCreds(this._activeSessionId).catch(() => false);
  }

  // ── Initialisation (called once on startup) ─────────────────────────────────

  async autoConnect(): Promise<void> {
    try {
      await initMongo();
    } catch (err) {
      console.error("[Sessions] MongoDB init failed — sessions unavailable:", err);
      return;
    }

    this._appMeta = await loadAppMeta();

    // One-time migration from .baileys-auth/ to MongoDB "default" session
    await this._migrateFileAuth();

    // Reload after potential migration
    this._appMeta = await loadAppMeta();

    // Populate in-memory states
    for (const meta of this._appMeta.sessions) {
      this.sessions.set(meta.id, {
        id: meta.id,
        displayName: meta.displayName,
        phoneNumber: meta.phoneNumber,
        status: "disconnected",
        qrCode: null,
        pairingCode: null,
        sock: null,
        isStarting: false,
      });
    }

    // Set active session
    this._activeSessionId = this._appMeta.activeSessionId;
    if (!this._activeSessionId && this._appMeta.sessions.length > 0) {
      this._activeSessionId = this._appMeta.sessions[0].id;
      this._appMeta.activeSessionId = this._activeSessionId;
      await saveAppMeta(this._appMeta);
    }

    this._ready = true;

    // Auto-connect all sessions that have saved credentials
    for (const meta of this._appMeta.sessions) {
      const hasCreds = await mongoSessionHasCreds(meta.id).catch(() => false);
      if (hasCreds) {
        console.log(`[Sessions] Auto-connecting: ${meta.displayName} (${meta.id})`);
        this._connectSession(meta.id, false, undefined, true).catch(console.error);
      }
    }
  }

  private async _migrateFileAuth(): Promise<void> {
    const alreadyMigrated = this._appMeta.sessions.some((s) => s.id === "default");
    if (alreadyMigrated) return;

    try {
      const { default: fs } = await import("fs/promises");
      const credsData = await fs.readFile(".baileys-auth/creds.json", "utf-8");

      console.log("[Sessions] Migrating .baileys-auth/ → MongoDB default session…");

      const { state, saveCreds } = await useMongoAuthState("default");
      const baileys = await import("@whiskeysockets/baileys");
      const { BufferJSON } = baileys as any;
      const fileCreds = JSON.parse(credsData, BufferJSON.reviver);
      Object.assign(state.creds, fileCreds);
      await saveCreds();

      // Migrate key files
      try {
        const files = await fs.readdir(".baileys-auth");
        for (const file of files) {
          if (file === "creds.json") continue;
          // Files are named like "pre-key-<id>.json", "session-<id>.json", etc.
          const match = file.match(/^(.+)-([^-]+)\.json$/);
          if (!match) continue;
          const [, type, keyId] = match;
          try {
            const raw = await fs.readFile(`.baileys-auth/${file}`, "utf-8");
            await state.keys.set({ [type]: { [keyId]: JSON.parse(raw, BufferJSON.reviver) } });
          } catch { /* skip unreadable keys */ }
        }
      } catch { /* no key files */ }

      const phoneNumber = fileCreds.me?.id?.split(":")[0]?.split("@")[0] ?? undefined;
      const newMeta: SessionMeta = {
        id: "default",
        displayName: phoneNumber ? `+${phoneNumber}` : "الجلسة الافتراضية",
        createdAt: new Date().toISOString(),
        phoneNumber,
      };
      this._appMeta.sessions.push(newMeta);
      if (!this._appMeta.activeSessionId) this._appMeta.activeSessionId = "default";
      await saveAppMeta(this._appMeta);
      console.log("[Sessions] Migration complete → default session created");
    } catch {
      // No .baileys-auth/ — nothing to migrate
    }
  }

  // ── Session CRUD ────────────────────────────────────────────────────────────

  async createSession(displayName?: string): Promise<string> {
    const { randomUUID } = await import("crypto");
    const id = randomUUID();
    const name = displayName || `جلسة ${this._appMeta.sessions.length + 1}`;
    const meta: SessionMeta = { id, displayName: name, createdAt: new Date().toISOString() };
    this._appMeta.sessions.push(meta);
    if (!this._activeSessionId) {
      this._activeSessionId = id;
      this._appMeta.activeSessionId = id;
    }
    this.sessions.set(id, {
      id, displayName: name, status: "disconnected",
      qrCode: null, pairingCode: null, sock: null, isStarting: false,
    });
    await saveAppMeta(this._appMeta);
    this.emit("sessions-updated", this.getSessions());
    return id;
  }

  async deleteSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s?.sock) { try { s.sock.end(undefined); } catch {} }
    this.sessions.delete(id);
    this._appMeta.sessions = this._appMeta.sessions.filter((m) => m.id !== id);
    await deleteMongoSession(id);
    if (this._activeSessionId === id) {
      this._activeSessionId = this._appMeta.sessions[0]?.id ?? null;
      this._appMeta.activeSessionId = this._activeSessionId;
    }
    await saveAppMeta(this._appMeta);
    this.emit("sessions-updated", this.getSessions());
  }

  async activateSession(id: string): Promise<void> {
    if (!this.sessions.has(id)) throw new Error("Session not found");
    this._activeSessionId = id;
    this._appMeta.activeSessionId = id;
    await saveAppMeta(this._appMeta);
    this.emit("status", this.getStatus());
    this.emit("sessions-updated", this.getSessions());
  }

  // ── Connect / disconnect ────────────────────────────────────────────────────

  async connect(usePairing = false, phoneNumber?: string, skipClearAuth = false): Promise<void> {
    let id = this._activeSessionId;
    if (!id) id = await this.createSession();
    await this._connectSession(id, usePairing, phoneNumber, skipClearAuth);
  }

  async connectWithSavedCredentials(): Promise<void> {
    if (this.isConnected()) return;
    const id = this._activeSessionId;
    if (!id) return;
    await this._connectSession(id, false, undefined, true);
  }

  async disconnect(): Promise<void> {
    if (this._activeSessionId) await this._disconnectSession(this._activeSessionId);
  }

  async disconnectSession(id: string): Promise<void> {
    await this._disconnectSession(id);
  }

  private async _disconnectSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const sock = s.sock;
    s.sock = null; s.isStarting = false; s.qrCode = null; s.pairingCode = null;
    if (sock) { try { sock.end(undefined); } catch {} }
    this._setStatus(id, "disconnected");
  }

  async resendPairingCode(phoneNumber: string): Promise<string> {
    const id = this._activeSessionId;
    if (!id) throw new Error("No active session");
    const s = this.sessions.get(id);
    if (!s?.sock) {
      await this._connectSession(id, true, phoneNumber, false);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const cur = this.sessions.get(id);
        if (cur?.pairingCode) return cur.pairingCode;
      }
      throw new Error("انتهت المهلة. حاول مرة أخرى.");
    }
    const code = await s.sock.requestPairingCode(phoneNumber.replace(/\D/g, ""));
    s.pairingCode = code;
    return code;
  }

  async clearCredentials(): Promise<void> {
    const id = this._activeSessionId;
    if (!id) return;
    await this._disconnectSession(id);
    await deleteMongoSession(id);
    this._setStatus(id, "disconnected");
    console.log(`[Sessions] Credentials cleared: ${id}`);
  }

  private async _connectSession(
    id: string,
    usePairing: boolean,
    phoneNumber: string | undefined,
    skipClearAuth: boolean
  ): Promise<void> {
    let s = this.sessions.get(id);
    if (!s) return;
    if (s.isStarting || s.sock) return;

    s.isStarting = true;
    this._setStatus(id, "connecting");

    try {
      await loadBaileys();

      if (usePairing && !skipClearAuth) {
        await deleteMongoSession(id);
        console.log(`[Sessions] Cleared auth for fresh pairing: ${id}`);
      }

      const { state: authState, saveCreds } = await useMongoAuthState(id);
      const { version } = await fetchLatestBaileysVersion();

      const silentLogger = {
        level: "silent",
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {}, fatal: () => {},
        child: () => silentLogger,
      };

      const sock = makeWASocket({
        version, auth: authState, logger: silentLogger as any,
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

      s = this.sessions.get(id)!;
      s.sock = sock;
      if (phoneNumber) s.phoneNumber = phoneNumber;

      // Pairing code flow
      if (usePairing && phoneNumber && !skipClearAuth) {
        const phone = phoneNumber.replace(/\D/g, "");
        this._setStatus(id, "pairing");
        let codeRequested = false;
        const requestCode = async () => {
          if (codeRequested) return;
          codeRequested = true;
          try {
            const code = await sock.requestPairingCode(phone);
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = code;
            console.log(`[Sessions] Pairing code for ${id}: ${code}`);
          } catch (err: any) {
            console.error(`[Sessions] Pairing code error:`, err?.message);
          }
        };
        const onFirstUpdate = () => {
          sock.ev.off("connection.update", onFirstUpdate);
          setTimeout(requestCode, 800);
        };
        sock.ev.on("connection.update", onFirstUpdate);
        setTimeout(requestCode, 5000);
      }

      // Connection events
      sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairing) {
          try {
            const cur = this.sessions.get(id);
            if (cur) {
              cur.qrCode = await qrcode.toDataURL(qr, {
                width: 280, margin: 2,
                color: { dark: "#111827", light: "#ffffff" },
              });
              this._setStatus(id, "qr_ready");
            }
          } catch (err) { console.error("[Sessions] QR error:", err); }
        }

        if (connection === "close") {
          const code = (lastDisconnect?.error as any)?.output?.statusCode;
          console.log(`[Sessions] ${id} closed, code: ${code}`);
          const cur = this.sessions.get(id);
          if (cur) { cur.sock = null; cur.isStarting = false; cur.qrCode = null; }

          if (code === 401 || code === 403) {
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            this._setStatus(id, "auth_failed");
          } else if (code === 515) {
            // Restart required — safe to reconnect automatically
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            this._setStatus(id, "connecting");
            setTimeout(() => this._connectSession(id, usePairing, phoneNumber, true), 2000);
          } else if (code === 440) {
            // Connection replaced by another WhatsApp Web session on the same account.
            // Do NOT auto-reconnect — that would just replace itself again (infinite loop).
            // Mark as disconnected and let the user decide.
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            console.log(`[Sessions] ${id} — connection replaced by another device. Manual reconnect required.`);
            this._setStatus(id, "disconnected");
          } else if (code === 428 || code === 408 || !code) {
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            this._setStatus(id, "connecting");
            setTimeout(() => this._connectSession(id, usePairing, phoneNumber, true), 3000);
          } else {
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            this._setStatus(id, "disconnected");
          }
        }

        if (connection === "open") {
          console.log(`[Sessions] ${id} connected!`);
          const cur = this.sessions.get(id);
          if (cur) { cur.qrCode = null; cur.pairingCode = null; }
          this._setStatus(id, "connected");

          // Update phone from credentials and persist
          const phone = await extractPhoneFromCreds(id).catch(() => null);
          if (phone) {
            const cur = this.sessions.get(id);
            if (cur) cur.phoneNumber = phone;
            const metaEntry = this._appMeta.sessions.find((m) => m.id === id);
            if (metaEntry) {
              metaEntry.phoneNumber = phone;
              metaEntry.displayName = `+${phone}`;
              saveAppMeta(this._appMeta).catch(console.error);
            }
            this.emit("sessions-updated", this.getSessions());
          }

          // Auto-resume checking if this is the active session
          if (id === this._activeSessionId) {
            const session = linkStore.checkSession;
            if (
              session &&
              (session.status === "idle" || session.status === "running") &&
              session.results.some((r) => r.status === "pending")
            ) {
              const remaining = session.results.filter((r) => r.status === "pending").length;
              console.log(`[Sessions] Auto-resuming check — ${remaining} links remaining`);
              setTimeout(() => this.startLinkChecking().catch(console.error), 2000);
            }
          }
        }
      });

      sock.ev.on("creds.update", saveCreds);

      // Attach message handler if one is registered
      if (this._messageHandler) {
        sock.ev.on("messages.upsert", (update: any) => {
          if (update.type === "notify") this._messageHandler!(update.messages ?? []);
        });
      }
    } catch (err) {
      console.error(`[Sessions] Init error for ${id}:`, err);
      const cur = this.sessions.get(id);
      if (cur) { cur.sock = null; cur.isStarting = false; }
      this._setStatus(id, "disconnected");
    }
  }

  private _setStatus(id: string, status: WAStatus): void {
    const s = this.sessions.get(id);
    if (s) { s.status = status; s.isStarting = false; }
    if (id === this._activeSessionId) this.emit("status", status);
    this.emit("session-status", { id, status });
  }

  // ── Link checking ───────────────────────────────────────────────────────────

  async startLinkChecking(): Promise<void> {
    if (!this.isConnected()) throw new Error("واتساب غير متصل");
    const { whatsapp } = linkStore.extractedLinks;
    if (!whatsapp.length) throw new Error("لا توجد روابط واتساب للفحص");
    this._checkPaused = false;
    this._checkStopped = false;
    const session = linkStore.startSession(whatsapp);
    this._runChecks(session).catch(console.error);
  }

  async startNewRoundChecking(): Promise<void> {
    if (!this.isConnected()) throw new Error("واتساب غير متصل");
    this._checkPaused = false;
    this._checkStopped = false;
    const session = linkStore.startNewRoundSession();
    this._runChecks(session).catch(console.error);
  }

  async checkGroupLink(inviteCode: string): Promise<{
    status: "valid" | "invalid"; name?: string; members?: number; description?: string;
  }> {
    const s = this.getActiveState();
    if (!s?.sock) throw new Error("Not connected");
    const LINK_TIMEOUT_MS = 8000;
    const checkPromise = s.sock.groupGetInviteInfo(inviteCode);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("link-timeout")), LINK_TIMEOUT_MS)
    );
    try {
      const info = await Promise.race([checkPromise, timeoutPromise]);
      if (info && (info.subject || info.id)) {
        const name: string = ((info.subject ?? "").trim().split(/\s+/).slice(0, 3).join(" ")) || undefined!;
        const members =
          typeof info.size === "number" ? info.size :
          Array.isArray(info.participants) ? info.participants.length : undefined;
        const description = (info.desc ?? "").trim() || undefined;
        return { status: "valid", name: name || undefined, members, description };
      }
      return { status: "invalid" };
    } catch (e: any) {
      const msg = (e?.message ?? "").toLowerCase();
      if (
        msg === "link-timeout" || msg.includes("invalid") || msg.includes("not-authorized") ||
        msg.includes("not found") || msg.includes("404") || msg.includes("gone") ||
        msg.includes("bad request") || msg.includes("forbidden") || msg.includes("item-not-found") ||
        msg.includes("expired")
      ) return { status: "invalid" };
      throw e;
    }
  }

  async checkPhoneNumber(rawNumber: string): Promise<"valid" | "invalid"> {
    const s = this.getActiveState();
    if (!s?.sock) throw new Error("Not connected");
    const results = await s.sock.onWhatsApp(rawNumber + "@s.whatsapp.net");
    return Array.isArray(results) && results.length > 0 && results[0].exists ? "valid" : "invalid";
  }

  private async _runChecks(
    session: ReturnType<typeof linkStore.startSession>
  ): Promise<void> {
    const BATCH_SIZE = 1000;
    const MAX_RATE_RETRIES = 5;
    let consecutiveRateLimits = 0;

    for (let i = 0; i < session.links.length; i++) {
      const result = session.results[i];
      if (result.status !== "pending") continue;

      // ── Stop check ──────────────────────────────────────────────────────────
      if (this._checkStopped) {
        this._checkStopped = false;
        session.status = "done";
        session.rateLimitInfo = null;
        session.completedAt = new Date().toISOString();
        linkStore.updateProgress();
        this.emit("session", session);
        break;
      }

      // ── Pause check — wait until resumed or stopped ──────────────────────
      while (this._checkPaused) {
        await new Promise((r) => setTimeout(r, 500));
        if (this._checkStopped) break;
      }
      if (this._checkStopped) {
        this._checkStopped = false;
        session.status = "done";
        session.rateLimitInfo = null;
        session.completedAt = new Date().toISOString();
        linkStore.updateProgress();
        this.emit("session", session);
        break;
      }

      if (!this.isConnected()) {
        session.status = "idle";
        session.rateLimitInfo = null;
        linkStore.updateProgress();
        this.emit("session", session);
        return;
      }

      const link = session.links[i];
      let retryCount = 0;
      let processed = false;

      while (!processed) {
        try {
          const groupMatch = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
          const phoneMatch = link.match(/wa\.me\/([\d+]+)/) ?? link.match(/phone=([\d+]+)/);

          const t0 = Date.now();
          if (groupMatch) {
            const checkResult = await this.checkGroupLink(groupMatch[1]);
            const elapsed = Date.now() - t0;
            result.status = checkResult.status;
            result.name = checkResult.name;
            result.members = checkResult.members;
            result.description = checkResult.description;
            result.info = result.status === "valid" ? "مجموعة نشطة" : "الرابط منتهٍ أو غير موجود";
            console.log(
              `[Check] ${result.status.toUpperCase()} | ${elapsed}ms | ${link}${result.name ? ` | ${result.name}` : ""}${result.members !== undefined ? ` | ${result.members} عضو` : ""}`
            );
            if (result.status === "valid" && result.description) {
              const injected = linkStore.injectDescriptionLinks(result.description, session);
              if (injected > 0) console.log(`[Check] Injected ${injected} links from "${result.name}"`);
            }
            consecutiveRateLimits = 0;
          } else if (phoneMatch) {
            result.status = await this.checkPhoneNumber(phoneMatch[1].replace(/\D/g, ""));
            const elapsed = Date.now() - t0;
            result.info = result.status === "valid" ? "رقم مسجل في واتساب" : "رقم غير مسجل";
            console.log(`[Check] ${result.status.toUpperCase()} | ${elapsed}ms | ${link}`);
            consecutiveRateLimits = 0;
          } else {
            result.status = "error";
            result.info = "صيغة رابط غير معروفة";
            console.log(`[Check] ERROR | unknown format | ${link}`);
            consecutiveRateLimits = 0;
          }
          processed = true;
          session.rateLimitInfo = null;
        } catch (err: any) {
          const msg = (err?.message ?? "").toLowerCase();
          const isRateLimit =
            msg.includes("rate-overlimit") || msg.includes("rate overlimit") ||
            msg.includes("too many") || msg.includes("429");

          if (isRateLimit && retryCount < MAX_RATE_RETRIES) {
            retryCount++;
            consecutiveRateLimits++;
            const isCooldown = consecutiveRateLimits >= 3;
            const backoffMs = isCooldown ? 90_000 : Math.min(15000 * Math.pow(1.8, retryCount - 1), 160000);
            const backoffSec = Math.round(backoffMs / 1000);

            console.log(
              `[Check] rate-overlimit | retry ${retryCount}/${MAX_RATE_RETRIES} | waiting ${backoffSec}s | ${link}`
            );
            if (isCooldown) {
              console.log(`[Check] ${consecutiveRateLimits} consecutive rate limits — 90s cooldown`);
            }

            session.rateLimitInfo = {
              waitUntil: Date.now() + backoffMs,
              retryCount,
              backoffSec,
              link,
            };
            linkStore.updateProgress();

            await new Promise((r) => setTimeout(r, backoffMs));

            if (isCooldown) consecutiveRateLimits = 0;
            session.rateLimitInfo = null;
          } else {
            result.status = "error";
            result.info = isRateLimit ? "تجاوز حد المعدل — أعد المحاولة لاحقاً" : (err.message ?? "خطأ في الفحص");
            console.log(`[Check] ERROR | ${err.message} | ${link}`);
            if (!isRateLimit) consecutiveRateLimits = 0;
            session.rateLimitInfo = null;
            processed = true;
          }
        }
      }

      session.progress = session.results.filter((r) => r.status !== "pending").length;
      linkStore.updateProgress();
      this.emit("session", session);

      const processedCount = session.progress;
      if (processedCount > 0 && processedCount % BATCH_SIZE === 0) {
        const batchNum = processedCount / BATCH_SIZE;
        if (!session.completedBatches.includes(batchNum)) {
          const batchStart = (batchNum - 1) * BATCH_SIZE;
          const batchEnd = batchNum * BATCH_SIZE;
          const batchResults = session.results.filter((r) => r.status !== "pending").slice(batchStart, batchEnd);
          linkStore.saveBatchResults(batchNum, batchResults).catch(console.error);
          console.log(`[Check] Batch ${batchNum} complete (${processedCount} links done)`);
        }
      }

      if (i < session.links.length - 1) {
        const baseDelay = consecutiveRateLimits > 0 ? 3500 : 1500;
        const jitter = consecutiveRateLimits > 0 ? 2500 : 1000;
        await new Promise((r) => setTimeout(r, baseDelay + Math.random() * jitter));
      }
    }

    session.status = "done";
    session.rateLimitInfo = null;
    session.completedAt = new Date().toISOString();
    linkStore.updateProgress();
    this.emit("session", session);

    const total = session.results.filter((r) => r.status !== "pending").length;
    const lastSavedBatch = session.completedBatches.length > 0 ? Math.max(...session.completedBatches) : 0;
    const alreadySaved = lastSavedBatch * BATCH_SIZE;
    if (total > alreadySaved) {
      const finalBatchNum = lastSavedBatch + 1;
      const remaining = session.results.filter((r) => r.status !== "pending").slice(alreadySaved);
      if (remaining.length > 0) {
        linkStore.saveBatchResults(finalBatchNum, remaining).catch(console.error);
        console.log(`[Check] Final batch ${finalBatchNum} saved (${remaining.length} links)`);
      }
    }
  }

  // ── Low-level primitives (used by join/leave/publisher/reader modules) ───────

  /** Join a group by invite code. Returns the group JID on success. */
  async joinGroup(inviteCode: string): Promise<string> {
    const s = this.getActiveState();
    if (!s?.sock) throw new Error("Not connected");
    const jid = await s.sock.groupAcceptInvite(inviteCode);
    return jid ?? "";
  }

  /**
   * Attempt to join a community via its invite code.
   * Communities share the same invite format but differ at the API level.
   * Falls back to standard groupAcceptInvite if the specific path fails.
   */
  async joinCommunity(inviteCode: string): Promise<string> {
    const s = this.getActiveState();
    if (!s?.sock) throw new Error("Not connected");
    // Try community-specific path first (Baileys v6+)
    try {
      if (typeof s.sock.communityRequestToJoinViaLink === "function") {
        const res = await s.sock.communityRequestToJoinViaLink(inviteCode);
        return res ?? "";
      }
    } catch { /* fall through */ }
    // Fallback: same as regular group join
    const jid = await s.sock.groupAcceptInvite(inviteCode);
    return jid ?? "";
  }

  /** Leave a group by its JID (e.g. "1234567890-1234567@g.us"). */
  async leaveGroup(groupJid: string): Promise<void> {
    const s = this.getActiveState();
    if (!s?.sock) throw new Error("Not connected");
    await s.sock.groupLeave(groupJid);
  }

  /** Send a plain text message to a JID (group or contact). */
  async sendTextMessage(jid: string, text: string): Promise<void> {
    const s = this.getActiveState();
    if (!s?.sock) throw new Error("Not connected");
    await s.sock.sendMessage(jid, { text });
  }

  /** Register a handler for incoming group messages across all active sockets. */
  setMessageHandler(handler: (msgs: any[]) => void): void {
    this._messageHandler = handler;
    // Attach to all already-connected sockets
    for (const [, sess] of this.sessions) {
      if (sess.sock) {
        sess.sock.ev.removeAllListeners("messages.upsert");
        sess.sock.ev.on("messages.upsert", (update: any) => {
          if (update.type === "notify") handler(update.messages ?? []);
        });
      }
    }
  }

  /** Remove the message handler. */
  clearMessageHandler(): void {
    this._messageHandler = null;
    for (const [, sess] of this.sessions) {
      if (sess.sock) sess.sock.ev.removeAllListeners("messages.upsert");
    }
  }

  // ── Legacy join-groups flow ──────────────────────────────────────────────────

  async startJoiningGroups(): Promise<void> {
    if (!this.isConnected()) throw new Error("واتساب غير متصل");
    const validGroups = linkStore.getValidGroupLinks();
    if (!validGroups.length) throw new Error("لا توجد مجموعات صالحة للانضمام");

    linkStore.joinSession = {
      status: "running",
      total: validGroups.length,
      progress: 0,
      joined: 0,
      failed: 0,
      joinedLinks: [],
      failedLinks: [],
      startedAt: new Date().toISOString(),
    };
    linkStore.saveToDisk().catch(console.error);
    this._runJoin(validGroups).catch(console.error);
  }

  private async _runJoin(groups: { link: string; name?: string }[]): Promise<void> {
    const s = this.getActiveState();
    if (!s?.sock) return;
    let batchCount = 0;

    for (let i = 0; i < groups.length; i++) {
      if (!linkStore.joinSession || linkStore.joinSession.status !== "running") break;
      if (!this.isConnected()) {
        if (linkStore.joinSession) linkStore.joinSession.status = "paused";
        linkStore.saveToDisk().catch(console.error);
        return;
      }

      const g = groups[i];
      const match = g.link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
      if (!match) { linkStore.joinSession.progress++; continue; }

      linkStore.joinSession.currentLink = g.link;
      try {
        await s.sock.groupAcceptInvite(match[1]);
        linkStore.joinSession.joined++;
        linkStore.joinSession.joinedLinks.push(g.link);
        console.log(`[Join] ✓ ${g.name ?? g.link}`);
      } catch (err: any) {
        linkStore.joinSession.failed++;
        linkStore.joinSession.failedLinks.push(g.link);
        console.log(`[Join] ✗ ${g.name ?? g.link} — ${err.message}`);
      }

      linkStore.joinSession.progress++;
      batchCount++;
      linkStore.saveToDisk().catch(console.error);

      if (batchCount % 30 === 0 && i < groups.length - 1) {
        console.log("[Join] Resting 60s after 30 joins...");
        for (let t = 0; t < 60; t++) {
          if (!linkStore.joinSession || linkStore.joinSession.status !== "running") return;
          await new Promise((r) => setTimeout(r, 1000));
        }
      } else if (i < groups.length - 1) {
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
      }
    }

    if (linkStore.joinSession) {
      linkStore.joinSession.status = "done";
      linkStore.joinSession.completedAt = new Date().toISOString();
      linkStore.joinSession.currentLink = undefined;
      linkStore.saveToDisk().catch(console.error);
      console.log(`[Join] Done — joined: ${linkStore.joinSession.joined}, failed: ${linkStore.joinSession.failed}`);
    }
  }
}

export const baileysManager = new SessionsManager();
export const sessionsManager = baileysManager;
