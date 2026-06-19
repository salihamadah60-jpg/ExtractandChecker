import { EventEmitter } from "events";
import qrcode from "qrcode";
import { linkStore, getLinkStoreFor } from "./link-store.js";
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

  // ── Per-workspace session routing ──────────────────────────────────────────
  /** sessionId → workspaceId — set when a workspace activates a session */
  private _workspaceIdBySessionId = new Map<string, string>();
  /** workspaceId → active sessionId */
  private _activeSessionByWorkspace = new Map<string, string>();
  /** workspaceId → message handler */
  private _messageHandlersByWorkspace = new Map<string, (msgs: any[]) => void>();

  // ── User-activity detection ────────────────────────────────────────────────
  /** IDs of messages sent BY the bot — used to distinguish bot vs user activity. */
  private _botSentIds   = new Set<string>();
  /** Timestamp of last detected MANUAL user action on WhatsApp (0 = none). */
  private _lastUserActivity = 0;

  // ── Pending-approval acceptance notifications ───────────────────────────────
  /** Per-workspace queue of recently-approved groups, cleared when read by API. */
  private _recentApprovals = new Map<string, Array<{ groupJid: string; url?: string; name?: string; approvedAt: string }>>();

  /** Return and clear the pending-approval acceptance notifications for a workspace. */
  getAndClearRecentApprovals(workspaceId: string): Array<{ groupJid: string; url?: string; name?: string; approvedAt: string }> {
    const list = this._recentApprovals.get(workspaceId) ?? [];
    this._recentApprovals.delete(workspaceId);
    return list;
  }

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

  /** Returns the phone number of the currently connected WhatsApp account. */
  getConnectedPhone(): string | null {
    const state = this.getActiveState();
    return state?.phoneNumber ?? null;
  }

  /**
   * Returns true if the user sent a manual WhatsApp message within the last `withinMs` ms.
   * Used by join / publish / read managers to pause when the user is active.
   */
  isUserActive(withinMs = 2 * 60_000): boolean {
    if (this._lastUserActivity === 0) return false;
    return Date.now() - this._lastUserActivity < withinMs;
  }

  /** Mark the bot is about to send — so incoming fromMe echoes are ignored. */
  private _trackBotSend(msgId: string | undefined): void {
    if (!msgId) return;
    this._botSentIds.add(msgId);
    setTimeout(() => this._botSentIds.delete(msgId), 60_000);
  }

  /** Process incoming messages: detect user activity + delegate to handler. */
  private _onMessages(messages: any[]): void {
    this._onMessagesFromSession("", messages);
  }

  private _onMessagesFromSession(sessionId: string, messages: any[]): void {
    for (const msg of messages) {
      if (msg.key?.fromMe && msg.key?.id && !this._botSentIds.has(msg.key.id as string)) {
        // Only count as real user activity for 1:1 chats with actual content.
        // Exclude: group messages (@g.us), broadcasts, status updates, and system stubs
        // (e.g. join-request confirmations, group-admin notifications).
        const remoteJid: string = msg.key?.remoteJid ?? "";
        const isGroupOrBroadcast =
          remoteJid.endsWith("@g.us") ||
          remoteJid.endsWith("@broadcast") ||
          remoteJid === "status@broadcast";
        const isSystemStub = msg.messageStubType != null;
        if (!isGroupOrBroadcast && !isSystemStub) {
          this._lastUserActivity = Date.now();
          console.log(`[Sessions] 👤 User activity detected (msgId: ${msg.key.id})`);
        }
      }
    }
    // Route to workspace-specific handler if session has a workspace.
    // Fall back to "main" workspace handler for sessions without a workspace mapping
    // so messages are never silently dropped.
    let workspaceId = sessionId ? this._workspaceIdBySessionId.get(sessionId) : undefined;

    // Self-healing: if no mapping found by sessionId, check if this session is the active
    // session for any workspace that has a registered handler — and fix the missing mapping.
    if (!workspaceId && sessionId) {
      for (const [wid] of this._messageHandlersByWorkspace) {
        if (this._activeSessionByWorkspace.get(wid) === sessionId) {
          workspaceId = wid;
          this._workspaceIdBySessionId.set(sessionId, wid); // fix missing mapping
          console.log(`[Sessions] 🔧 Auto-mapped session ${sessionId.slice(0,8)} → workspace ${wid.slice(0,8)}`);
          break;
        }
      }
    }

    if (workspaceId) {
      const wsHandler = this._messageHandlersByWorkspace.get(workspaceId);
      if (wsHandler) {
        wsHandler(messages);
      } else {
        // Workspace is mapped but reader not yet started — fall through to main
        this._messageHandlersByWorkspace.get("main")?.(messages) ?? this._messageHandler?.(messages);
      }
    } else {
      // No workspace mapping — route to "main" as fallback, then legacy global handler
      const mainHandler = this._messageHandlersByWorkspace.get("main");
      if (mainHandler) {
        mainHandler(messages);
      } else {
        this._messageHandler?.(messages);
      }
    }
  }

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

    // Restore per-workspace session mappings
    for (const meta of this._appMeta.sessions) {
      if (meta.workspaceId) {
        this._workspaceIdBySessionId.set(meta.id, meta.workspaceId);
        if (!this._activeSessionByWorkspace.has(meta.workspaceId)) {
          this._activeSessionByWorkspace.set(meta.workspaceId, meta.id);
        }
      }
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
        connectTimeoutMs:      90_000,  // 90s connect timeout (weak connections need more time)
        defaultQueryTimeoutMs: 90_000,  // 90s per-query timeout
        keepAliveIntervalMs:   25_000,  // send WS ping every 25s (less overhead on weak links)
        retryRequestDelayMs:   2_000,   // 2s between request retries (was 250ms — too aggressive)
        maxMsgRetryCount:      5,
        emitOwnEvents:         false,   // reduce internal event noise
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
            // Auto-reconnect after 30s — enough time for the other session to become idle.
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            this._setStatus(id, "disconnected");
            console.log(`[Sessions] ${id} — connection replaced (440). Auto-reconnecting in 30s…`);
            setTimeout(() => this._connectSession(id, usePairing, phoneNumber, true), 30_000);
          } else if (code === 428 || code === 408 || code === 503 || !code) {
            // 428 = precondition required, 408 = timeout, 503 = server unavailable — all transient, safe to retry
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            this._setStatus(id, "connecting");
            const retryDelay = code === 503 ? 8000 : 3000; // longer backoff for 503
            setTimeout(() => this._connectSession(id, usePairing, phoneNumber, true), retryDelay);
          } else {
            // Unknown disconnect code — auto-reconnect after 10s (covers edge cases)
            const cur = this.sessions.get(id);
            if (cur) cur.pairingCode = null;
            this._setStatus(id, "connecting");
            console.log(`[Sessions] ${id} — unknown disconnect code ${code ?? "?"}, auto-reconnecting in 10s…`);
            setTimeout(() => this._connectSession(id, usePairing, phoneNumber, true), 10_000);
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

          // Auto-start message reader for ANY session when it connects (not just active session)
          setTimeout(async () => {
            try {
              const { getMessageReaderFor } = await import("./modules/message-reader.js");
              const wid = this._workspaceIdBySessionId.get(id);
              if (wid) {
                await getMessageReaderFor(wid).autoStartIfEnabled();
              }
            } catch (err) {
              console.warn("[Sessions] Reader auto-start skipped:", (err as Error).message);
            }
          }, 5_000);
        }
      });

      sock.ev.on("creds.update", saveCreds);

      // Always register messages.upsert — handles both activity detection and delegating to handler
      sock.ev.on("messages.upsert", (update: any) => {
        if (update.type === "notify") this._onMessagesFromSession(id, update.messages ?? []);
      });

      // Detect removal/kick and admin-approval acceptance
      sock.ev.on("group-participants.update", async (update: any) => {
        const botJid = sock.user?.id;
        if (!botJid) return;
        const botId = botJid.split(":")[0] + "@s.whatsapp.net";
        const participants: string[] = update.participants ?? [];
        const botAffected = participants.some(p =>
          (typeof p === "string" ? p : (p as any)?.id ?? "").split(":")[0] + "@s.whatsapp.net" === botId
        );
        if (!botAffected) return;

        const groupJid: string = update.id;
        const _wid = this._workspaceIdBySessionId.get(id) ?? "main";

        if (update.action === "remove") {
          console.log(`[Sessions] Removed/left group: ${groupJid}`);
          try {
            const { linksRepository } = await import("./modules/links-repository.js");
            await linksRepository.markLeftByJid(_wid, groupJid);
          } catch (err) {
            console.warn("[Sessions] Failed to handle group removal:", (err as Error).message);
          }

        } else if (update.action === "add") {
          // Bot was accepted into a group that previously required admin approval
          console.log(`[Sessions] ✅ Bot accepted into group (was pending): ${groupJid}`);
          try {
            const db = await (await import("./mongo-auth-state.js")).getDb();
            const c = db.collection("Links_Repository");
            const result = await c.findOneAndUpdate(
              { workspaceId: _wid, groupJid, status: { $in: ["Ignored", "Pending"] } },
              { $set: { status: "Joined", joinedAt: new Date(), updatedAt: new Date() }, $unset: { pendingAdminApproval: "" } },
              { returnDocument: "after" }
            );
            if (result) {
              console.log(`[Sessions] ✅ Status updated to Joined for ${groupJid} (admin approved)`);
              // Store approval notification for the workspace so the UI can alert the user
              const existing = this._recentApprovals.get(_wid) ?? [];
              existing.push({
                groupJid,
                url: (result as any).url,
                name: (result as any).name,
                approvedAt: new Date().toISOString(),
              });
              this._recentApprovals.set(_wid, existing);
            } else {
              // Group wasn't in DB yet — insert it now
              const { linksRepository } = await import("./modules/links-repository.js");
              await linksRepository.addIfNew(_wid,
                `https://chat.whatsapp.com/wa-sync/${groupJid}`,
                "Group", "manual",
                { name: undefined }
              );
              await c.updateOne(
                { workspaceId: _wid, url: `https://chat.whatsapp.com/wa-sync/${groupJid}` },
                { $set: { status: "Joined", groupJid, joinedAt: new Date(), updatedAt: new Date() }, $unset: { pendingAdminApproval: "" } }
              );
              // Still notify
              const existing2 = this._recentApprovals.get(_wid) ?? [];
              existing2.push({ groupJid, approvedAt: new Date().toISOString() });
              this._recentApprovals.set(_wid, existing2);
            }
          } catch (err) {
            console.warn("[Sessions] Failed to handle admin approval:", (err as Error).message);
          }
        }
      });

      // Detect group deletion or other group-level updates that remove bot from group
      sock.ev.on("groups.update", async (updates: any[]) => {
        for (const update of updates) {
          if (!update?.id) continue;
          // If the update has `delete: true` the group was deleted
          if (update.delete) {
            const groupJid: string = update.id;
            console.log(`[Sessions] Group deleted: ${groupJid} — marking Left`);
            try {
              const { linksRepository } = await import("./modules/links-repository.js");
              const _wid = this._workspaceIdBySessionId.get(id) ?? "main";
              await linksRepository.markLeftByJid(_wid, groupJid);
            } catch (err) {
              console.warn("[Sessions] Failed to handle group deletion:", (err as Error).message);
            }
          }
        }
      });
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
    // Emit workspace-scoped status event
    const wid = this._workspaceIdBySessionId.get(id);
    if (wid && id === this._activeSessionByWorkspace.get(wid)) {
      this.emit("workspace-status", { workspaceId: wid, status });
    }
  }

  // ── Link checking ───────────────────────────────────────────────────────────

  async startLinkChecking(workspaceId = "main"): Promise<void> {
    if (!this.isConnected()) throw new Error("واتساب غير متصل");
    const ls = getLinkStoreFor(workspaceId);
    const { whatsapp } = ls.extractedLinks;
    if (!whatsapp.length) throw new Error("لا توجد روابط واتساب للفحص");
    this._checkPaused = false;
    this._checkStopped = false;
    const session = ls.startSession(whatsapp);
    this._runChecks(session).catch(console.error);
  }

  async startNewRoundChecking(workspaceId = "main"): Promise<void> {
    if (!this.isConnected()) throw new Error("واتساب غير متصل");
    const ls = getLinkStoreFor(workspaceId);
    this._checkPaused = false;
    this._checkStopped = false;
    const session = ls.startNewRoundSession();
    this._runChecks(session).catch(console.error);
  }

  /** Resume checking on the current session without resetting it (for retry-errors). */
  async resumeChecking(workspaceId = "main"): Promise<void> {
    if (!this.isConnected()) throw new Error("واتساب غير متصل");
    const ls = getLinkStoreFor(workspaceId);
    const session = ls.checkSession;
    if (!session) throw new Error("لا توجد جلسة فحص محفوظة");
    if (!session.results.some((r) => r.status === "pending")) throw new Error("لا توجد روابط معلقة للفحص");
    this._checkPaused = false;
    this._checkStopped = false;
    session.status = "running";
    ls.updateProgress();
    this._runChecks(session).catch(console.error);
  }

  /**
   * Check a list of URLs independently of the linkStore session.
   * Used by the message-reader sequential pipeline.
   */
  async checkLinksForPipeline(urls: string[]): Promise<Array<{
    url: string;
    status: "valid" | "invalid" | "error";
    name?: string;
    members?: number;
    description?: string;
  }>> {
    const results: Array<{
      url: string; status: "valid" | "invalid" | "error";
      name?: string; members?: number; description?: string;
    }> = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const match = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
      if (!match) {
        results.push({ url, status: "invalid" });
        continue;
      }
      try {
        const info = await this.checkGroupLink(match[1]);
        results.push({ url, ...info });
        console.log(`[PipelineCheck] ${info.status.toUpperCase()} | ${url}${info.name ? ` | ${info.name}` : ""}${info.members !== undefined ? ` | ${info.members} عضو` : ""}`);
      } catch (err: any) {
        results.push({ url, status: "error" });
        console.warn(`[PipelineCheck] ERROR | ${url} | ${err.message}`);
      }
      // Anti-ban delay between checks (skip after last)
      if (i < urls.length - 1) {
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
      }
    }

    return results;
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
    const result = await s.sock.sendMessage(jid, { text });
    // Track this as a bot-sent message so activity detection ignores its echo
    this._trackBotSend(result?.key?.id);
  }

  /**
   * Register a handler for incoming group messages.
   * No need to re-register socket listeners — _connectSession always calls _onMessages
   * which delegates to _messageHandler.
   */
  setMessageHandler(handler: (msgs: any[]) => void): void {
    this._messageHandler = handler;
  }

  /** Remove the message handler (socket listener stays active for activity detection). */
  clearMessageHandler(): void {
    this._messageHandler = null;
  }

  // ── Per-workspace methods ──────────────────────────────────────────────────────

  getActiveStateForWorkspace(workspaceId: string): SessionState | null {
    const sessionId = this._activeSessionByWorkspace.get(workspaceId);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  getActiveSessionIdForWorkspace(workspaceId: string): string | null {
    return this._activeSessionByWorkspace.get(workspaceId) ?? null;
  }

  isConnectedForWorkspace(workspaceId: string): boolean {
    const s = this.getActiveStateForWorkspace(workspaceId);
    return !!(s && s.status === "connected" && s.sock);
  }

  async hasSavedCredentialsForWorkspace(workspaceId: string): Promise<boolean> {
    const sessionId = this._activeSessionByWorkspace.get(workspaceId);
    if (!sessionId) return false;
    return mongoSessionHasCreds(sessionId).catch(() => false);
  }

  getConnectedPhoneForWorkspace(workspaceId: string): string | null {
    return this.getActiveStateForWorkspace(workspaceId)?.phoneNumber ?? null;
  }

  getSessionsForWorkspace(workspaceId: string): WASessionInfo[] {
    return this._appMeta.sessions
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => {
        const s = this.sessions.get(m.id);
        return {
          id: m.id,
          displayName: s?.phoneNumber ? `+${s.phoneNumber}` : m.displayName,
          phoneNumber: s?.phoneNumber ?? m.phoneNumber,
          status: s?.status ?? "disconnected" as WAStatus,
          isActive: m.id === (this._activeSessionByWorkspace.get(workspaceId) ?? null),
        };
      });
  }

  async createSessionForWorkspace(displayName: string, workspaceId: string): Promise<string> {
    const id = await this.createSession(displayName);
    const meta = this._appMeta.sessions.find((m) => m.id === id);
    if (meta) {
      meta.workspaceId = workspaceId;
      await saveAppMeta(this._appMeta);
    }
    this._workspaceIdBySessionId.set(id, workspaceId);
    this._activeSessionByWorkspace.set(workspaceId, id);
    return id;
  }

  activateSessionForWorkspace(sessionId: string, workspaceId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error("Session not found");
    this._activeSessionByWorkspace.set(workspaceId, sessionId);
    this._workspaceIdBySessionId.set(sessionId, workspaceId);
    const meta = this._appMeta.sessions.find((m) => m.id === sessionId);
    if (meta && !meta.workspaceId) {
      meta.workspaceId = workspaceId;
      saveAppMeta(this._appMeta).catch(console.error);
    }
  }

  /**
   * Connect (or reconnect) the session that belongs to this workspace WITHOUT
   * touching the global _activeSessionId.  This ensures workspace-B's connection
   * attempt never displaces workspace-A's slot in the global active-session field.
   */
  async connectForWorkspace(
    workspaceId: string,
    usePairing: boolean,
    phoneNumber?: string,
    skipClearAuth = false
  ): Promise<void> {
    let sessionId = this._activeSessionByWorkspace.get(workspaceId) ?? null;
    if (!sessionId) {
      sessionId = await this.createSessionForWorkspace("", workspaceId);
    }
    // Ensure workspace binding is up-to-date (no global side-effects)
    this._workspaceIdBySessionId.set(sessionId, workspaceId);
    this._activeSessionByWorkspace.set(workspaceId, sessionId);
    await this._connectSession(sessionId, usePairing, phoneNumber, skipClearAuth);
  }

  setMessageHandlerForWorkspace(workspaceId: string, handler: (msgs: any[]) => void): void {
    this._messageHandlersByWorkspace.set(workspaceId, handler);
  }

  clearMessageHandlerForWorkspace(workspaceId: string): void {
    this._messageHandlersByWorkspace.delete(workspaceId);
  }

  async checkLinksForPipelineForWorkspace(urls: string[], workspaceId: string): Promise<Array<{
    url: string; status: "valid" | "invalid" | "error";
    name?: string; members?: number; description?: string;
  }>> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");
    const results: Array<{ url: string; status: "valid" | "invalid" | "error"; name?: string; members?: number; description?: string }> = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const match = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
      if (!match) { results.push({ url, status: "invalid" }); continue; }
      try {
        const info = await this._checkGroupLinkWithSession(s, match[1]);
        results.push({ url, ...info });
        console.log(`[PipelineCheck:${workspaceId}] ${info.status.toUpperCase()} | ${url}`);
      } catch (err: any) {
        results.push({ url, status: "error" });
        console.warn(`[PipelineCheck:${workspaceId}] ERROR | ${url} | ${err.message}`);
      }
      if (i < urls.length - 1) await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
    }
    return results;
  }

  private async _checkGroupLinkWithSession(s: SessionState, inviteCode: string): Promise<{
    status: "valid" | "invalid"; name?: string; members?: number; description?: string;
  }> {
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
        const members = typeof info.size === "number" ? info.size : Array.isArray(info.participants) ? info.participants.length : undefined;
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

  async joinGroupForWorkspace(inviteCode: string, workspaceId: string): Promise<string> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");
    const jid = await s.sock.groupAcceptInvite(inviteCode);
    return jid ?? "";
  }

  async joinCommunityForWorkspace(inviteCode: string, workspaceId: string): Promise<string> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");
    try {
      if (typeof s.sock.communityRequestToJoinViaLink === "function") {
        const res = await s.sock.communityRequestToJoinViaLink(inviteCode);
        return res ?? "";
      }
    } catch { /* fall through */ }
    const jid = await s.sock.groupAcceptInvite(inviteCode);
    return jid ?? "";
  }

  async leaveGroupForWorkspace(groupJid: string, workspaceId: string): Promise<void> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");
    await s.sock.groupLeave(groupJid);
  }

  async sendTextMessageForWorkspace(jid: string, text: string, workspaceId: string): Promise<void> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");
    const result = await s.sock.sendMessage(jid, { text });
    this._trackBotSend(result?.key?.id);
  }

  async sendAdMessageForWorkspace(
    jid: string,
    ad: { text: string; mediaData?: string; mediaType?: string; mediaCaption?: string; mediaFilename?: string },
    workspaceId: string,
  ): Promise<void> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");

    let content: any;
    if (ad.mediaData && ad.mediaType) {
      const buf = Buffer.from(ad.mediaData, "base64");
      const caption = ad.mediaCaption ?? ad.text ?? "";
      if (ad.mediaType === "image") {
        content = { image: buf, caption };
      } else if (ad.mediaType === "video") {
        content = { video: buf, caption };
      } else {
        content = {
          document: buf,
          fileName: ad.mediaFilename ?? "file",
          mimetype: "application/octet-stream",
          caption,
        };
      }
    } else {
      content = { text: ad.text };
    }

    const result = await s.sock.sendMessage(jid, content);
    this._trackBotSend(result?.key?.id);
  }

  async getGroupMetadataForWorkspace(jid: string, workspaceId: string): Promise<any | null> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) return null;
    try { return await s.sock.groupMetadata(jid); } catch { return null; }
  }

  /**
   * Fetch ALL groups the connected account is currently in via WhatsApp.
   * Uses groupFetchAllParticipating() — the definitive source of truth.
   * Returns a flat array of group objects.
   */
  async syncGroupsForWorkspace(workspaceId: string): Promise<{ synced: number; markedLeft: number }> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");

    console.log(`[Sessions] Fetching all participating groups for workspace: ${workspaceId}`);
    const allGroups: Record<string, any> = await s.sock.groupFetchAllParticipating();
    const groupsArr = Object.values(allGroups);
    console.log(`[Sessions] Found ${groupsArr.length} groups from WhatsApp for workspace: ${workspaceId}`);

    // Pass the current phone number so it gets recorded in joinedByPhones for every synced group.
    // Without this, groups joined outside the app would have an empty joinedByPhones and
    // the join-manager would attempt to re-join them (risking account bans).
    const currentPhone = this.getConnectedPhoneForWorkspace(workspaceId) ?? this.getConnectedPhone() ?? undefined;

    const { linksRepository } = await import("./modules/links-repository.js");
    return linksRepository.syncFromWhatsAppGroups(workspaceId, groupsArr, currentPhone);
  }

  /**
   * Sync pending links with WhatsApp — the correct "مزامنة مع هذا الحساب" action.
   *
   * Algorithm:
   *  1. Fetch all groups the current session is in (groupFetchAllParticipating).
   *  2. Get every Pending link from the DB.
   *  3. Fast path  — if the link already has a stored groupJid and it is in the active set → mark Joined.
   *  4. Slow path  — for unmatched links whose URL contains an invite code, call
   *                  groupGetInviteInfo(code) to resolve the JID, then check the active set.
   *     (Rate-limited: 400 ms delay, max 50 lookups per call to avoid WA bans.)
   */
  async syncPendingLinksWithWhatsApp(workspaceId: string): Promise<{
    matched: number; byJid: number; byCode: number; checked: number; skipped: number;
  }> {
    const s = this.getActiveStateForWorkspace(workspaceId);
    if (!s?.sock) throw new Error("واتساب غير متصل لهذه المساحة");

    const currentPhone = this.getConnectedPhoneForWorkspace(workspaceId) ?? this.getConnectedPhone() ?? undefined;

    console.log(`[Sessions] syncPendingLinks — fetching WA groups for workspace: ${workspaceId}`);
    const allGroups: Record<string, any> = await s.sock.groupFetchAllParticipating();
    const activeJidSet = new Set(Object.keys(allGroups));
    console.log(`[Sessions] syncPendingLinks — ${activeJidSet.size} active WA groups found`);

    const { linksRepository } = await import("./modules/links-repository.js");
    const pendingLinks = await linksRepository.getPendingLinks(workspaceId);
    console.log(`[Sessions] syncPendingLinks — ${pendingLinks.length} pending links to check`);

    let byJid   = 0;
    let byCode  = 0;
    let checked = 0;
    const needCodeLookup: Array<{ url: string; code: string }> = [];

    // ── Fast path: match by stored groupJid ───────────────────────────────────
    for (const link of pendingLinks) {
      if (link.groupJid && activeJidSet.has(link.groupJid)) {
        await linksRepository.markJoinedBySync(workspaceId, link.url, link.groupJid, currentPhone);
        byJid++;
      } else {
        // Extract invite code from URL for slow-path lookup
        const m = (link.url ?? "").match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
        if (m?.[1]) needCodeLookup.push({ url: link.url, code: m[1] });
      }
    }

    // ── Slow path: resolve invite code → JID, then check active set ──────────
    const MAX_LOOKUPS = 50;
    const skipped = Math.max(0, needCodeLookup.length - MAX_LOOKUPS);
    for (const { url, code } of needCodeLookup.slice(0, MAX_LOOKUPS)) {
      checked++;
      try {
        await new Promise(r => setTimeout(r, 400)); // gentle rate-limit
        const info = await (s.sock as any).groupGetInviteInfo(code);
        const jid = info?.id ?? info?.gid;
        if (jid && activeJidSet.has(jid)) {
          await linksRepository.markJoinedBySync(workspaceId, url, jid, currentPhone);
          byCode++;
        }
      } catch {
        // Expired / invalid invite code — silently skip
      }
    }

    const matched = byJid + byCode;
    console.log(
      `[Sessions] syncPendingLinks done — matched:${matched} (byJid:${byJid} byCode:${byCode}) ` +
      `checked:${checked}/${needCodeLookup.length} skipped:${skipped}`
    );
    return { matched, byJid, byCode, checked, skipped };
  }

  /**
   * Fetch live group metadata (name, participants, announce flag, etc.).
   * Returns null on any error (e.g. not connected, JID not found).
   */
  async getGroupMetadata(jid: string): Promise<any | null> {
    const s = this.getActiveState();
    if (!s?.sock) return null;
    try {
      return await s.sock.groupMetadata(jid);
    } catch { return null; }
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
