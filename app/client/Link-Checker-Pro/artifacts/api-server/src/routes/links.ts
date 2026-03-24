import { Router, type IRouter } from "express";
import { CheckLinksBody, CheckLinksResponse } from "@workspace/api-zod";
import { load } from "cheerio";

const router: IRouter = Router();

const CONCURRENCY_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 10000;

async function checkUrl(url: string): Promise<{ status: number | null; active: boolean; error: string | null }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LinkChecker/1.0)",
        },
      });
      clearTimeout(timer);
      const active = response.status >= 200 && response.status < 400;
      return { status: response.status, active, error: null };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        return { status: null, active: false, error: "Request timed out" };
      }
      return { status: null, active: false, error: (err as Error).message };
    }
  } catch (err) {
    return { status: null, active: false, error: (err as Error).message };
  }
}

async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

router.post("/check-links", async (req, res) => {
  const parseResult = CheckLinksBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body: url is required" });
    return;
  }

  const { url: pageUrl } = parseResult.data;

  let normalizedUrl: string;
  try {
    const parsed = new URL(pageUrl);
    normalizedUrl = parsed.href;
  } catch {
    res.status(400).json({ error: "Invalid URL provided" });
    return;
  }

  let pageHtml: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinkChecker/1.0)",
      },
    });
    clearTimeout(timer);
    if (!response.ok) {
      res.status(400).json({ error: `Failed to fetch page: HTTP ${response.status}` });
      return;
    }
    pageHtml = await response.text();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      res.status(400).json({ error: "Request to page timed out" });
    } else {
      res.status(400).json({ error: `Failed to fetch page: ${(err as Error).message}` });
    }
    return;
  }

  const $ = load(pageHtml);
  const baseUrl = new URL(normalizedUrl);

  const rawLinks: { url: string; text: string }[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim() || href;

    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      return;
    }

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, baseUrl).href;
    } catch {
      return;
    }

    if (!seen.has(absoluteUrl)) {
      seen.add(absoluteUrl);
      rawLinks.push({ url: absoluteUrl, text });
    }
  });

  const results = await processInBatches(rawLinks, CONCURRENCY_LIMIT, async ({ url, text }) => {
    const { status, active, error } = await checkUrl(url);
    return { url, text, status, active, error };
  });

  const activeLinks = results.filter((r) => r.active).length;
  const brokenLinks = results.length - activeLinks;

  const responseData = CheckLinksResponse.parse({
    pageUrl: normalizedUrl,
    totalLinks: results.length,
    activeLinks,
    brokenLinks,
    results,
  });

  res.json(responseData);
});

export default router;
