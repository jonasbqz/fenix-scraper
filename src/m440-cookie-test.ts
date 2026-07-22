/**
 * Cookie / Cloudflare bypass smoke test — NO DB, NO mango-image upload.
 *
 * Validates Scrapling session + curl_cffi fetch (NOT Bun fetch — TLS mismatch).
 *
 * Usage:
 *   # Scrapling + curl_cffi (pip install curl_cffi; or bun run setup:scrapling)
 *   M440_SCRAPLING_COOKIES=true SCRAPER_M440_URL=https://m440.in bun run cookie-test
 *
 *   # Manual cookies from browser (skip Scrapling)
 *   M440_COOKIE_HEADER='laravel_session=...; cf_clearance=...' \
 *   SCRAPER_M440_URL=https://m440.in bun run cookie-test
 *
 * Env:
 *   SCRAPER_M440_URL — must be https://m440.in when using cookies (NOT mango-proxy)
 *   M440_SCRAPLING_COOKIES — run scripts/m440-solve.py when true
 *   M440_COOKIE_HEADER — fixed Cookie header (overrides Scrapling)
 */

import { EnvConfig } from "@/lib/config";
import { Logger } from "@/lib/logger";
import {
  fetchM440,
  getM440CookieHeader,
  isM440ScraplingCookiesEnabled,
} from "@/lib/m440-cookie-session";
import {
  isM440ProxyUrl,
  M440_ORIGIN,
  M440_PROXY,
  resolveM440BaseUrl,
} from "@/lib/m440-base-url";
import { m440ChapterImageDownloadUrl } from "@/lib/mango-image-upload";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const log = new Logger("cookie-test");
const config = new EnvConfig();

function maskCookie(header: string): string {
  return header
    .split(";")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return part.trim();
      const name = part.slice(0, eq).trim();
      const val = part.slice(eq + 1);
      if (name === "cf_clearance" || name === "laravel_session") {
        return `${name}=${val.slice(0, 12)}…(${val.length} chars)`;
      }
      return `${name}=…`;
    })
    .join("; ");
}

async function probe(
  label: string,
  url: string,
  accept: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const res = await fetchM440(
    url,
    {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: accept,
        Referer: M440_ORIGIN,
        Origin: M440_ORIGIN,
      },
    },
    config,
    log,
  );

  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let detail = `content-type=${ct} bytes=${text.length}`;

  if (url.includes("/lasted")) {
    try {
      const json = JSON.parse(text) as { data?: unknown[] };
      detail += ` mangas=${json.data?.length ?? 0}`;
    } catch {
      detail += ` body=${text.slice(0, 60).replace(/\s+/g, " ")}`;
    }
  } else if (ct.includes("json")) {
    detail += " (json)";
  } else if (text.includes("var pages")) {
    detail += " (chapter pages script found)";
  } else if (
    text.includes("Just a moment")
    || text.includes("cf-browser-verification")
    || text.includes("challenge-platform")
  ) {
    detail += " (CLOUDFLARE BLOCK PAGE)";
  }

  const ok = res.ok;
  console.log(`${ok ? "✓" : "✗"} ${label} → HTTP ${res.status} ${detail}`);
  return { ok, status: res.status, detail };
}

