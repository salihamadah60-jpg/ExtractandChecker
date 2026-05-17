/**
 * link-filter.ts — Link classification and filtering
 * Separates personal WhatsApp contacts from group/channel invite links.
 * Only group invites and channel links should reach the checker.
 */

export type LinkCategory = "group_invite" | "channel" | "personal_contact" | "personal_message" | "api_send" | "unknown";

/**
 * Classifies a WhatsApp URL into a specific category.
 */
export function classifyWhatsAppLink(url: string): LinkCategory {
  const u = url.toLowerCase();
  if (/chat\.whatsapp\.com\/[a-z0-9_-]/i.test(u)) return "group_invite";
  if (/whatsapp\.com\/channel\/[a-z0-9_-]/i.test(u)) return "channel";
  if (/wa\.me\/message\//i.test(u)) return "personal_message";
  if (/wa\.me\/qr\//i.test(u)) return "personal_contact";
  if (/wa\.me\/[\d+]/i.test(u)) return "personal_contact";
  if (/api\.whatsapp\.com\/send/i.test(u)) return "api_send";
  return "unknown";
}

/**
 * Returns true only for group invites and channels — the only types we want to check/join.
 */
export function isGroupOrChannel(url: string): boolean {
  const cat = classifyWhatsAppLink(url);
  return cat === "group_invite" || cat === "channel";
}

/**
 * Master WhatsApp regex — ONLY matches group invites and channel links.
 * Explicitly excludes:
 *   - wa.me/+phone (personal contact)
 *   - wa.me/phone (personal contact)
 *   - wa.me/message/CODE (personal contact page)
 *   - wa.me/qr/CODE (QR contact)
 *   - api.whatsapp.com/send?... (direct message link)
 */
export const WA_GROUP_REGEX =
  /https?:\/\/(?:chat\.whatsapp\.com\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%.+-]+)?|whatsapp\.com\/channel\/[A-Za-z0-9_-]+)/g;

/**
 * Telegram regex — groups and channels only.
 */
export const TG_REGEX =
  /https?:\/\/(?:t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+|t\.me\/[A-Za-z0-9_]+|telegram\.me\/[A-Za-z0-9_]+)/g;

/**
 * Extract and deduplicate links from raw text, returning only group/channel links.
 */
export function extractGroupLinks(text: string): { whatsapp: string[]; telegram: string[] } {
  const clean = (raw: string) => raw.replace(/[.,;)>\]'"»«]+$/, "").trim();

  const waRaw = [...text.matchAll(new RegExp(WA_GROUP_REGEX.source, "g"))].map((m) => clean(m[0]));
  const tgRaw = [...text.matchAll(new RegExp(TG_REGEX.source, "g"))].map((m) => clean(m[0]));

  const dedup = (arr: string[]) => [...new Set(arr.filter(Boolean))];
  return { whatsapp: dedup(waRaw), telegram: dedup(tgRaw) };
}
