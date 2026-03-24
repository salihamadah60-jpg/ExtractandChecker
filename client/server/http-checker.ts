/**
 * HTTP-based WhatsApp group link checker.
 * Validates chat.whatsapp.com/CODE links without any WhatsApp login.
 * Works by fetching the invite page and reading the HTML response.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type LinkCheckResult = {
  link: string;
  status: "valid" | "invalid" | "error" | "pending";
  info?: string;
};

export async function checkGroupLinkHTTP(
  code: string
): Promise<"valid" | "invalid"> {
  const url = `https://chat.whatsapp.com/${code}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });

  const html = await res.text();

  // WhatsApp returns 200 for both valid and invalid links, so we parse the body
  const invalid =
    html.includes("invalid") ||
    html.includes("no longer valid") ||
    html.includes("link has expired") ||
    html.includes("revoked") ||
    html.toLowerCase().includes("this link is not valid") ||
    html.toLowerCase().includes("not a valid") ||
    html.toLowerCase().includes("join-group-invalid") ||
    // When group doesn't exist, WA omits og:title entirely or sets it to error phrase
    (!html.includes('og:title') && !html.includes('og:image'));

  return invalid ? "invalid" : "valid";
}

export async function checkLinksHTTP(
  links: string[],
  onProgress: (results: LinkCheckResult[], progress: number) => void
): Promise<LinkCheckResult[]> {
  const results: LinkCheckResult[] = links.map((link) => ({
    link,
    status: "pending",
  }));

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const result = results[i];

    try {
      const groupMatch = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
      const phoneMatch =
        link.match(/wa\.me\/([\d+]+)/) ?? link.match(/phone=([\d+]+)/);

      if (groupMatch) {
        result.status = await checkGroupLinkHTTP(groupMatch[1]);
        result.info =
          result.status === "valid"
            ? "مجموعة نشطة"
            : "الرابط منتهٍ أو غير موجود";
      } else if (phoneMatch) {
        // wa.me links cannot be reliably checked without a WA session
        result.status = "error";
        result.info = "يتطلب فحص أرقام الهاتف تسجيل الدخول عبر QR";
      } else {
        result.status = "error";
        result.info = "صيغة رابط غير معروفة";
      }
    } catch (err: any) {
      result.status = "error";
      result.info = "خطأ في الاتصال";
    }

    onProgress([...results], i + 1);

    // Respect WhatsApp's rate limits
    if (i < links.length - 1) {
      const delay = 1000 + Math.random() * 1500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return results;
}
