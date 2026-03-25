import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import mammoth from "mammoth";
import { Document, Paragraph, TextRun, HeadingLevel, Packer } from "docx";
import { linkStore } from "./link-store.js";
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
    // Add blank separator paragraph between every group of 40
    if (idx > 0 && idx % BATCH === 0) {
      children.push(new Paragraph({ text: "", spacing: { after: 400 } }));
    }
    // Group name (max 3 words already enforced upstream)
    if (r.name) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: r.name, bold: true })],
          spacing: { after: 60 },
        })
      );
    }
    // Link
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
      // Save links to a JSON file named after the uploaded file
      linkStore.saveLinksToFile(req.file.originalname, extracted).catch(console.error);
      res.json({ success: true, whatsapp: extracted.whatsapp.length, telegram: extracted.telegram.length });
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
  app.get("/api/whatsapp/status", (_req, res) => {
    res.json({
      status: baileysManager.getStatus(),
      qrCode: baileysManager.getQrCode(),
      pairingCode: baileysManager.getPairingCode(),
      session: linkStore.checkSession,
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

  // ── Start HTTP link check (no login required) ──────────────────────────────
  app.post("/api/check-http", async (_req, res) => {
    const links = linkStore.extractedLinks.whatsapp;
    if (!links.length)
      return res.status(400).json({ error: "لا توجد روابط واتساب للفحص" });

    // startSession will resume an existing paused session if links match
    const session = linkStore.startSession(links);
    res.json({ success: true, sessionId: session.id });

    // Run checks in background — checkLinksHTTP skips already-done items
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

  // ── Download valid links ───────────────────────────────────────────────────
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
