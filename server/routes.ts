import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import mammoth from "mammoth";
import { Document, Paragraph, TextRun, HeadingLevel, Packer, AlignmentType } from "docx";
import { linkStore, type FilteredGroup } from "./link-store.js";
import { baileysManager } from "./baileys-manager.js";
import { checkLinksHTTP } from "./http-checker.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.docx?$/i)) cb(null, true);
    else cb(new Error("يجب رفع ملف DOCX فقط"));
  },
});

function extractLinks(text: string, html: string) {
  const combined = text + " " + html;
  const waRegex =
    /https?:\/\/(?:chat\.whatsapp\.com\/[A-Za-z0-9_-]+|wa\.me\/[\d+]+|api\.whatsapp\.com\/send\?[^\s"'<>]*)/g;
  const tgRegex =
    /https?:\/\/(?:t\.me\/[A-Za-z0-9_+/-]+|telegram\.me\/[A-Za-z0-9_]+|telegram\.org\/[^\s"'<>]*)/g;
  const waRaw = [...combined.matchAll(waRegex)].map((m) =>
    m[0].replace(/[.,;)>\]'"]+$/, "")
  );
  const tgRaw = [...combined.matchAll(tgRegex)].map((m) =>
    m[0].replace(/[.,;)>\]'"]+$/, "")
  );
  const dedup = (arr: string[]) =>
    [...new Set(arr.map((l) => l.trim()).filter(Boolean))];
  return { whatsapp: dedup(waRaw), telegram: dedup(tgRaw) };
}

// ── Build DOCX for valid filtered groups ─────────────────────────────────────
async function buildGroupsDocx(groups: FilteredGroup[]): Promise<Buffer> {
  const children: any[] = [
    new Paragraph({
      text: "ملف المجموعات النشطة (أكثر من 50 عضواً)",
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      text: `إجمالي المجموعات: ${groups.length}`,
      spacing: { after: 300 },
    }),
  ];

  let lastDirKey = "";
  for (const g of groups) {
    // Compute "directory" = first significant word of name
    const dirKey = (g.name ?? "").trim().split(/\s+/)[0] ?? "";
    if (dirKey && dirKey !== lastDirKey) {
      // Add a section separator when the directory group changes
      if (lastDirKey) {
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }
      lastDirKey = dirKey;
    }

    if (g.name) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: g.name, bold: true }),
            new TextRun({ text: `  —  ${g.members} عضو`, color: "666666", size: 20 }),
          ],
          spacing: { after: 40 },
        })
      );
    }
    children.push(
      new Paragraph({
        children: [new TextRun({ text: g.link, color: "1a73e8" })],
        spacing: { after: 140 },
      })
    );
  }

  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

// ── Build DOCX for ads groups ─────────────────────────────────────────────────
async function buildAdsDocx(ads: FilteredGroup[]): Promise<Buffer> {
  const children: any[] = [
    new Paragraph({
      text: "ملف الإعلانات (10–50 عضواً مع وصف)",
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      text: `إجمالي المجموعات: ${ads.length}`,
      spacing: { after: 300 },
    }),
  ];

  for (const g of ads) {
    if (g.name) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: g.name, bold: true }),
            new TextRun({ text: `  —  ${g.members} عضو`, color: "666666", size: 20 }),
          ],
          spacing: { after: 40 },
        })
      );
    }
    if (g.description) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: g.description, color: "444444", italics: true, size: 20 })],
          spacing: { after: 40 },
        })
      );
    }
    children.push(
      new Paragraph({
        children: [new TextRun({ text: g.link, color: "1a73e8" })],
        spacing: { after: 160 },
      })
    );
  }

  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

async function buildValidDocx(results: { link: string; name?: string }[]): Promise<Buffer> {
  const BATCH = 40;
  const children: any[] = [
    new Paragraph({ text: "روابط واتساب الصالحة", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      text: `إجمالي الروابط: ${results.length}`,
      spacing: { after: 300 },
    }),
  ];

  results.forEach((r, idx) => {
    if (idx > 0 && idx % BATCH === 0) {
      children.push(new Paragraph({ text: "", spacing: { after: 400 } }));
    }
    if (r.name) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: r.name, bold: true })],
          spacing: { after: 60 },
        })
      );
    }
    children.push(
      new Paragraph({
        children: [new TextRun({ text: r.link, color: "1a73e8" })],
        spacing: { after: 160 },
      })
    );
  });

  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

