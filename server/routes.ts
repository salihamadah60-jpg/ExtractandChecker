import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import mammoth from "mammoth";
import { Document, Paragraph, TextRun, HeadingLevel, Packer, AlignmentType } from "docx";
import { getLinkStoreFor, isMedicalGroup, hasExcludedDescription, isAdOnlyMedicalGroup, type FilteredGroup } from "./link-store.js";
import { baileysManager } from "./baileys-manager.js";
import { checkLinksHTTP } from "./http-checker.js";
import { coordinator, getCoordinatorFor } from "./modules/function-coordinator.js";
import { linksRepository } from "./modules/links-repository.js";
import { getJoinManagerFor } from "./modules/join-manager.js";
import { telemetry, getTelemetryFor } from "./modules/telemetry.js";
import { getLeaveManagerFor } from "./modules/leave-manager.js";
import { getPublisherFor } from "./modules/publisher.js";
import { getMessageReaderFor } from "./modules/message-reader.js";
import { workspaceStore } from "./modules/workspace.js";
import { adminStore } from "./modules/admin.js";
import { centralLinksStore } from "./modules/central-links.js";
import { adminAuth } from "./middleware/admin-auth.js";
import { getJoinConfig, setJoinConfig } from "./modules/join-config.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.docx?$/i)) cb(null, true);
    else cb(new Error("يجب رفع ملف DOCX فقط"));
  },
});

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Groups and channels only — personal contacts, API links, and wa.me/phone are excluded
function extractLinks(text: string, html: string) {
  const combined = text + " " + html;
  const waRegex =
    /https?:\/\/(?:chat\.whatsapp\.com\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%.+-]+)?|whatsapp\.com\/channel\/[A-Za-z0-9_-]+)/g;
  const tgRegex =
    /https?:\/\/(?:t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+|t\.me\/[A-Za-z0-9_]+|telegram\.me\/[A-Za-z0-9_]+)/g;
  const waRaw = [...combined.matchAll(waRegex)].map((m) =>
    m[0].replace(/[.,;)>\]'"»]+$/, "")
  );
  const tgRaw = [...combined.matchAll(tgRegex)].map((m) =>
    m[0].replace(/[.,;)>\]'"»]+$/, "")
  );
  const dedup = (arr: string[]) =>
    [...new Set(arr.map((l) => l.trim()).filter(Boolean))];
  return { whatsapp: dedup(waRaw), telegram: dedup(tgRaw) };
}

const BATCH_SIZE_EXPORT = 40;

// ── Build DOCX for valid filtered groups ─────────────────────────────────────
async function buildGroupsDocx(groups: FilteredGroup[]): Promise<Buffer> {
  const children: any[] = [
    new Paragraph({
      text: "ملف المجموعات النشطة",
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      text: `إجمالي المجموعات: ${groups.length}`,
      spacing: { after: 300 },
    }),
  ];

  // Section header: Medical groups
  const medicalGroups = groups.filter((g) => isMedicalGroup(g.name));
  const otherGroups = groups.filter((g) => !isMedicalGroup(g.name));

  const renderGroups = (list: FilteredGroup[], sectionLabel?: string) => {
    if (!list.length) return;
    if (sectionLabel) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: sectionLabel, bold: true, size: 26, color: "1a5276" })],
          spacing: { before: 300, after: 120 },
        })
      );
    }
    list.forEach((g, idx) => {
      // Batch separator every 40 entries
      if (idx > 0 && idx % BATCH_SIZE_EXPORT === 0) {
        children.push(new Paragraph({ text: "", spacing: { before: 400, after: 400 } }));
      }
      // Header line: Name + member count
      const headerText = g.name
        ? `${g.name} ${g.members} عضو`
        : `${g.members} عضو`;
      children.push(
        new Paragraph({
          children: [new TextRun({ text: headerText, bold: true })],
          spacing: { after: 40 },
        })
      );
      // Link line
      children.push(
        new Paragraph({
          children: [new TextRun({ text: g.link, color: "1a73e8" })],
          spacing: { after: 160 },
        })
      );
    });
  };

  if (medicalGroups.length > 0) {
    renderGroups(medicalGroups, `[ الطب والصحة — ${medicalGroups.length} مجموعة ]`);
  }
  if (otherGroups.length > 0) {
    if (medicalGroups.length > 0) {
      children.push(new Paragraph({ text: "", spacing: { before: 400, after: 200 } }));
    }
    renderGroups(otherGroups, otherGroups.length > 0 && medicalGroups.length > 0 ? `[ مجموعات أخرى — ${otherGroups.length} مجموعة ]` : undefined);
  }

  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

// ── Build DOCX for ads groups ─────────────────────────────────────────────────
async function buildAdsDocx(ads: FilteredGroup[]): Promise<Buffer> {
  // Ads file contains ONLY non-medical groups — medical groups go in the groups file
  const adsList = ads.filter((g) => !isMedicalGroup(g.name));

  const children: any[] = [
    new Paragraph({
      text: "ملف الإعلانات (10–150 عضواً مع وصف)",
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      text: `إجمالي المجموعات: ${adsList.length}`,
      spacing: { after: 300 },
    }),
  ];

  adsList.forEach((g, idx) => {
    if (idx > 0 && idx % BATCH_SIZE_EXPORT === 0) {
      children.push(new Paragraph({ text: "", spacing: { before: 400, after: 400 } }));
    }
    const headerText = g.name ? `${g.name} ${g.members} عضو` : `${g.members} عضو`;
    children.push(new Paragraph({ children: [new TextRun({ text: headerText, bold: true })], spacing: { after: 40 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: g.link, color: "1a73e8" })], spacing: { after: 160 } }));
  });

  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