async function main(): Promise<void> {
  const baseUrl = resolveM440BaseUrl(config);
  const scrapling = isM440ScraplingCookiesEnabled(config);
  const manual = Boolean(config.get("M440_COOKIE_HEADER")?.trim());

  console.log("=== m440 cookie test (no upload) ===");
  console.log(`baseUrl:        ${baseUrl}`);
  console.log(`scrapling:      ${scrapling}`);
  console.log(`manual cookie:  ${manual}`);
  console.log(`proxy warning:  ${isM440ProxyUrl(baseUrl) ? "YES — cookies usually fail via mango-proxy" : "no"}`);

  if (isM440ProxyUrl(baseUrl) && (scrapling || manual)) {
    console.warn(
      "\n⚠  Use SCRAPER_M440_URL=https://m440.in with cookies. " +
        `Proxy ${M440_PROXY} returns 403 even with valid cf_clearance.\n`,
    );
  }

  console.log("\n--- cookie source ---");
  const cookieHeader = await getM440CookieHeader(config, log);
  if (!cookieHeader) {
    console.error("✗ No cookies available.\n");
    if (!scrapling && !manual) {
      console.error("Enable one of these in .env:\n");
      console.error("  M440_SCRAPLING_COOKIES=true");
      console.error("  SCRAPER_M440_URL=https://m440.in");
      console.error("");
      console.error("If python3 scripts/m440-solve.py already works, only the first line is missing.");
      console.error("Or paste browser cookies:");
      console.error("  M440_COOKIE_HEADER=laravel_session=...; cf_clearance=...");
      console.error("");
      console.error("One-liner test:");
      console.error("  M440_SCRAPLING_COOKIES=true SCRAPER_M440_URL=https://m440.in bun run cookie-test");
      console.error("");
      console.error("PEP 668 pip fix: bun run setup:scrapling");
      console.error("Also needs curl_cffi for fetch (included in setup:scrapling).");
    }
    process.exit(1);
  }
  console.log(`cookie header: ${maskCookie(cookieHeader)}`);
  console.log(
    `has laravel_session: ${cookieHeader.includes("laravel_session")}`,
  );
  console.log(`has cf_clearance:    ${cookieHeader.includes("cf_clearance")}`);

  console.log("\n--- fetch probes ---");
  let failed = 0;

  const listing = await probe(
    "listing JSON",
    `${baseUrl}/lasted?p=1`,
    "application/json",
  );
  if (!listing.ok) failed++;

  let mangaSlug = "ryuutsuhegui";
  let chapterSlug = "1";

  if (listing.ok) {
    const res = await fetchM440(
      `${baseUrl}/lasted?p=1`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
      config,
      log,
    );
    try {
      const json = (await res.json()) as {
        data?: Array<{
          manga_slug: string;
          chapters?: Array<{ chapter_slug: string }>;
        }>;
      };
      const first = json.data?.find((m) => (m.chapters?.length ?? 0) > 0);
      if (first) {
        mangaSlug = first.manga_slug;
        chapterSlug = first.chapters![0]!.chapter_slug;
      }
    } catch {
      /* use defaults */
    }
  }

  const comic = await probe(
    "comic HTML",
    `${baseUrl}/manga/${mangaSlug}`,
    "text/html",
  );
  if (!comic.ok) failed++;

  const chapter = await probe(
    "chapter HTML",
    `${baseUrl}/manga/${mangaSlug}/${chapterSlug}`,
    "text/html",
  );
  if (!chapter.ok) failed++;

  // Parse first real page URL from chapter HTML (not a guessed filename)
  let imageUrl: string | null = null;
  {
    const res = await fetchM440(
      `${baseUrl}/manga/${mangaSlug}/${chapterSlug}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } },
      config,
      log,
    );
    const html = await res.text();
    const match = html.match(/var\s+pages\s*=\s*(\[[\s\S]*?\]);/);
    if (match) {
      try {
        const pagesData = JSON.parse(match[1]!) as Array<{ page_image: string; external: string }>;
        const first = pagesData[0];
        if (first && first.external !== "1") {
          const canonical = `${M440_ORIGIN}/uploads/manga/${mangaSlug}/chapters/${chapterSlug}/${first.page_image}`;
          imageUrl = m440ChapterImageDownloadUrl(canonical);
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!imageUrl) {
    console.log("⚠ sample image → skipped (could not parse chapter pages from HTML)");
  } else {
  const imageRes = await fetchM440(
    imageUrl,
    {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "image/*",
        Referer: M440_ORIGIN,
        Origin: M440_ORIGIN,
      },
    },
    config,
    log,
  );
  const imageCt = imageRes.headers.get("content-type") || "";
  const imageOk = imageRes.ok && imageCt.startsWith("image/");
  console.log(
    `${imageOk ? "✓" : "✗"} sample image → HTTP ${imageRes.status} content-type=${imageCt} url=${imageUrl}`,
  );
  if (!imageOk) failed++;
  }

  console.log("\n=== summary ===");
  if (failed === 0) {
    console.log("All probes passed. Cookies work for scrape + image CDN.");
    process.exit(0);
  }
  console.log(`${failed} probe(s) failed.`);
  if (isM440ProxyUrl(baseUrl)) {
    console.log("Fix: SCRAPER_M440_URL=https://m440.in");
  } else if (!manual && scrapling) {
    console.log("Try manual cookies: M440_COOKIE_HEADER='laravel_session=...; cf_clearance=...'");
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