async function buildDocx(title: string, links: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            text: `إجمالي الروابط: ${links.length}`,
            spacing: { after: 300 },
          }),
          ...links.map(
            (link) =>
              new Paragraph({
                children: [new TextRun({ text: link, color: "1a73e8" })],
                spacing: { after: 100 },
              })
          ),
        ],
      },
    ],
  });
  return (await Packer.toBuffer(doc)) as unknown as Buffer;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

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
      linkStore.setExtracted(extracted);
      linkStore.saveLinksToFile(req.file.originalname, extracted).catch(console.error);
      res.json({ success: true, whatsapp: extracted.whatsapp.length, telegram: extracted.telegram.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "خطأ في معالجة الملف" });
    }
  });

  // ── Upload new round DOCX (dedup against existing session) ─────────────────
  app.post("/api/upload-new-round", upload.single("file"), async (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ error: "لم يتم إرسال ملف" });
      const [htmlResult, textResult] = await Promise.all([
        mammoth.convertToHtml({ buffer: req.file.buffer }),
        mammoth.extractRawText({ buffer: req.file.buffer }),
      ]);
      const extracted = extractLinks(textResult.value, htmlResult.value);
      if (!extracted.whatsapp.length && !extracted.telegram.length)
        return res.status(400).json({ error: "لم يتم العثور على روابط واتساب أو تيليغرام في الملف" });

      const { uniqueWhatsapp, uniqueTelegram, skipped } = linkStore.prepareNewRound(
        extracted.whatsapp,
        extracted.telegram,
        req.file.originalname
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
  app.get("/api/download/whatsapp", async (_req, res) => {
    const links = linkStore.extractedLinks.whatsapp;
    if (!links.length) return res.status(404).json({ error: "لا توجد روابط واتساب" });
    const buf = await buildDocx("روابط واتساب", links);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="whatsapp-links.docx"`);
    res.send(buf);
  });

  app.get("/api/download/telegram", async (_req, res) => {
    const links = linkStore.extractedLinks.telegram;
    if (!links.length) return res.status(404).json({ error: "لا توجد روابط تيليغرام" });
    const buf = await buildDocx("روابط تيليغرام", links);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="telegram-links.docx"`);
    res.send(buf);
  });

  // ── WhatsApp status ────────────────────────────────────────────────────────
  app.get("/api/whatsapp/status", async (_req, res) => {
    const hasSaved = await baileysManager.hasSavedCredentials();
    res.json({
      status: baileysManager.getStatus(),
      qrCode: baileysManager.getQrCode(),
      pairingCode: baileysManager.getPairingCode(),
      session: linkStore.checkSession,
      hasSavedSession: hasSaved,
    });
  });

  // ── Connect QR mode ────────────────────────────────────────────────────────
  app.post("/api/whatsapp/connect", async (_req, res) => {
    try {
      baileysManager.connect(false).catch(console.error);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Connect pairing code mode ──────────────────────────────────────────────
  app.post("/api/whatsapp/pair", async (req, res) => {
    const { phone } = req.body as { phone: string };
    if (!phone) return res.status(400).json({ error: "أدخل رقم الهاتف" });
    try {
      baileysManager.connect(true, phone.replace(/\D/g, "")).catch(console.error);
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

  // ── Start Baileys link check ───────────────────────────────────────────────
  app.post("/api/whatsapp/check", async (_req, res) => {
    try {
      await baileysManager.startLinkChecking();
      res.json({ success: true, sessionId: linkStore.checkSession?.id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Start new round check (extends existing session) ──────────────────────
  app.post("/api/whatsapp/check-new-round", async (_req, res) => {
    try {
      await baileysManager.startNewRoundChecking();
      res.json({ success: true, sessionId: linkStore.checkSession?.id });
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
  app.get("/api/whatsapp/join-progress", (_req, res) => {
    res.json({ joinSession: linkStore.joinSession });
  });

  // ── Download join results as DOCX ─────────────────────────────────────────
  app.get("/api/whatsapp/download-join-results", async (_req, res) => {
    const js = linkStore.joinSession;
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
  app.get("/api/whatsapp/download-batch/:batchNum", async (req, res) => {
    const batchNum = parseInt(req.params.batchNum, 10);
    const session = linkStore.checkSession;
    if (!session) return res.status(404).json({ error: "لا توجد جلسة فحص" });

    const BATCH_SIZE = 1000;
    const batchStart = (batchNum - 1) * BATCH_SIZE;
    const batchEnd = batchNum * BATCH_SIZE;
    const checked = session.results.filter((r) => r.status !== "pending");
    const batchResults = checked.slice(batchStart, batchEnd);
    if (!batchResults.length) return res.status(404).json({ error: "الدفعة غير موجودة" });

    const validGroups = batchResults.filter((r) => r.status === "valid" && r.link.includes("chat.whatsapp.com"));
    const groups = validGroups.filter((r) => { const m = r.members ?? 0; return m > 50 || (m > 10 && m <= 50 && !r.description?.trim()); });
    const ads = validGroups.filter((r) => { const m = r.members ?? 0; return m > 10 && m <= 50 && !!r.description?.trim(); });

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

  // ── Start HTTP link check (no login required) ──────────────────────────────
  app.post("/api/check-http", async (_req, res) => {
    const links = linkStore.extractedLinks.whatsapp;
    if (!links.length)
      return res.status(400).json({ error: "لا توجد روابط واتساب للفحص" });
    const session = linkStore.startSession(links);
    res.json({ success: true, sessionId: session.id });
    checkLinksHTTP(session.results, (updatedResults, progress) => {
      if (linkStore.checkSession?.id !== session.id) return;
      linkStore.checkSession!.results = updatedResults;
      linkStore.checkSession!.progress = progress;
      linkStore.updateProgress();
    })
      .then((results) => {
        if (linkStore.checkSession?.id !== session.id) return;
        linkStore.checkSession!.results = results;
        linkStore.checkSession!.progress = results.filter((r) => r.status !== "pending").length;
        linkStore.checkSession!.status = "done";
        linkStore.checkSession!.completedAt = new Date().toISOString();
        linkStore.updateProgress();
      })
      .catch((err) => {
        console.error("[HTTP Check] Error:", err);
        if (linkStore.checkSession?.id === session.id) {
          linkStore.checkSession!.status = "idle";
          linkStore.updateProgress();
        }
      });
  });

  // ── Progress ───────────────────────────────────────────────────────────────
  app.get("/api/whatsapp/progress", (_req, res) => {
    res.json({ session: linkStore.checkSession });
  });

  // ── Previous results summary (shown on upload screen) ─────────────────────
  app.get("/api/previous-results", (_req, res) => {
    const session = linkStore.checkSession;
    // Always return extracted link counts so the frontend can restore state
    const extractedWA = linkStore.extractedLinks.whatsapp.length;
    const extractedTG = linkStore.extractedLinks.telegram.length;
    const uploadedFileName = linkStore.uploadedFileName || null;

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

    const summary = linkStore.getFilteredSummary();
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
  app.get("/api/whatsapp/filtered-summary", (_req, res) => {
    const summary = linkStore.getFilteredSummary();
    if (linkStore.checkSession?.status === "done") {
      // Auto-save description links when summary is requested after completion
      if (summary.descriptionLinks.length > 0) {
        linkStore.saveDescriptionLinks(summary.descriptionLinks).catch(console.error);
      }
      // Auto-save filtered results to LinksjsonEndRe
      linkStore.saveFilteredResults(summary).catch(console.error);
    }
    res.json({
      groups: summary.groups.length,
      ads: summary.ads.length,
      descriptionLinks: summary.descriptionLinks.length,
      descriptionLinksData: summary.descriptionLinks,
    });
  });

  // ── Download groups file (>50 members, sorted) ─────────────────────────────
  app.get("/api/whatsapp/download-groups", async (_req, res) => {
    const { groups } = linkStore.getFilteredSummary();
    if (!groups.length) return res.status(404).json({ error: "لا توجد مجموعات بأكثر من 50 عضواً" });
    const buf = await buildGroupsDocx(groups);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="groups-50plus.docx"`);
    res.send(buf);
  });

  // ── Download ads file (10-50 members with description) ─────────────────────
  app.get("/api/whatsapp/download-ads", async (_req, res) => {
    const { ads } = linkStore.getFilteredSummary();
    if (!ads.length) return res.status(404).json({ error: "لا توجد مجموعات إعلانية" });
    const buf = await buildAdsDocx(ads);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="ads-groups.docx"`);
    res.send(buf);
  });

  // ── Download valid links (legacy - all valid) ──────────────────────────────
  app.get("/api/whatsapp/download-valid", async (_req, res) => {
    const session = linkStore.checkSession;
    if (!session) return res.status(404).json({ error: "لا توجد جلسة فحص" });
    const validResults = session.results.filter((r) => r.status === "valid");
    if (!validResults.length)
      return res.status(404).json({ error: "لا توجد روابط صالحة" });
    const buf = await buildValidDocx(validResults);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="valid-whatsapp-links.docx"`);
    res.send(buf);
  });

  return httpServer;
}
