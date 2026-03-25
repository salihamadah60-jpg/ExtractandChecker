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
  name?: string;
};

function extractOgTitle(html: string): string | undefined {
  const match = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  return match ? match[1].trim() : undefined;
}

function truncateTo3Words(name: string): string {
  return name.split(/\s+/).slice(0, 3).join(" ");
}

export async function checkGroupLinkHTTP(
  code: string
): Promise<{ status: "valid" | "invalid"; name?: string }> {
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

  if (invalid) return { status: "invalid" };

  const rawName = extractOgTitle(html);
  const name = rawName ? truncateTo3Words(rawName) : undefined;
  return { status: "valid", name };
}

export async function checkLinksHTTP(
  existingResults: LinkCheckResult[],
  onProgress: (results: LinkCheckResult[], progress: number) => void
): Promise<LinkCheckResult[]> {
  const results: LinkCheckResult[] = existingResults.map((r) => ({ ...r }));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    // Skip links already processed in a previous (or current) run
    if (result.status !== "pending") continue;

    const link = result.link;

    try {
      const groupMatch = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
      const phoneMatch =
        link.match(/wa\.me\/([\d+]+)/) ?? link.match(/phone=([\d+]+)/);

      if (groupMatch) {
        const checkResult = await checkGroupLinkHTTP(groupMatch[1]);
        result.status = checkResult.status;
        result.name = checkResult.name;
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

    const done = results.filter((r) => r.status !== "pending").length;
    onProgress([...results], done);

    // Small delay to avoid hammering the server
    if (i < results.length - 1) {
      const delay = 300 + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return results;
}
