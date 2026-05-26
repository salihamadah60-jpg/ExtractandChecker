/**
 * nlp-classifier.ts — Simple NLP-based ad/spam detection + medical-group detection
 *
 * Uses cost-free heuristics (no external API) to classify:
 *  1. Whether a single MESSAGE is an advertisement
 *  2. Whether a GROUP (by its message history) is an ad-group vs normal
 *  3. Whether a GROUP NAME belongs to the medical / healthcare domain
 *
 * Signals used:
 *  - Link density (too many links = ad)
 *  - Message length (copy-paste walls of text = ad)
 *  - Repetition (same message pattern = ad)
 *  - Arabic ad keywords (price, contact, services)
 *  - Phone number presence
 */

// ── Ad signal patterns ───────────────────────────────────────────────────────

const AD_KEYWORD_PATTERNS: RegExp[] = [
  /للتواصل\s*واتس/i,
  /تواصل\s*واتس/i,
  /تواصل\s*معنا/i,
  /اشترك\s*الآن/i,
  /سعر\s*مناسب/i,
  /ضمان\s+الدرجات/i,
  /حل\s+اختبارات/i,
  /حل\s+واجبات/i,
  /سكليف\s+صحتي/i,
  /اجازة\s+مرضية/i,
  /إجازة\s+مرضية/i,
  /خدمات\s+طلابية/i,
  /نقدم\s+لكم/i,
  /شعارنا\s+دائما/i,
  /مع\s+ضمان/i,
  /ارخص\s+سعر/i,
  /مقاعد\s+محدودة/i,
];

// ── Medical domain patterns ──────────────────────────────────────────────────

/**
 * Patterns matched against a GROUP NAME (or description) to detect medical groups.
 * Covers: international medical exams, specialties, Arabic medical terms,
 * Saudi/Gulf health bodies, and common study-group naming.
 */
export const MEDICAL_NAME_PATTERNS: RegExp[] = [
  // International postgraduate medical exams (UK Royal Colleges)
  /\bMRCEM\b/i,   /\bMRCOG\b/i,   /\bMRCGP\b/i,
  /\bMRCP\b/i,    /\bMRCS\b/i,    /\bMRCPCH\b/i,
  /\bFRCR\b/i,    /\bFRCS\b/i,    /\bFRCA\b/i,
  /\bFRCEM\b/i,   /\bFCEM\b/i,
  /\bPLAB\b/i,    /\bUSMLE\b/i,   /\bSCFHS\b/i,
  /\bDHA\b/i,     /\bHAAD\b/i,    /\bOET\b/i,

  // Medical specialties (English)
  /\bOphthalmol/i,   /\bCardiol/i,    /\bNeurolog/i,
  /\bOncolog/i,      /\bPaediatric/i, /\bPediatric/i,
  /\bNeonatal/i,     /\bObstetric/i,  /\bGynae/i,
  /\bGynecol/i,      /\bUrology/i,    /\bNephrol/i,
  /\bEndocrinol/i,   /\bRheumatol/i,  /\bDermatol/i,
  /\bRadiolog/i,     /\bPatholog/i,   /\bAnaesth/i,
  /\bAnesthesiol/i,  /\bIntensive\s+care/i,
  /\bEmergency\s+med/i, /\bInternal\s+med/i,
  /\bGeneral\s+surg/i,  /\bOrthop/i,
  /\bPsychiatr/i,    /\bGastroenterol/i, /\bPulmonol/i,
  /\bHematol/i,      /\bInfectious\s+dis/i,

  // Arabic medical / health terms
  /طب\s*(الطوارئ|الباطني|الأسرة|الجراحة|النساء|الأطفال|العيون|القلب|الأعصاب)/i,
  /\bطبي[ةه]?\b/i,
  /\bصح[يةه]+\b/i,
  /\bمستشفى\b/i,
  /\bمستشفيات\b/i,
  /\bعيادة\b/i,
  /\bعيادات\b/i,
  /\bتمريض\b/i,
  /\bممرض[ةه]?\b/i,
  /\bطبيب\b/i,
  /\bأطباء\b/i,
  /\bدكتور\b/i,
  /\bجراح\b/i,
  /\bجراحة\b/i,
  /\bصيدل[يةه]+\b/i,
  /\bصيدلان[يةه]+\b/i,
  /\bتشخيص\b/i,
  /\bعلاج\b/i,
  /\bأمراض\b/i,
  /\bهيئة\s+الصحة\b/i,
  /\bوزارة\s+الصحة\b/i,
  /\bالمجلس\s+السعودي\b/i,

  // Common medical group-name patterns
  /\bmedic[al]*/i,   /\bhealth\s*(care)?/i,   /\bclinic[al]*/i,
  /\bhospital\b/i,   /\bnursi?ng\b/i,         /\bpharmac[y]/i,
  /\bsurger[y]/i,    /\bspecialt[y]/i,
];