async function buildValidDocx(results: { link: string; name?: string; members?: number }[]): Promise<Buffer> {
  // Dedup by link
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const clean = r.link.replace(/[.,;)>\]'"]+$/, "").trim();
    if (seen.has(clean)) return false;
    seen.add(clean);
    return true;
  });

  const children: any[] = [
    new Paragraph({ text: "روابط واتساب الصالحة", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `إجمالي الروابط: ${deduped.length}`, spacing: { after: 300 } }),
  ];

  deduped.forEach((r, idx) => {
    if (idx > 0 && idx % BATCH_SIZE_EXPORT === 0) {
      children.push(new Paragraph({ text: "", spacing: { before: 400, after: 400 } }));
    }
    const headerText = r.name
      ? `${r.name}${r.members !== undefined ? ` ${r.members} عضو` : ""}`
      : null;
    if (headerText) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: headerText, bold: true })], spacing: { after: 40 } })
      );
    }
    children.push(
      new Paragraph({
        children: [new TextRun({ text: r.link.replace(/[.,;)>\]'"]+$/, "").trim(), color: "1a73e8" })],
        spacing: { after: 160 },
      })
    );
  });

  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

async function buildDocx(title: string, links: string[]): Promise<Buffer> {
  // Dedup links
  const deduped = [...new Set(links.map((l) => l.replace(/[.,;)>\]'"]+$/, "").trim()).filter(Boolean))];
  const children: any[] = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `إجمالي الروابط: ${deduped.length}`, spacing: { after: 300 } }),
  ];
  deduped.forEach((link, idx) => {
    if (idx > 0 && idx % BATCH_SIZE_EXPORT === 0) {
      children.push(new Paragraph({ text: "", spacing: { before: 400, after: 400 } }));
    }
    children.push(
      new Paragraph({ children: [new TextRun({ text: link, color: "1a73e8" })], spacing: { after: 100 } })
    );
  });
  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ── Health check (used by frontend to detect server reachability) ──────────
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // ── Upload DOCX ────────────────────────────────────────────────────────────
  app.post("/api/upload", upload.single("file"), async (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ error: "لم يتم إرسال ملف" });
      const [htmlResult, textResult] = await Promise.all([
        mammoth.convertToHtml({ buffer: req.file.buffer }),
        mammoth.extractRawText({ buffer: req.file.buffer }),
      ]);
      const extracted = extractLinks(textResult.value, htmlResult.value);
      if (!extracted.whatsapp.length && !extracted.telegram.length)
        return res.status(400).json({ error: "لم يتم العثور على روابط واتساب أو تيليغرام في الملف" });

      // Dedup WhatsApp links against MongoDB repository if available
      if (process.env.MONGODB_URI) {
        try {
          const knownUrls = await linksRepository.getAllUrls(req.workspaceId ?? "main");
          const before = extracted.whatsapp.length;
          extracted.whatsapp = extracted.whatsapp.filter((u) => !knownUrls.has(u));
          const skipped = before - extracted.whatsapp.length;
          if (skipped > 0) console.log(`[Upload] Deduped ${skipped} already-known links from repository`);
        } catch { /* DB unavailable — proceed without dedup */ }
      }

      const ls = getLinkStoreFor(req.workspaceId ?? "main");
      ls.setExtracted(extracted);
      ls.saveLinksToFile(req.file.originalname, extracted).catch(console.error);
      res.json({ success: true, whatsapp: extracted.whatsapp.length, telegram: extracted.telegram.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "خطأ في معالجة الملف" });
    }
  });

  // ── Upload multiple DOCX files (merge + dedup) ─────────────────────────────
  app.post("/api/upload-multiple", upload.array("files", 20), async (req: any, res: any) => {
    try {
      const files: Express.Multer.File[] = req.files;
      if (!files?.length) return res.status(400).json({ error: "لم يتم إرسال ملفات" });

      const allWhatsapp = new Set<string>();
      const allTelegram = new Set<string>();
      let processedFiles = 0;

      for (const file of files) {
        try {
          const [htmlResult, textResult] = await Promise.all([
            mammoth.convertToHtml({ buffer: file.buffer }),
            mammoth.extractRawText({ buffer: file.buffer }),
          ]);
          const extracted = extractLinks(textResult.value, htmlResult.value);
          extracted.whatsapp.forEach((l) => allWhatsapp.add(l));
          extracted.telegram.forEach((l) => allTelegram.add(l));
          processedFiles++;
        } catch (err: any) {
          console.warn(`[UploadMultiple] Failed to process ${file.originalname}:`, err.message);
        }
      }

      if (!allWhatsapp.size && !allTelegram.size) {
        return res.status(400).json({ error: "لم يتم العثور على روابط في الملفات" });
      }

      // Dedup against MongoDB repository if available
      if (process.env.MONGODB_URI) {
        try {
          const knownUrls = await linksRepository.getAllUrls(req.workspaceId ?? "main");
          for (const url of [...allWhatsapp]) {
            if (knownUrls.has(url)) allWhatsapp.delete(url);
          }
        } catch { /* skip if DB unavailable */ }
      }

      const mergedLinks = {
        whatsapp: [...allWhatsapp],
        telegram: [...allTelegram],
      };

      const combinedName = `multi-${files.map((f) => f.originalname.replace(/\.docx?$/i, "")).join("-").slice(0, 50)}.docx`;
      const ls = getLinkStoreFor(req.workspaceId ?? "main");
      ls.setExtracted(mergedLinks);
      ls.saveLinksToFile(combinedName, mergedLinks).catch(console.error);

      res.json({
        success: true,
        filesProcessed: processedFiles,
        whatsapp: mergedLinks.whatsapp.length,
        telegram: mergedLinks.telegram.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "خطأ في معالجة الملفات" });
    }
  });

  // ── Upload new round DOCX (dedup against existing session) ─────────────────
  app.post("/api/upload-new-round", upload.array("files", 20), async (req: any, res: any) => {
    try {
      const files: Express.Multer.File[] = req.files ?? (req.file ? [req.file] : []);
      if (!files.length) return res.status(400).json({ error: "لم يتم إرسال ملف" });

      // Merge links from all files
      const waSet = new Set<string>();
      const tgSet = new Set<string>();
      for (const f of files) {
        const [htmlResult, textResult] = await Promise.all([
          mammoth.convertToHtml({ buffer: f.buffer }),
          mammoth.extractRawText({ buffer: f.buffer }),
        ]);
        const extracted = extractLinks(textResult.value, htmlResult.value);
        extracted.whatsapp.forEach((l) => waSet.add(l));
        extracted.telegram.forEach((l) => tgSet.add(l));
      }

      if (!waSet.size && !tgSet.size)
        return res.status(400).json({ error: "لم يتم العثور على روابط واتساب أو تيليغرام في الملفات" });

      const ls = getLinkStoreFor(req.workspaceId ?? "main");
      const { uniqueWhatsapp, uniqueTelegram, skipped } = ls.prepareNewRound(
        [...waSet],
        [...tgSet],
        files.map((f) => f.originalname).join(", ")
      );

      res.json({
        success: true,
        newWhatsapp: uniqueWhatsapp.length,
        newTelegram: uniqueTelegram.length,
        skipped,
        total: uniqueWhatsapp.length + uniqueTelegram.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "خطأ في معالجة الملف" });
    }
  });

  // ── Download links ─────────────────────────────────────────────────────────
  app.get("/api/download/whatsapp", async (req: any, res) => {
    const ls = getLinkStoreFor(req.workspaceId ?? "main");
    const links = ls.extractedLinks.whatsapp;
    if (!links.length) return res.status(404).json({ error: "لا توجد روابط واتساب" });
    const buf = await buildDocx("روابط واتساب", links);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="whatsapp-links.docx"`);
    res.send(buf);
  });

  app.get("/api/download/telegram", async (req: any, res) => {
    const ls = getLinkStoreFor(req.workspaceId ?? "main");
    const links = ls.extractedLinks.telegram;
    if (!links.length) return res.status(404).json({ error: "لا توجد روابط تيليغرام" });
    const buf = await buildDocx("روابط تيليغرام", links);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="telegram-links.docx"`);
    res.send(buf);
  });

  // ── Sessions management ────────────────────────────────────────────────────
  app.get("/api/sessions", (req: any, res) => {
    const wid: string = req.workspaceId ?? "main";
    const sessions = baileysManager.getSessionsForWorkspace(wid);
    const activeSessionId = baileysManager.getActiveSessionIdForWorkspace(wid);
    res.json({ sessions, activeSessionId });
  });

  app.post("/api/sessions", async (req: any, res) => {
    try {
      const wid: string = req.workspaceId ?? "main";
      const existing = baileysManager.getSessionsForWorkspace(wid);
      if (existing.length >= 1) {
        return res.status(409).json({
          error: "يُسمح بجلسة واتساب واحدة فقط لكل مساحة عمل. احذف الجلسة الحالية أولاً لإنشاء جديدة.",
          sessions: existing,
        });
      }
      const id = await baileysManager.createSessionForWorkspace("", wid);
      res.json({ success: true, id, sessions: baileysManager.getSessionsForWorkspace(wid) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    try {
      await baileysManager.deleteSession(req.params.id);
      res.json({ success: true, sessions: baileysManager.getSessions() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/sessions/:id/activate", async (req: any, res) => {
    try {
      const wid: string = req.workspaceId ?? "main";
      // Bind session to this workspace AND set as global active session
      baileysManager.activateSessionForWorkspace(req.params.id, wid);
      await baileysManager.activateSession(req.params.id);
      const hasSaved = await baileysManager.hasSavedCredentialsForWorkspace(wid);
      res.json({ success: true, sessions: baileysManager.getSessionsForWorkspace(wid), hasSavedSession: hasSaved });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post("/api/sessions/:id/disconnect", async (req, res) => {
    try {
      await baileysManager.disconnectSession(req.params.id);
      res.json({ success: true, sessions: baileysManager.getSessions() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  /** Reconnect a disconnected / auth_failed session using its saved credentials */
  app.post("/api/sessions/:id/reconnect", async (req, res) => {
    try {
      const id = req.params.id;
      // Make this the active session first, then connect with saved creds
      await baileysManager.activateSession(id);
      await baileysManager.connect(false, undefined, true); // skipClearAuth = true
      res.json({ success: true, sessions: baileysManager.getSessions() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── WhatsApp status ────────────────────────────────────────────────────────
  app.get("/api/whatsapp/status", async (req: any, res) => {
    const wid: string = req.workspaceId ?? "main";
    const hasSaved = await baileysManager.hasSavedCredentialsForWorkspace(wid);
    const ls = getLinkStoreFor(wid);
    const s = ls.checkSession;
    // Only surface session data that belongs to this workspace (already scoped by wid)
    const sessionBelongsHere = true;
    const session = (s && sessionBelongsHere) ? {
      id: s.id,
      total: s.total,
      progress: s.progress,
      status: s.status,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      completedBatches: s.completedBatches,
      validCount: s.results.filter((r) => r.status === "valid").length,
      invalidCount: s.results.filter((r) => r.status === "invalid").length,
      errorCount: s.results.filter((r) => r.status === "error").length,
    } : null;
    // Return workspace-scoped session list and active session
    const wsState = baileysManager.getActiveStateForWorkspace(wid);
    res.json({
      status: wsState?.status ?? "disconnected",
      qrCode: wsState?.qrCode ?? null,
      pairingCode: wsState?.pairingCode ?? null,
      session,
      hasSavedSession: hasSaved,
      sessions: baileysManager.getSessionsForWorkspace(wid),
      activeSessionId: baileysManager.getActiveSessionIdForWorkspace(wid),
    });
  });

  // ── Connect QR mode ────────────────────────────────────────────────────────
  app.post("/api/whatsapp/connect", async (req: any, res) => {
    try {
      const wid: string = req.workspaceId ?? "main";
      // Use workspace-scoped connect — does NOT touch global _activeSessionId,
      // so it cannot interfere with other workspaces' sessions.
      baileysManager.connectForWorkspace(wid, false).catch(console.error);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Connect pairing code mode ──────────────────────────────────────────────
  app.post("/api/whatsapp/pair", async (req: any, res) => {
    const { phone } = req.body as { phone: string };
    if (!phone) return res.status(400).json({ error: "أدخل رقم الهاتف" });
    try {
      const wid: string = req.workspaceId ?? "main";
      // Use workspace-scoped connect — does NOT touch global _activeSessionId.
      baileysManager.connectForWorkspace(wid, true, phone.replace(/\D/g, "")).catch(console.error);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Resend pairing code ────────────────────────────────────────────────────
  app.post("/api/whatsapp/pair/resend", async (req, res) => {
    const { phone } = req.body as { phone: string };
    if (!phone) return res.status(400).json({ error: "أدخل رقم الهاتف" });
    try {
      const code = await baileysManager.resendPairingCode(phone);
      res.json({ success: true, code });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Connect using saved credentials ──────────────────────────────────────
  app.post("/api/whatsapp/use-saved-session", async (_req, res) => {
    try {
      baileysManager.connectWithSavedCredentials().catch(console.error);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  app.post("/api/whatsapp/disconnect", async (_req, res) => {
    try {
      await baileysManager.disconnect();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sync all groups from WhatsApp (full group list, detects manual leaves) ──
  app.post("/api/whatsapp/sync-groups", async (req: any, res) => {
    try {
      const wid: string = req.workspaceId ?? "main";
      const result = await baileysManager.syncGroupsForWorkspace(wid);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Start Baileys link check ───────────────────────────────────────────────
  app.post("/api/whatsapp/check", async (req: any, res) => {
    try {
      const wid: string = req.workspaceId ?? "main";
      // Ensure the workspace's active session is the global active session for checking
      const wActiveId = baileysManager.getActiveSessionIdForWorkspace(wid);
      if (wActiveId) await baileysManager.activateSession(wActiveId);
      await baileysManager.startLinkChecking(wid);
      const _ls1 = getLinkStoreFor(wid);
      if (_ls1.checkSession) _ls1.checkSession.workspaceId = wid;
      res.json({ success: true, sessionId: _ls1.checkSession?.id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Start new round check (extends existing session) ──────────────────────
  app.post("/api/whatsapp/check-new-round", async (req: any, res) => {
    try {
      const wid: string = req.workspaceId ?? "main";
      const wActiveId = baileysManager.getActiveSessionIdForWorkspace(wid);
      if (wActiveId) await baileysManager.activateSession(wActiveId);
      await baileysManager.startNewRoundChecking(wid);
      const _ls2 = getLinkStoreFor(wid);
      if (_ls2.checkSession) _ls2.checkSession.workspaceId = wid;
      res.json({ success: true, sessionId: _ls2.checkSession?.id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Pause / Resume / Stop link check ──────────────────────────────────────
  app.post("/api/whatsapp/check/pause", (_req, res) => {
    baileysManager.pauseCheck();
    res.json({ success: true });
  });

  app.post("/api/whatsapp/check/resume", (_req, res) => {
    baileysManager.resumeCheck();
    res.json({ success: true });
  });

  app.post("/api/whatsapp/check/stop", (_req, res) => {
    baileysManager.stopCheck();
    res.json({ success: true });
  });

  // ── Retry error links (reset to pending + resume checking) ─────────────────
  app.post("/api/whatsapp/check/retry-errors", async (req: any, res) => {
    const wid: string = req.workspaceId ?? "main";
    if (!baileysManager.isConnectedForWorkspace(wid)) return res.status(400).json({ error: "واتساب غير متصل" });
    const count = getLinkStoreFor(wid).retryErrors();
    if (count === 0) return res.status(400).json({ error: "لا توجد أخطاء للإعادة" });
    try {
      await baileysManager.resumeChecking(wid);
      res.json({ success: true, retrying: count });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Start joining groups ─────────────────────────────────────────────────
  app.post("/api/whatsapp/join-groups", async (_req, res) => {
    try {
      await baileysManager.startJoiningGroups();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Join progress ─────────────────────────────────────────────────────────
  app.get("/api/whatsapp/join-progress", (req: any, res) => {
    res.json({ joinSession: getLinkStoreFor(req.workspaceId ?? "main").joinSession });
  });

  // ── Download join results as DOCX ─────────────────────────────────────────
  app.get("/api/whatsapp/download-join-results", async (req: any, res) => {
    const js = getLinkStoreFor(req.workspaceId ?? "main").joinSession;
    if (!js) return res.status(404).json({ error: "لا توجد جلسة انضمام" });

    const children: any[] = [
      new Paragraph({
        text: "نتائج الانضمام للمجموعات",
        heading: HeadingLevel.HEADING_1,
      }),
      new Paragraph({
        text: `إجمالي: ${js.total} · منضمة: ${js.joined} · فشل: ${js.failed}`,
        spacing: { after: 300 },
      }),
    ];

    if (js.joinedLinks.length > 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `✓ المجموعات المنضم إليها (${js.joinedLinks.length})`, bold: true, color: "16a34a" })],
          spacing: { after: 100 },
        })
      );
      for (const link of js.joinedLinks) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: link, color: "1a73e8" })],
            spacing: { after: 80 },
          })
        );
      }
    }

    if (js.failedLinks.length > 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `✗ المجموعات الفاشلة (${js.failedLinks.length})`, bold: true, color: "dc2626" })],
          spacing: { before: 300, after: 100 },
        })
      );
      for (const link of js.failedLinks) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: link, color: "dc2626" })],
            spacing: { after: 80 },
          })
        );
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buf = (await Packer.toBuffer(doc)) as unknown as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="join-results.docx"`);
    res.send(buf);
  });

  // ── Download batch results as DOCX ────────────────────────────────────────
  app.get("/api/whatsapp/download-batch/:batchNum", async (req: any, res) => {
    const batchNum = parseInt(req.params.batchNum, 10);
    const session = getLinkStoreFor(req.workspaceId ?? "main").checkSession;
    if (!session) return res.status(404).json({ error: "لا توجد جلسة فحص" });

    const BATCH_SIZE = 1000;
    const batchStart = (batchNum - 1) * BATCH_SIZE;
    const batchEnd = batchNum * BATCH_SIZE;
    const checked = session.results.filter((r) => r.status !== "pending");
    const batchResults = checked.slice(batchStart, batchEnd);
    if (!batchResults.length) return res.status(404).json({ error: "الدفعة غير موجودة" });

    const validGroups = batchResults.filter((r) => r.status === "valid" && r.link.includes("chat.whatsapp.com"));
    const groups = validGroups.filter((r) => { const m = r.members ?? 0; return m > 150 || (m > 10 && m <= 150 && !r.description?.trim()); });
    const ads = validGroups.filter((r) => { const m = r.members ?? 0; return m > 10 && m <= 150 && !!r.description?.trim() && !hasExcludedDescription(r.description); });

    const children: Paragraph[] = [
      new Paragraph({ children: [new TextRun({ text: `نتائج الدفعة ${batchNum} (${batchResults.length} رابط)`, bold: true, size: 32 })], heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun({ text: `صالح: ${batchResults.filter(r => r.status === "valid").length} | غير صالح: ${batchResults.filter(r => r.status === "invalid").length} | أخطاء: ${batchResults.filter(r => r.status === "error").length}`, size: 24 })] }),
      new Paragraph({ children: [new TextRun({ text: `مجموعات: ${groups.length} | إعلانات: ${ads.length}`, size: 24 })] }),
      new Paragraph({ text: "" }),
    ];

    if (groups.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: `✓ المجموعات (${groups.length})`, bold: true, color: "166534" })], spacing: { before: 200, after: 100 } }));
      for (const r of groups) {
        children.push(new Paragraph({ children: [new TextRun({ text: `${r.link}${r.name ? ` — ${r.name}` : ""}${r.members !== undefined ? ` (${r.members} عضو)` : ""}` })] }));
      }
    }
    if (ads.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: `📢 الإعلانات (${ads.length})`, bold: true, color: "ea580c" })], spacing: { before: 200, after: 100 } }));
      for (const r of ads) {
        children.push(new Paragraph({ children: [new TextRun({ text: `${r.link}${r.name ? ` — ${r.name}` : ""}${r.members !== undefined ? ` (${r.members} عضو)` : ""}` })] }));
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buf = (await Packer.toBuffer(doc)) as unknown as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="batch-${batchNum}.docx"`);
    res.send(buf);
  });

  // ── Explicitly clear WhatsApp credentials (manual user action only) ────────
  app.post("/api/whatsapp/clear-credentials", async (_req, res) => {
    try {
      await baileysManager.disconnect();
      await baileysManager.clearCredentials();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Fresh upload: reset session, extract new file + inject previous desc links ─
  app.post("/api/upload-fresh", upload.array("files", 20), async (req: any, res: any) => {
    try {
      const files: Express.Multer.File[] = req.files ?? (req.file ? [req.file] : []);
      if (!files.length) return res.status(400).json({ error: "لم يتم إرسال ملف" });

      // Capture description links from current session BEFORE reset
      const ls = getLinkStoreFor(req.workspaceId ?? "main");
      const currentSummary = ls.getFilteredSummary();
      const descLinks = currentSummary.descriptionLinks.filter(
        (l) => l.includes("chat.whatsapp.com") || l.includes("wa.me")
      );

      // Merge links from all files
      const waSet = new Set<string>();
      const tgSet = new Set<string>();
      for (const f of files) {
        const [htmlResult, textResult] = await Promise.all([
          mammoth.convertToHtml({ buffer: f.buffer }),
          mammoth.extractRawText({ buffer: f.buffer }),
        ]);
        const extracted = extractLinks(textResult.value, htmlResult.value);
        extracted.whatsapp.forEach((l) => waSet.add(l));
        extracted.telegram.forEach((l) => tgSet.add(l));
      }

      if (!waSet.size && !tgSet.size)
        return res.status(400).json({ error: "لم يتم العثور على روابط واتساب أو تيليغرام في الملفات" });

      // Merge description links (deduplicated)
      const addedDesc: string[] = [];
      for (const l of descLinks) {
        if (!waSet.has(l)) { waSet.add(l); addedDesc.push(l); }
      }
      const finalLinks = { whatsapp: [...waSet], telegram: [...tgSet] };

      // Soft reset: clears previous link results only (WA session is preserved separately)
      ls.softReset();
      ls.setExtracted(finalLinks);
      ls.saveLinksToFile(files.map((f) => f.originalname).join("+"), finalLinks).catch(console.error);

      res.json({
        success: true,
        whatsapp: finalLinks.whatsapp.length,
        telegram: finalLinks.telegram.length,
        descriptionLinksAdded: addedDesc.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "خطأ في معالجة الملف" });
    }
  });

  // ── Start HTTP link check (no login required) ──────────────────────────────
  app.post("/api/check-http", async (req: any, res) => {
    const ls = getLinkStoreFor(req.workspaceId ?? "main");
    const links = ls.extractedLinks.whatsapp;
    if (!links.length)
      return res.status(400).json({ error: "لا توجد روابط واتساب للفحص" });
    const session = ls.startSession(links);
    res.json({ success: true, sessionId: session.id });
    checkLinksHTTP(session.results, (updatedResults, progress) => {
      if (ls.checkSession?.id !== session.id) return;
      ls.checkSession!.results = updatedResults;
      ls.checkSession!.progress = progress;
      ls.updateProgress();
    })
      .then((results) => {
        if (ls.checkSession?.id !== session.id) return;
        ls.checkSession!.results = results;
        ls.checkSession!.progress = results.filter((r) => r.status !== "pending").length;
        ls.checkSession!.status = "done";
        ls.checkSession!.completedAt = new Date().toISOString();
        ls.updateProgress();
      })
      .catch((err) => {
        console.error("[HTTP Check] Error:", err);
        if (ls.checkSession?.id === session.id) {
          ls.checkSession!.status = "idle";
          ls.updateProgress();
        }
      });
  });

  // ── Progress (lightweight — summary + recent results only, no full array) ──
  app.get("/api/whatsapp/progress", (req: any, res) => {
    const session = getLinkStoreFor(req.workspaceId ?? "main").checkSession;
    if (!session) return res.json({ session: null });

    const validCount = session.results.filter((r) => r.status === "valid").length;
    const invalidCount = session.results.filter((r) => r.status === "invalid").length;
    const errorCount = session.results.filter((r) => r.status === "error").length;

    // Return only the last 25 processed results for the live feed (strip description to reduce size)
    const recentResults = session.results
      .filter((r) => r.status !== "pending")
      .slice(-25)
      .map((r) => ({ link: r.link, status: r.status, name: r.name, members: r.members, info: r.info }));

    res.json({
      session: {
        id: session.id,
        total: session.total,
        progress: session.progress,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        completedBatches: session.completedBatches,
        validCount,
        invalidCount,
        errorCount,
        recentResults,
        rateLimitInfo: session.rateLimitInfo ?? null,
      },
    });
  });

  // ── Previous results summary (shown on upload screen) ─────────────────────
  app.get("/api/previous-results", (req: any, res) => {
    const wid: string = req.workspaceId ?? "main";
    const ls = getLinkStoreFor(wid);
    const session = ls.checkSession;
    // Always return extracted link counts so the frontend can restore state
    const extractedWA = ls.extractedLinks.whatsapp.length;
    const extractedTG = ls.extractedLinks.telegram.length;
    const uploadedFileName = ls.uploadedFileName || null;

    if (!session) {
      return res.json({
        hasPreviousSession: false,
        extractedWA,
        extractedTG,
        uploadedFileName,
        sessionStatus: null,
      });
    }

    const sessionStatus = session.status;

    if (session.status !== "done") {
      // Session exists but not yet completed (running, idle, error)
      return res.json({
        hasPreviousSession: false,
        extractedWA,
        extractedTG,
        uploadedFileName,
        sessionStatus,
        sessionProgress: session.progress,
        sessionTotal: session.total,
      });
    }

    const summary = ls.getFilteredSummary();
    const valid = session.results.filter((r) => r.status === "valid").length;
    const invalid = session.results.filter((r) => r.status === "invalid").length;
    const errors = session.results.filter((r) => r.status === "error").length;
    res.json({
      hasPreviousSession: true,
      extractedWA,
      extractedTG,
      uploadedFileName,
      sessionStatus,
      completedAt: session.completedAt,
      startedAt: session.startedAt,
      total: session.total,
      valid,
      invalid,
      errors,
      groups: summary.groups.length,
      ads: summary.ads.length,
      descriptionLinks: summary.descriptionLinks.length,
    });
  });

  // ── Filtered summary (groups + ads + description links) ────────────────────
  app.get("/api/whatsapp/filtered-summary", (req: any, res) => {
    const wid: string = req.workspaceId ?? "main";
    const ls = getLinkStoreFor(wid);
    const summary = ls.getFilteredSummary();
    if (ls.checkSession?.status === "done") {
      // Auto-save description links when summary is requested after completion
      if (summary.descriptionLinks.length > 0) {
        ls.saveDescriptionLinks(summary.descriptionLinks).catch(console.error);
      }
      // Auto-save filtered results to LinksjsonEndRe
      ls.saveFilteredResults(summary).catch(console.error);
      // Auto-save filtered results to MongoDB repository (as Pending for join manager)
      if (process.env.MONGODB_URI && (summary.groups.length + summary.ads.length > 0)) {
        linksRepository.saveFilteredLinks(wid, summary.groups, summary.ads)
          .catch((err) => console.warn("[Routes] Failed to save filtered to DB:", err.message));
        // Also save to global CentralLinks collection — GROUPS ONLY (not ads)
        const centralBatch = [
          ...summary.groups.map(g => ({ url: g.link, name: g.name, members: g.members, description: g.description, workspaceId: wid, category: "group" as const })),
        ];
        centralLinksStore.addBatch(centralBatch)
          .then(r => console.log(`[CentralLinks] +${r.added} new, ${r.duplicates} dup`))
          .catch((err) => console.warn("[Routes] Failed to save to CentralLinks:", err.message));
      }
      // Description links: check+filter them via pipeline BEFORE saving to DB
      const waDescLinks = summary.descriptionLinks.filter((l) => l.includes("chat.whatsapp.com"));
      if (process.env.MONGODB_URI && waDescLinks.length > 0 && baileysManager.isConnectedForWorkspace(wid)) {
        baileysManager.checkLinksForPipeline(waDescLinks).then((results) => {
          const valid = results.filter((r) => r.status === "valid" && r.url.includes("chat.whatsapp.com"));
          function clean(u: string) { try { const p = new URL(u); return `${p.origin}${p.pathname}`; } catch { return u; } }
          const grps = valid
            .filter((r) => { if (isAdOnlyMedicalGroup(r.name, r.description)) return false; const m = r.members ?? 0; return m > 150 || (m > 10 && m <= 150 && !r.description?.trim()); })
            .map((r) => ({ link: clean(r.url), name: r.name, members: r.members, description: r.description }));
          const ads2 = valid
            .filter((r) => { const m = r.members ?? 0; if (m <= 10) return false; if (isAdOnlyMedicalGroup(r.name, r.description)) return true; return m <= 150 && !!r.description?.trim(); })
            .map((r) => ({ link: clean(r.url), name: r.name, members: r.members, description: r.description }));
          if (grps.length + ads2.length > 0)
            return linksRepository.saveFilteredLinks(wid, grps, ads2);
        }).catch((err) => console.warn("[Routes] Description links pipeline failed:", err.message));
      }
    }
    res.json({
      groups: summary.groups.length,
      ads: summary.ads.length,
      descriptionLinks: summary.descriptionLinks.length,
      descriptionLinksData: summary.descriptionLinks,
    });
  });

  // ── Download groups file (>150 members, sorted) ─────────────────────────────
  app.get("/api/whatsapp/download-groups", async (req: any, res) => {
    const { groups } = getLinkStoreFor(req.workspaceId ?? "main").getFilteredSummary();
    if (!groups.length) return res.status(404).json({ error: "لا توجد مجموعات بأكثر من 150 عضواً" });
    const buf = await buildGroupsDocx(groups);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="groups-150plus.docx"`);
    res.send(buf);
  });

  // ── Download ads file (10-150 members with description) ─────────────────────
  app.get("/api/whatsapp/download-ads", async (req: any, res) => {
    const { ads } = getLinkStoreFor(req.workspaceId ?? "main").getFilteredSummary();
    if (!ads.length) return res.status(404).json({ error: "لا توجد مجموعات إعلانية" });
    const buf = await buildAdsDocx(ads);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="ads-groups.docx"`);
    res.send(buf);
  });

  // ── Download description links as DOCX ────────────────────────────────────
  app.get("/api/whatsapp/download-description-links", async (req: any, res) => {
    const { descriptionLinks } = getLinkStoreFor(req.workspaceId ?? "main").getFilteredSummary();
    if (!descriptionLinks.length)
      return res.status(404).json({ error: "لا توجد روابط مستخرجة من الأوصاف" });
    const buf = await buildDocx("روابط من أوصاف المجموعات", descriptionLinks);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="description-links.docx"`);
    res.send(buf);
  });

  // ── Download valid links (legacy - all valid) ──────────────────────────────
  app.get("/api/whatsapp/download-valid", async (req: any, res) => {
    const session = getLinkStoreFor(req.workspaceId ?? "main").checkSession;
    if (!session) return res.status(404).json({ error: "لا توجد جلسة فحص" });
    const validResults = session.results.filter((r) => r.status === "valid");
    if (!validResults.length)
      return res.status(404).json({ error: "لا توجد روابط صالحة" });
    const buf = await buildValidDocx(validResults);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="valid-whatsapp-links.docx"`);
    res.send(buf);
  });

  // ── Workspace API ──────────────────────────────────────────────────────────
  app.post("/api/workspaces/create", async (req, res) => {
    try {
      const { name } = req.body ?? {};
      if (!name?.trim()) return res.status(400).json({ error: "اسم مساحة العمل مطلوب" });
      const ws = await workspaceStore.create(name.trim());
      res.json({ id: ws._id, name: ws.name, accessKey: ws.accessKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/workspaces/login", async (req, res) => {
    try {
      const { accessKey } = req.body ?? {};
      if (!accessKey?.trim()) return res.status(400).json({ error: "مفتاح الوصول مطلوب" });
      const ws = await workspaceStore.findByKey(accessKey.trim());
      if (!ws) return res.status(401).json({ error: "مفتاح الوصول غير صالح" });
      res.json({ id: ws._id, name: ws.name, accessKey: ws.accessKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/workspaces/me", async (req: any, res) => {
    try {
      const wid = req.workspaceId;
      if (!wid) return res.status(401).json({ error: "غير مصرح" });
      const ws = await workspaceStore.findById(wid);
      if (!ws) return res.status(404).json({ error: "المساحة غير موجودة" });
      res.json({ id: ws._id, name: ws.name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Coordinator status ─────────────────────────────────────────────────────
  app.get("/api/coordinator/status", (req: any, res) => {
    const coord = getCoordinatorFor(req.workspaceId ?? "main");
    res.json({
      active: coord.getActive(),
      isRunning: coord.isRunning(),
    });
  });

  // ── Links Repository ───────────────────────────────────────────────────────
  app.get("/api/links-repository/counts", async (req: any, res) => {
    try {
      const counts = await linksRepository.countByStatus(req.workspaceId ?? "main");
      res.json(counts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/links-repository/joined", async (req: any, res) => {
    try {
      const links = await linksRepository.findJoined(req.workspaceId ?? "main");
      res.json(links);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/links-repository/pending", async (req: any, res) => {
    try {
      const links = await linksRepository.findPendingForJoin(req.workspaceId ?? "main");
      res.json(links);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pending admin-approval groups ──────────────────────────────────────────
  app.get("/api/links-repository/pending-approval", async (req: any, res) => {
    try {
      const wid = req.workspaceId ?? "main";
      const links = await linksRepository.findPendingApproval(wid);
      res.json(links);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/links-repository/retry-approval", async (req: any, res) => {
    try {
      const wid = req.workspaceId ?? "main";
      const { url } = req.body as { url: string };
      if (!url) return res.status(400).json({ error: "url مطلوب" });
      const ok = await linksRepository.retryPendingApproval(wid, url);
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/links-repository/retry-approval-all", async (req: any, res) => {
    try {
      const wid = req.workspaceId ?? "main";
      const pending = await linksRepository.findPendingApproval(wid);
      let count = 0;
      for (const p of pending) {
        const ok = await linksRepository.retryPendingApproval(wid, p.url);
        if (ok) count++;
      }
      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Bulk paste: paste multiple WhatsApp links as plain text ────────────────
  app.post("/api/links-repository/bulk-paste", async (req: any, res) => {
    const { urls } = req.body ?? {};
    if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: "urls مطلوبة" });
    const wid = req.workspaceId ?? "main";
    let added = 0, duplicates = 0, invalid = 0;
    // Extract the WhatsApp link from anywhere within each line (handles messy copy-paste)
    const waExtract = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/;
    const waExact   = /^https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+$/;
    const seen = new Set<string>();
    for (const raw of urls) {
      const line = String(raw).trim();
      if (!line) continue;
      // Try to pull the link out of a messy line (e.g. "انضم: https://chat.whatsapp.com/ABC123 - مجموعة")
      const match = line.match(waExtract);
      if (!match) { invalid++; continue; }
      // Strip trailing punctuation/whitespace that regex may have captured
      const url = match[0].replace(/[.,;)>\]'"»«\s]+$/, "").trim();
      if (!waExact.test(url)) { invalid++; continue; }
      if (seen.has(url)) { duplicates++; continue; }
      seen.add(url);
      const wasNew = await linksRepository.addIfNew(wid, url, "Group", "manual");
      if (wasNew) added++;
      else duplicates++;
    }
    console.log(`[BulkPaste:${wid}] total: ${urls.length}, added: ${added}, dup: ${duplicates}, invalid: ${invalid}`);
    res.json({ success: true, added, duplicates, invalid, total: urls.length });
  });

  // ── Manual upload: DOCX → insert links into MongoDB directly ───────────────
  app.post("/api/links-repository/manual-upload", upload.single("file"), async (req: any, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });

      const wid = req.workspaceId ?? "main";
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      const htmlResult = await mammoth.convertToHtml({ buffer: req.file.buffer });
      const combined = result.value + " " + htmlResult.value;

      const waRegex = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/g;
      const rawLinks = [...combined.matchAll(waRegex)].map((m) =>
        m[0].replace(/[.,;)>\]'"»«]+$/, "").trim()
      );
      const uniqueLinks = [...new Set(rawLinks.filter(Boolean))];

      let added = 0;
      let duplicates = 0;
      for (const url of uniqueLinks) {
        const wasNew = await linksRepository.addIfNew(wid, url, "Group", "manual");
        if (wasNew) added++;
        else duplicates++;
      }

      console.log(`[ManualUpload:${wid}] Processed ${uniqueLinks.length} links — added: ${added}, duplicates: ${duplicates}`);
      res.json({ total: uniqueLinks.length, added, duplicates });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Join Manager ───────────────────────────────────────────────────────────
  app.post("/api/join/start", async (req: any, res) => {
    try {
      const wid = req.workspaceId ?? "main";
      const jm = getJoinManagerFor(wid);
      const maxLinks: number | undefined = req.body?.maxLinks ? Number(req.body.maxLinks) : undefined;

      let startError: string | null = null;
      const p = jm.start(maxLinks).catch((err: Error) => {
        startError = err.message;
        console.error("[JoinManager] Start failed:", err.message);
      });

      // Wait up to 700ms — enough for coordinator check + pending-links check to fail fast
      await Promise.race([p, new Promise(r => setTimeout(r, 700))]);

      if (startError) return res.status(400).json({ error: startError });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/join/config", async (req: any, res) => {
    try {
      res.json(await getJoinConfig());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/join/config", async (req: any, res) => {
    const { slotsPerWindow } = req.body ?? {};
    const n = Number(slotsPerWindow);
    if (!n || n < 2 || n > 8) return res.status(400).json({ error: "slotsPerWindow يجب أن يكون بين 2 و 8" });
    try {
      res.json(await setJoinConfig({ slotsPerWindow: n }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/join/stop", (req: any, res) => {
    getJoinManagerFor(req.workspaceId ?? "main").requestStop();
    res.json({ success: true });
  });

  app.post("/api/join/pause", (req: any, res) => {
    getJoinManagerFor(req.workspaceId ?? "main").requestPause();
    res.json({ success: true });
  });

  app.post("/api/join/resume", (req: any, res) => {
    getJoinManagerFor(req.workspaceId ?? "main").requestResume();
    res.json({ success: true });
  });

  app.get("/api/join/progress", (req: any, res) => {
    res.json({ progress: getJoinManagerFor(req.workspaceId ?? "main").getProgress() });
  });

  app.get("/api/telemetry", (req: any, res) => {
    const wid = req.workspaceId ?? "main";
    const tel = getTelemetryFor(wid);
    const jm  = getJoinManagerFor(wid);
    res.json({
      report:        tel.getReport(),
      windowHistory: tel.getWindowHistory(),
      joinProgress:  jm.getProgress(),
    });
  });

  /**
   * Reset only the CURRENT phone's own join progress back to Pending.
   * Allows re-joining groups with the same account. Does NOT affect other phones.
   */
  // ── Per-phone join statistics ────────────────────────────────────────────
  app.get("/api/join/phone-stats", async (req: any, res) => {
    try {
      const wid: string = req.workspaceId ?? "main";
      const sessions = baileysManager.getSessionsForWorkspace(wid);
      const results: Array<{
        phone: string; displayName: string; isActive: boolean;
        Pending: number; PendingReal: number; PendingForMe: number;
        Joined: number; Ignored: number; Left: number;
      }> = [];
      for (const s of sessions) {
        const phone = s.phoneNumber;
        if (!phone) continue;
        const counts = await linksRepository.countByStatusForPhone(wid, phone);
        results.push({
          phone,
          displayName: s.displayName,
          isActive: s.isActive,
          Pending: counts.Pending,
          PendingReal: counts.PendingReal,
          PendingForMe: counts.PendingForMe,
          Joined: counts.Joined,
          Ignored: counts.Ignored,
          Left: counts.Left,
        });
      }
      res.json({ phones: results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/join/reset-for-new-account", async (req: any, res) => {
    try {
      const wid = req.workspaceId ?? "main";
      const phone = baileysManager.getConnectedPhoneForWorkspace(wid) ?? baileysManager.getConnectedPhone();
      if (!phone) return res.status(400).json({ error: "لا يوجد حساب واتساب متصل حالياً." });
      const count = await linksRepository.resetMyJoinProgress(wid, phone);
      res.json({ success: true, resetCount: count, phone });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Leave Manager ──────────────────────────────────────────────────────────
  app.get("/api/leave/queue", async (req: any, res) => {
    try {
      const queue = await getLeaveManagerFor(req.workspaceId ?? "main").listQueue();
      res.json({ queue, count: queue.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leave/enqueue", async (req: any, res) => {
    const { url, reason, scheduledAt } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url مطلوب" });
    try {
      const lm = getLeaveManagerFor(req.workspaceId ?? "main");
      const added = await lm.enqueue(url, reason, scheduledAt ? new Date(scheduledAt) : undefined);
      res.json({ success: true, added });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/leave/schedule", async (req: any, res) => {
    const { url, scheduledAt } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url مطلوب" });
    try {
      await getLeaveManagerFor(req.workspaceId ?? "main").updateSchedule(url, scheduledAt ? new Date(scheduledAt) : null);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leave/leave-now", async (req: any, res) => {
    const { url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url مطلوب" });
    try {
      await getLeaveManagerFor(req.workspaceId ?? "main").leaveNow(url);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/leave/dequeue", async (req: any, res) => {
    const { url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url مطلوب" });
    try {
      await getLeaveManagerFor(req.workspaceId ?? "main").dequeue(url);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leave/start", async (req: any, res) => {
    try {
      getLeaveManagerFor(req.workspaceId ?? "main").processQueue().catch(console.error);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/leave/stop", (req: any, res) => {
    getLeaveManagerFor(req.workspaceId ?? "main").requestStop();
    res.json({ success: true });
  });

  app.get("/api/leave/progress", (req: any, res) => {
    res.json({ progress: getLeaveManagerFor(req.workspaceId ?? "main").getProgress() });
  });

  // ── Publisher ──────────────────────────────────────────────────────────────
  app.get("/api/publisher/ads", async (req: any, res) => {
    try {
      const ads = await getPublisherFor(req.workspaceId ?? "main").listAds();
      res.json(ads);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/publisher/ads", mediaUpload.single("media"), async (req: any, res) => {
    const text = (req.body?.text ?? "").trim();
    if (!text && !req.file) return res.status(400).json({ error: "نص الإعلان أو وسائط مطلوبة" });
    try {
      let media: { data: string; type: "image" | "video" | "document"; caption?: string; filename?: string } | undefined;
      if (req.file) {
        const mime = req.file.mimetype ?? "";
        const mediaType: "image" | "video" | "document" = mime.startsWith("image/")
          ? "image"
          : mime.startsWith("video/")
          ? "video"
          : "document";
        media = {
          data:     req.file.buffer.toString("base64"),
          type:     mediaType,
          caption:  (req.body?.caption ?? text) || undefined,
          filename: req.file.originalname,
        };
      }
      const id = await getPublisherFor(req.workspaceId ?? "main").addAd(text, media);
      res.json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/publisher/ads/:id", async (req: any, res) => {
    try {
      await getPublisherFor(req.workspaceId ?? "main").removeAd(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dashboard stats ────────────────────────────────────────────────────────
  app.get("/api/dashboard/stats", async (req: any, res) => {
    try {
      const wid = req.workspaceId ?? "main";
      const [byStatus, bySource, trend, recent] = await Promise.all([
        linksRepository.countByStatus(wid),
        linksRepository.countBySource(wid),
        linksRepository.getDailyTrend(wid, 14),
        linksRepository.getRecent(wid, 15),
      ]);
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayEntry = trend.find((d) => d.date === todayStr);
      const todayCount = todayEntry?.count ?? 0;
      const readerStats = getMessageReaderFor(wid).getStats();
      const joinProgress = getJoinManagerFor(wid).getProgress();
      res.json({ byStatus, bySource, trend, recent, total, todayCount, readerStats, joinProgress });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/publisher/start", async (req: any, res) => {
    try {
      getPublisherFor(req.workspaceId ?? "main").start().catch(console.error);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/publisher/stop", (req: any, res) => {
    getPublisherFor(req.workspaceId ?? "main").requestStop();
    res.json({ success: true });
  });

  app.get("/api/publisher/progress", (req: any, res) => {
    res.json({ progress: getPublisherFor(req.workspaceId ?? "main").getProgress() });
  });

  app.get("/api/publisher/history", async (_req, res) => {
    try {
      const { publishHistory } = await import("./modules/publish-history.js");
      const sessions = await publishHistory.list(30);
      res.json({ sessions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Publish Schedules ───────────────────────────────────────────────────────
  app.get("/api/publisher/schedules", async (req: any, res) => {
    try {
      const { publishScheduler } = await import("./modules/publish-scheduler.js");
      const schedules = await publishScheduler.list(req.workspaceId ?? "main");
      res.json({ schedules });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/publisher/schedules", async (req: any, res) => {
    const { name, intervalValue, intervalUnit } = req.body ?? {};
    if (!intervalValue || !intervalUnit) return res.status(400).json({ error: "intervalValue و intervalUnit مطلوبان" });
    const iv = Number(intervalValue);
    if (!Number.isFinite(iv) || iv <= 0) return res.status(400).json({ error: "قيمة التكرار يجب أن تكون رقماً موجباً" });
    try {
      const { publishScheduler } = await import("./modules/publish-scheduler.js");
      const schedule = await publishScheduler.create(req.workspaceId ?? "main", name ?? "", iv, intervalUnit);
      res.json({ success: true, schedule });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.put("/api/publisher/schedules/:id", async (req: any, res) => {
    const { name, intervalValue, intervalUnit } = req.body ?? {};
    try {
      const { publishScheduler } = await import("./modules/publish-scheduler.js");
      await publishScheduler.update(req.params.id, req.workspaceId ?? "main", {
        ...(name !== undefined && { name }),
        ...(intervalValue !== undefined && { intervalValue: Number(intervalValue) }),
        ...(intervalUnit !== undefined && { intervalUnit }),
      });
      res.json({ success: true });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.patch("/api/publisher/schedules/:id/toggle", async (req: any, res) => {
    try {
      const { publishScheduler } = await import("./modules/publish-scheduler.js");
      const enabled = await publishScheduler.toggle(req.params.id, req.workspaceId ?? "main");
      res.json({ success: true, enabled });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.delete("/api/publisher/schedules/:id", async (req: any, res) => {
    try {
      const { publishScheduler } = await import("./modules/publish-scheduler.js");
      await publishScheduler.delete(req.params.id, req.workspaceId ?? "main");
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Message Reader ─────────────────────────────────────────────────────────
  app.post("/api/reader/start", async (req: any, res) => {
    try {
      await getMessageReaderFor(req.workspaceId ?? "main").start();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/reader/stop", async (req: any, res) => {
    try {
      await getMessageReaderFor(req.workspaceId ?? "main").stop();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/reader/pause", (req: any, res) => {
    getMessageReaderFor(req.workspaceId ?? "main").pause();
    res.json({ success: true });
  });

  app.post("/api/reader/resume", (req: any, res) => {
    getMessageReaderFor(req.workspaceId ?? "main").resume();
    res.json({ success: true });
  });

  app.get("/api/reader/stats", (req: any, res) => {
    const mr = getMessageReaderFor((req as any).workspaceId ?? "main");
    res.json({ stats: mr.getStats(), isRunning: mr.isRunning(), isPaused: mr.isPaused() });
  });

  // ── Leave manager pause/resume ──────────────────────────────────────────────
  app.post("/api/leave/pause", (req: any, res) => {
    getLeaveManagerFor(req.workspaceId ?? "main").requestPause();
    res.json({ success: true });
  });

  app.post("/api/leave/resume", (req: any, res) => {
    getLeaveManagerFor(req.workspaceId ?? "main").requestResume();
    res.json({ success: true });
  });

  // ── Publisher pause/resume ──────────────────────────────────────────────────
  app.post("/api/publisher/pause", (req: any, res) => {
    getPublisherFor(req.workspaceId ?? "main").requestPause();
    res.json({ success: true });
  });

  app.post("/api/publisher/resume", (req: any, res) => {
    getPublisherFor(req.workspaceId ?? "main").requestResume();
    res.json({ success: true });
  });

  // ── Sleep config ────────────────────────────────────────────────────────────
  app.get("/api/settings/sleep", async (_req, res) => {
    try {
      const { getSleepConfig, SLEEP_DURATION_HOURS } = await import("./modules/sleep-config.js");
      const cfg = await getSleepConfig();
      const { getSleepStatus } = await import("./modules/sleep-scheduler.js");
      res.json({ ...cfg, durationHours: SLEEP_DURATION_HOURS, status: getSleepStatus() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/settings/sleep", async (req: any, res) => {
    const { startHour, startMin } = req.body ?? {};
    if (typeof startHour !== "number" || typeof startMin !== "number") {
      return res.status(400).json({ error: "startHour و startMin مطلوبان (أرقام)" });
    }
    if (startHour < 0 || startHour > 23 || startMin < 0 || startMin > 59) {
      return res.status(400).json({ error: "وقت غير صالح" });
    }
    try {
      const { setSleepConfig, SLEEP_DURATION_HOURS } = await import("./modules/sleep-config.js");
      const cfg = await setSleepConfig({ startHour, startMin, durationHours: SLEEP_DURATION_HOURS });
      res.json({ success: true, ...cfg });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Excluded Groups ─────────────────────────────────────────────────────────
  app.get("/api/excluded-groups", async (req: any, res) => {
    try {
      const { excludedGroups } = await import("./modules/excluded-groups.js");
      const list = await excludedGroups.list(req.workspaceId ?? "main");
      res.json({ groups: list });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/excluded-groups", async (req: any, res) => {
    const { url, name } = req.body ?? {};
    if (!url?.trim()) return res.status(400).json({ error: "الرابط مطلوب" });
    try {
      const { excludedGroups } = await import("./modules/excluded-groups.js");
      const added = await excludedGroups.add(req.workspaceId ?? "main", url.trim(), name?.trim());
      if (!added) return res.status(400).json({ error: "الرابط موجود بالفعل" });
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete("/api/excluded-groups", async (req: any, res) => {
    const { url } = req.body ?? {};
    if (!url?.trim()) return res.status(400).json({ error: "الرابط مطلوب" });
    try {
      const { excludedGroups } = await import("./modules/excluded-groups.js");
      await excludedGroups.remove(req.workspaceId ?? "main", url.trim());
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── ADMIN ROUTES (protected by X-Admin-Key, NOT by workspace key) ─────────
  // ══════════════════════════════════════════════════════════════════════════

  // Public: login with admin key
  app.post("/api/admin/login", async (req, res) => {
    const { adminKey } = req.body as { adminKey?: string };
    if (!adminKey?.trim()) return res.status(400).json({ error: "أدخل مفتاح المشرف" });
    try {
      const admin = await adminStore.findByKey(adminKey.trim());
      if (!admin) return res.status(401).json({ error: "مفتاح المشرف غير صالح" });
      res.json({ adminKey: admin.adminKey, name: admin.name, phoneNumber: admin.phoneNumber });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Verify session
  app.get("/api/admin/me", adminAuth as any, (req: any, res) => {
    const { adminKey: _k, ...safe } = req.admin;
    res.json({ admin: { ...safe, adminKey: req.admin.adminKey } });
  });

  // List all admins
  app.get("/api/admin/list", adminAuth as any, async (_req, res) => {
    try {
      const admins = await adminStore.list();
      res.json({ admins: admins.map(a => ({ _id: a._id, phoneNumber: a.phoneNumber, name: a.name, createdAt: a.createdAt, createdBy: a.createdBy })) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Create new admin
  app.post("/api/admin/add", adminAuth as any, async (req: any, res) => {
    const { phoneNumber, name } = req.body as { phoneNumber?: string; name?: string };
    if (!phoneNumber?.trim()) return res.status(400).json({ error: "أدخل رقم الهاتف" });
    try {
      const admin = await adminStore.create(phoneNumber.trim(), name, req.admin._id);
      res.json({ admin });
    } catch (err: any) {
      if (err.message?.includes("duplicate") || err.code === 11000) {
        return res.status(400).json({ error: "هذا الرقم مسجل مشرفاً بالفعل" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Delete admin
  app.delete("/api/admin/:id", adminAuth as any, async (req: any, res) => {
    if (req.params.id === req.admin._id) return res.status(400).json({ error: "لا يمكنك حذف نفسك" });
    try {
      await adminStore.delete(req.params.id);
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Central Links — list (paginated + filterable)
  app.get("/api/admin/central-links", adminAuth as any, async (req, res) => {
    try {
      const skip = parseInt(req.query.skip as string) || 0;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const search = (req.query.search as string) || "";
      const category = (req.query.category as string) || "";
      const minMembers = parseInt(req.query.minMembers as string) || 0;
      const result = await centralLinksStore.list({ skip, limit, search, category: category as any, minMembers: minMembers || undefined });
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Central Links — stats
  app.get("/api/admin/central-links/stats", adminAuth as any, async (_req, res) => {
    try {
      const stats = await centralLinksStore.count();
      res.json(stats);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Central Links — download DOCX (also accepts ?adminKey= for direct browser open)
  app.get("/api/admin/central-links/download", async (req, res) => {
    const key = (req.headers["x-admin-key"] as string) || (req.query.adminKey as string) || "";
    if (!key) return res.status(401).json({ error: "مطلوب مفتاح المشرف" });
    const admin = await adminStore.findByKey(key);
    if (!admin) return res.status(401).json({ error: "مفتاح المشرف غير صالح" });
    try {
      const search = (req.query.search as string) || "";
      const category = (req.query.category as string) || "";
      const minMembers = parseInt(req.query.minMembers as string) || 0;
      const { docs } = await centralLinksStore.list({ skip: 0, limit: 10000, search, category: category as any, minMembers: minMembers || undefined });
      const children: any[] = [
        new Paragraph({ text: "الروابط المركزية — Link Checker Pro", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: `الإجمالي: ${docs.length} رابط`, spacing: { after: 300 } }),
        ...docs.map((d: any, i: number) =>
          new Paragraph({
            children: [
              new TextRun({ text: `${i + 1}. `, bold: true }),
              new TextRun({ text: d.url }),
              ...(d.name ? [new TextRun({ text: `  — ${d.name}`, color: "555555" })] : []),
              ...(d.members ? [new TextRun({ text: `  (${d.members} عضو)`, color: "888888" })] : []),
            ],
          })
        ),
      ];
      const doc = new Document({ sections: [{ children }] });
      const buf = await Packer.toBuffer(doc);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="central-links.docx"`);
      res.send(buf);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Workspaces + Sessions overview for admin
  app.get("/api/admin/workspaces", adminAuth as any, async (_req, res) => {
    try {
      const workspaces = await workspaceStore.list();
      const allSessions = baileysManager.getSessions().map(s => {
        const meta = (baileysManager as any)._appMeta?.sessions?.find((m: any) => m.id === s.id);
        return { ...s, workspaceId: meta?.workspaceId ?? null };
      });
      res.json({ workspaces, sessions: allSessions });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return httpServer;
}
