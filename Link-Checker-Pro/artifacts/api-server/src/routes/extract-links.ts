import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import mammoth from "mammoth";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  BorderStyle, ShadingType, UnderlineType,
} from "docx";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Types ─────────────────────────────────────────────────────────────────────

interface LinkEntry {
  url: string;
  name: string;
}

interface LinkCategory {
  family: LinkEntry[];
  mofeed: LinkEntry[];
}

interface ProcessResult {
  tg: LinkCategory;
  wa: LinkCategory;
  stats: {
    totalTg: number;
    totalWa: number;
    duplicatesRemoved: number;
  };
}

interface SingleCheck {
  active: boolean | null;
  name: string | null;
}

// ── Server-side cache ─────────────────────────────────────────────────────────

let cachedResult: ProcessResult | null = null;
let cachedLimit = 40;
let cachedCheckResults: Record<string, SingleCheck> = {};

const checkJob = {
  running: false,
  checked: 0,
  total: 0,
  totalActive: 0,
  totalInactive: 0,
  totalUnknown: 0,
  results: {} as Record<string, SingleCheck>,
  error: "" as string,
};

// ── Text / URL helpers ────────────────────────────────────────────────────────

function stripInvisible(s: string): string {
  return s.replace(
    /[\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u202f\u00ad\ufeff\u2060\u2061\u2062\u2063\u2064]/g,
    ""
  );
}

function isFamilyKeyword(text: string): boolean {
  return (
    text.includes("فاميلي") || text.includes("فاملي") ||
    text.includes("خاص فاميلي") || text.includes("خاص فاملي")
  );
}

function isMofeedKeyword(text: string): boolean {
  return text.includes("من مفيد") || text.includes("مفيد");
}

function stripDateBrackets(text: string): string {
  return text.replace(/\[[\d\u0660-\u0669\u200b-\u200f\u202a-\u202e\/\-,.،:؟\s\u061b]+\]/g, "").trim();
}

const GENERIC_INVITATION_RE = [
  /open this link to join/i, /use this link to join/i,
  /click this link to join/i, /join my whatsapp/i,
  /join my telegram/i, /انضم إلى مجموعتي/,
  /استعمل هذا الرابط/, /رابط للانضمام/,
  /هنا اسم المجموعة/, /اسم المجموعة الحقيقي/,
];

function isGenericInvitation(text: string): boolean {
  return GENERIC_INVITATION_RE.some((re) => re.test(text));
}