/**
 * Returns true if a group name (or description) matches medical domain patterns.
 */
export function isMedicalGroup(nameOrDesc: string): boolean {
  if (!nameOrDesc) return false;
  return MEDICAL_NAME_PATTERNS.some((p) => p.test(nameOrDesc));
}

const PHONE_PATTERN = /\+?\d[\d\s-]{8,}\d/;

// ── Single message classification ────────────────────────────────────────────

export interface MessageClassification {
  isAd: boolean;
  confidence: number;  // 0.0 – 1.0
  signals: string[];
}

export function classifyMessage(
  text: string,
  embeddedLinks: string[] = []
): MessageClassification {
  const signals: string[] = [];
  let score = 0;

  const wordCount = text.trim().split(/\s+/).length;
  const linkCount = embeddedLinks.length + (text.match(/https?:\/\//g) || []).length;

  // Signal 1: High link density
  const linkDensity = linkCount / Math.max(1, wordCount);
  if (linkDensity > 0.08) {
    signals.push(`high_link_density:${linkDensity.toFixed(2)}`);
    score += 0.35;
  }

  // Signal 2: Very long message (copy-paste)
  if (text.length > 400) {
    signals.push(`long_text:${text.length}`);
    score += 0.2;
  }

  // Signal 3: Contains phone number
  if (PHONE_PATTERN.test(text)) {
    signals.push("has_phone_number");
    score += 0.15;
  }

  // Signal 4: Matches Arabic ad keywords
  const matchedKeywords = AD_KEYWORD_PATTERNS.filter((p) => p.test(text));
  if (matchedKeywords.length > 0) {
    signals.push(`ad_keywords:${matchedKeywords.length}`);
    score += 0.15 * Math.min(matchedKeywords.length, 3);
  }

  // Signal 5: Emoji overuse (ads often use many emojis)
  const emojiCount = (text.match(/[\u{1F300}-\u{1FFFF}]/gu) || []).length;
  if (emojiCount > 5) {
    signals.push(`emoji_overuse:${emojiCount}`);
    score += 0.1;
  }

  const confidence = Math.min(1, score);
  return { isAd: confidence >= 0.4, confidence, signals };
}

// ── Group classification by message history ───────────────────────────────────

export type GroupNature = "normal" | "ads" | "mixed";

export interface GroupClassification {
  nature: GroupNature;
  adRatio: number;    // 0–1: fraction of messages classified as ads
  sampleSize: number;
}

export function classifyGroup(messages: string[]): GroupClassification {
  if (!messages.length) {
    return { nature: "normal", adRatio: 0, sampleSize: 0 };
  }

  const classifications = messages.map((m) => classifyMessage(m));
  const adCount = classifications.filter((c) => c.isAd).length;
  const adRatio = adCount / messages.length;

  let nature: GroupNature;
  if (adRatio >= 0.75) nature = "ads";
  else if (adRatio >= 0.35) nature = "mixed";
  else nature = "normal";

  return { nature, adRatio, sampleSize: messages.length };
}
