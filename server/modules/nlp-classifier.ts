/**
 * nlp-classifier.ts — Simple NLP-based ad/spam detection
 *
 * Uses cost-free heuristics (no external API) to classify:
 *  1. Whether a single MESSAGE is an advertisement
 *  2. Whether a GROUP (by its message history) is an ad-group vs normal
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