function isHeaderLine(text: string): boolean {
  const stripped = stripDateBrackets(text);
  const cleaned = stripped.replace(/[?؟!،,\s\u200b-\u200f\u202a-\u202e]/g, "");
  const hasOnlyKeyword = isFamilyKeyword(cleaned) || isMofeedKeyword(cleaned);
  const hadBrackets = /\[/.test(text);
  return (isFamilyKeyword(text) || isMofeedKeyword(text)) && (hadBrackets || hasOnlyKeyword);
}

function extractCleanName(raw: string): string {
  let s = raw;
  s = s.replace(/https?:\/\/\S+/g, "");
  s = stripDateBrackets(s);
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\u00ad]/g, "");
  s = s.replace(/[*•·\-|_=#+@؟?!،,;:]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s || isGenericInvitation(s)) return "";
  const cleaned = s.replace(/فاميلي|فاملي|خاص فاملي|خاص فاميلي|من مفيد|مفيد/g, "").trim();
  if (!cleaned) return "";
  return s;
}

function normalizeUrl(url: string): string {
  return stripInvisible(url).toLowerCase()
    .replace(/[.,;!?،؛]+$/, "")
    .replace(/\/+$/, "");
}

// ── Link processing ───────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/(?:chat\.whatsapp\.com|t\.me)\/[^\s"'<>)،,؛;]+/g;

type LineKind =
  | { type: "empty" }
  | { type: "header"; isFamily: boolean; isMofeed: boolean }
  | { type: "url"; urls: string[]; nameOnLine: string; rawLine: string }
  | { type: "name"; text: string };

function classifyLine(line: string): LineKind {
  if (!line) return { type: "empty" };
  const urls = [...line.matchAll(URL_RE)].map((m) => normalizeUrl(m[0]));
  if (urls.length > 0) {
    const nameOnLine = extractCleanName(line);
    return { type: "url", urls, nameOnLine, rawLine: line };
  }
  if (isHeaderLine(line)) {
    return { type: "header", isFamily: isFamilyKeyword(line), isMofeed: isMofeedKeyword(line) };
  }
  const clean = extractCleanName(line);
  if (clean) return { type: "name", text: clean };
  return { type: "empty" };
}

function processText(text: string, waLimit: number): { result: ProcessResult } {
  const lines = text.split(/\r?\n/).map((l) => stripInvisible(l.trim()));
  const result: ProcessResult = {
    tg: { family: [], mofeed: [] },
    wa: { family: [], mofeed: [] },
    stats: { totalTg: 0, totalWa: 0, duplicatesRemoved: 0 },
  };

  let currentIsFamily = false;
  let pendingName = "";
  let totalSeen = 0;
  const uniqueTg = new Set<string>();
  const uniqueWa = new Set<string>();

  for (const line of lines) {
    const kind = classifyLine(line);
    if (kind.type === "empty") { pendingName = ""; continue; }
    if (kind.type === "header") {
      currentIsFamily = kind.isFamily;
      pendingName = "";
      continue;
    }
    if (kind.type === "name") { pendingName = kind.text; continue; }
    if (kind.type === "url") {
      const name = kind.nameOnLine || pendingName;
      for (const url of kind.urls) {
        totalSeen++;
        const isTg = url.includes("t.me");
        const isWa = url.includes("chat.whatsapp.com");
        const entry: LinkEntry = { url, name: name || "" };
        if (isTg && !uniqueTg.has(url)) {
          uniqueTg.add(url);
          if (currentIsFamily) result.tg.family.push(entry);
          else result.tg.mofeed.push(entry);
        } else if (isWa && !uniqueWa.has(url)) {
          uniqueWa.add(url);
          if (currentIsFamily) result.wa.family.push(entry);
          else result.wa.mofeed.push(entry);
        }
      }
      pendingName = "";
    }
  }

  // Apply WhatsApp limit per category
  result.wa.family = result.wa.family.slice(0, waLimit);
  result.wa.mofeed = result.wa.mofeed.slice(0, waLimit);

  result.stats.totalTg = uniqueTg.size;
  result.stats.totalWa = uniqueWa.size;
  result.stats.duplicatesRemoved = Math.max(0, totalSeen - uniqueTg.size - uniqueWa.size);
  return { result };
}

// ── Link checker ──────────────────────────────────────────────────────────────

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

function extractOgTitle(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    html.match(/<title[^>]*>([^<]+)/i);
  return m ? m[1].trim() : null;
}

function extractOgDescription(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
}

// Session cookie jar (shared across all requests in a check job)
let sessionCookies: string[] = [];

function parseCookies(setCookieHeaders: string[]): void {
  for (const header of setCookieHeaders) {
    const cookiePart = header.split(";")[0].trim();
    if (cookiePart) {
      const [name] = cookiePart.split("=");
      // Replace existing cookie with same name or add
      const idx = sessionCookies.findIndex((c) => c.startsWith(name + "="));
      if (idx >= 0) sessionCookies[idx] = cookiePart;
      else sessionCookies.push(cookiePart);
    }
  }
}

async function checkLink(url: string): Promise<{ url: string; active: boolean | null; name: string | null }> {
  const hardTimeout = new Promise<{ url: string; active: boolean | null; name: string | null }>((resolve) =>
    setTimeout(() => resolve({ url, active: null, name: null }), 15000)
  );

  const doFetch = async (): Promise<{ url: string; active: boolean | null; name: string | null }> => {
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 14000);
    try {
      const headers: Record<string, string> = {
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ar,en-US;q=0.7,en;q=0.3",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      };
      if (sessionCookies.length > 0) {
        headers["Cookie"] = sessionCookies.join("; ");
      }

      const res = await fetch(url, {
        signal: ctrl.signal,
        headers,
        redirect: "follow",
      });
      clearTimeout(abortTimer);

      // Collect cookies from response to maintain session
      const setCookie = res.headers.getSetCookie?.() ?? [];
      if (setCookie.length > 0) parseCookies(setCookie);

      // 429 = rate limited → unknown (not inactive!)
      if (res.status === 429 || res.status === 503) {
        return { url, active: null, name: null };
      }

      // 403 = blocked → unknown
      if (res.status === 403) {
        return { url, active: null, name: null };
      }

      // Server errors → unknown
      if (res.status >= 500) {
        return { url, active: null, name: null };
      }

      // 404, 410 → definitely inactive
      if (res.status === 404 || res.status === 410) {
        return { url, active: false, name: null };
      }

      // Other 4xx → unknown
      if (res.status >= 400) {
        return { url, active: null, name: null };
      }

      if (res.status !== 200) {
        return { url, active: null, name: null };
      }

      const html = await res.text();
      if (!html || html.length < 100) {
        return { url, active: null, name: null };
      }

      const lc = html.toLowerCase();
      const ogTitle = extractOgTitle(html);
      const ogDesc = extractOgDescription(html);

      // ── WhatsApp ──────────────────────────────────────────────────────────
      if (url.includes("chat.whatsapp.com")) {
        const INVALID_PATTERNS = [
          "this invite link is invalid",
          "this invite link has expired",
          "link is no longer valid",
          "no matching group",
          "this link has been revoked",
          "link not found",
          "invalid invite link",
          "revoked",
          "this invite link",
        ];
        const definitelyInvalid = INVALID_PATTERNS.some((p) => lc.includes(p));
        if (definitelyInvalid) return { url, active: false, name: null };

        // og:description with join-related text → confirmed active
        const descHasInvite =
          ogDesc && (
            ogDesc.toLowerCase().includes("join this whatsapp group") ||
            ogDesc.toLowerCase().includes("join whatsapp group") ||
            ogDesc.toLowerCase().includes("whatsapp group chat") ||
            ogDesc.toLowerCase().includes("join group") ||
            /انضم.*مجموعة/.test(ogDesc)
          );

        if (descHasInvite) {
          return { url, active: true, name: ogTitle || null };
        }

        return { url, active: null, name: null };
      }

      // ── Telegram ──────────────────────────────────────────────────────────
      if (url.includes("t.me")) {
        const INVALID_TG = [
          "this invite link is invalid",
          "this link is invalid",
          "invalid link",
          "link is no longer valid",
          "channel not found",
          "group not found",
        ];
        const definitelyInvalid = INVALID_TG.some((p) => lc.includes(p));
        if (definitelyInvalid) return { url, active: false, name: null };

        return { url, active: null, name: null };
      }

      return { url, active: null, name: null };
    } catch {
      clearTimeout(abortTimer);
      return { url, active: null, name: null };
    }
  };

  return Promise.race([doFetch(), hardTimeout]);
}

// Delay between individual link checks to avoid WhatsApp rate limiting
const DELAY_BETWEEN_WA_CHECKS_MS = 8000;
const DELAY_BETWEEN_TG_CHECKS_MS = 1000;

async function runCheckJobInBackground(urls: string[]) {
  checkJob.running = true;
  checkJob.checked = 0;
  checkJob.total = urls.length;
  checkJob.totalActive = 0;
  checkJob.totalInactive = 0;
  checkJob.totalUnknown = 0;
  checkJob.results = {};
  checkJob.error = "";
  cachedCheckResults = {};
  sessionCookies = [];

  try {
    for (let i = 0; i < urls.length; i++) {
      if (!checkJob.running) break;
      const url = urls[i];
      const isWa = url.includes("chat.whatsapp.com");

      const result = await checkLink(url);
      const norm = normalizeUrl(result.url);
      const entry: SingleCheck = { active: result.active, name: result.name };
      checkJob.results[result.url] = entry;
      checkJob.results[norm] = entry;
      cachedCheckResults[result.url] = entry;
      cachedCheckResults[norm] = entry;

      if (result.active === true) checkJob.totalActive++;
      else if (result.active === false) checkJob.totalInactive++;
      else checkJob.totalUnknown++;

      checkJob.checked++;

      // Delay before next link to avoid rate limiting
      if (i < urls.length - 1 && checkJob.running) {
        const delay = isWa ? DELAY_BETWEEN_WA_CHECKS_MS : DELAY_BETWEEN_TG_CHECKS_MS;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } catch (err: any) {
    checkJob.error = err.message || "خطأ أثناء الفحص";
  } finally {
    checkJob.running = false;
  }
}

// ── Document builder ──────────────────────────────────────────────────────────

function getStatusLabel(active: boolean | null): { symbol: string; label: string; color: string } {
  if (active === true)  return { symbol: "✅", label: "نشط",           color: "2E7D32" };
  if (active === false) return { symbol: "❌", label: "منتهي",         color: "C62828" };
  return                       { symbol: "⚠️", label: "غير محدد",      color: "E65100" };
}

async function buildDocx(
  data: LinkCategory,
  platformTitle: string,
  limit: number,
  activeOnly: boolean,
  hasCheckResults: boolean
): Promise<Buffer> {
  const filterEntries = (entries: LinkEntry[]) => {
    if (!activeOnly || !hasCheckResults) return entries;
    return entries.filter((e) => {
      const r = cachedCheckResults[e.url] ?? cachedCheckResults[normalizeUrl(e.url)];
      if (r && r.active === false) return false;
      return true;
    });
  };

  const familyEntries = filterEntries(data.family);
  const mofeedEntries = filterEntries(data.mofeed);

  const paragraphs: Paragraph[] = [];

  // Section header paragraph
  const makeSectionHeader = (text: string, color: string) =>
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 200, after: 120 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 6, color },
      },
      children: [
        new TextRun({
          text,
          bold: true,
          color,
          size: 28, // 14pt
          font: "Calibri",
        }),
      ],
    });

  // Link entry paragraph — shows status + name + URL
  const makeLinkParagraph = (entry: LinkEntry, checkResult?: SingleCheck) => {
    const hasCheck = checkResult !== undefined;
    const statusInfo = hasCheck ? getStatusLabel(checkResult!.active) : null;
    const runs: TextRun[] = [];

    // Status symbol + label
    if (statusInfo) {
      runs.push(new TextRun({
        text: `${statusInfo.symbol} ${statusInfo.label}  `,
        bold: true,
        color: statusInfo.color,
        size: 22, // 11pt
        font: "Calibri",
      }));
    }

    // Group name (if any)
    const displayName = checkResult?.name || entry.name || "";
    if (displayName) {
      runs.push(new TextRun({
        text: `${displayName}`,
        bold: true,
        size: 22,
        font: "Calibri",
        color: "1A1A2E",
      }));
      runs.push(new TextRun({ text: "  ", size: 22 }));
    }

    // URL
    runs.push(new TextRun({
      text: entry.url,
      size: 20, // 10pt
      font: "Courier New",
      color: "1565C0",
    }));

    return new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 60, after: 60 },
      children: runs,
    });
  };

  const makeSeparator = () =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: "── ── ── ── ── ── ── ── ── ──", color: "BDBDBD", size: 18, font: "Calibri" })],
    });

  const makeEmptyLine = () =>
    new Paragraph({ children: [new TextRun({ text: "", size: 16 })] });

  // Title paragraph
  paragraphs.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 200 },
    children: [
      new TextRun({
        text: `روابط ${platformTitle}`,
        bold: true,
        size: 36, // 18pt
        font: "Calibri",
        color: "1A237E",
      }),
    ],
  }));

  if (activeOnly) {
    paragraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: "النشطة فقط ✅", size: 24, font: "Calibri", color: "2E7D32", bold: true })],
    }));
  }

  if (familyEntries.length > 0) {
    paragraphs.push(makeSectionHeader(`👪 خاص فاميلي — ${platformTitle}`, "6A1B9A"));
    let count = 0;
    for (const entry of familyEntries) {
      const cr = cachedCheckResults[entry.url] ?? cachedCheckResults[normalizeUrl(entry.url)];
      paragraphs.push(makeLinkParagraph(entry, hasCheckResults ? cr : undefined));
      count++;
      if (count % limit === 0 && count < familyEntries.length) {
        paragraphs.push(makeSeparator());
      }
    }
    paragraphs.push(makeEmptyLine());
  }

  if (mofeedEntries.length > 0) {
    paragraphs.push(makeSectionHeader(`📢 من مفيد — ${platformTitle}`, "1565C0"));
    let count = 0;
    for (const entry of mofeedEntries) {
      const cr = cachedCheckResults[entry.url] ?? cachedCheckResults[normalizeUrl(entry.url)];
      paragraphs.push(makeLinkParagraph(entry, hasCheckResults ? cr : undefined));
      count++;
      if (count % limit === 0 && count < mofeedEntries.length) {
        paragraphs.push(makeSeparator());
      }
    }
  }

  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/process", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ message: "لم يتم رفع أي ملف" });

    const limit = parseInt(req.body.whatsappLimit) || 40;
    cachedLimit = limit;
    cachedResult = null;
    cachedCheckResults = {};
    checkJob.running = false;
    checkJob.checked = 0;
    checkJob.total = 0;
    checkJob.totalActive = 0;
    checkJob.totalInactive = 0;
    checkJob.totalUnknown = 0;
    checkJob.results = {};

    const { value: text } = await mammoth.extractRawText({ buffer: req.file.buffer });
    if (!text || !text.trim()) return res.status(400).json({ message: "الملف فارغ أو لا يحتوي على نص مقروء" });

    const { result } = processText(text, limit);
    cachedResult = result;

    // Convert to frontend-compatible format (flat string entries for backward compat)
    const toFlatEntries = (entries: LinkEntry[]) =>
      entries.map((e) => (e.name ? `${e.name} ${e.url}` : e.url));

    return res.json({
      tg: {
        family: toFlatEntries(result.tg.family),
        mofeed: toFlatEntries(result.tg.mofeed),
      },
      wa: {
        family: toFlatEntries(result.wa.family),
        mofeed: toFlatEntries(result.wa.mofeed),
      },
      stats: result.stats,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message || "خطأ في المعالجة" });
  }
});

router.post("/check-links/start", (_req: Request, res: Response) => {
  if (!cachedResult) return res.status(400).json({ message: "لا توجد نتائج معالجة" });

  const allEntries = [
    ...cachedResult.tg.family,
    ...cachedResult.tg.mofeed,
    ...cachedResult.wa.family,
    ...cachedResult.wa.mofeed,
  ];
  const urls = [...new Set(allEntries.map((e) => e.url).filter(Boolean))];

  runCheckJobInBackground(urls).catch(console.error);
  return res.json({ started: true, total: urls.length });
});

router.get("/check-links/status", (_req: Request, res: Response) => {
  return res.json({
    running: checkJob.running,
    checked: checkJob.checked,
    total: checkJob.total,
    totalActive: checkJob.totalActive,
    totalInactive: checkJob.totalInactive,
    totalUnknown: checkJob.totalUnknown,
    results: checkJob.results,
    error: checkJob.error,
  });
});

router.post("/check-links/cancel", (_req: Request, res: Response) => {
  checkJob.running = false;
  return res.json({ cancelled: true });
});

router.get("/download/:type", async (req: Request, res: Response) => {
  try {
    const type = req.params.type as "tg" | "wa";
    const activeOnly = req.query.activeOnly === "1";

    if (!cachedResult) return res.status(400).json({ message: "لا توجد نتائج معالجة. يرجى معالجة ملف أولاً" });

    const data = type === "tg" ? cachedResult.tg : cachedResult.wa;
    const platformTitle = type === "tg" ? "تيليجرام" : "واتساب";
    const baseName = type === "tg" ? "Telegram" : "WhatsApp";
    const filename = activeOnly ? `${baseName}_Links_Active.docx` : `${baseName}_Links_All.docx`;
    const hasCheckResults = Object.keys(cachedCheckResults).length > 0;

    const buffer = await buildDocx(data, platformTitle, cachedLimit, activeOnly, hasCheckResults);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);
  } catch (err: any) {
    return res.status(500).json({ message: err.message || "خطأ في توليد الملف" });
  }
});

export default router;
