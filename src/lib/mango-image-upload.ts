// Shared per-image upload function for the scraper → mango-image integration.
//
// This is the SINGLE source of truth for the per-image work (download from
// the source CDN with antibot headers, validate client-side, upload via the
// foundation helper, log per-image and a chapter summary). It is called from:
//
//   1. Rule #1 — the PeerlessAdapter (m440/peerless) calls it per chapter
//      right after a chapter is scraped and persisted. The original ~135
//      lines of logic used to live inline in the adapter; they now delegate
//      here for DRY.
//
//   2. Rule #3 — the backfill (CLI `bun run upload <scan>` and the worker's
//      scheduled interval) iterates the existing chapters in the DB and
//      calls it per chapter to re-upload (idempotent — mango-image replaces
//      by default).
//
// The behavior here is BIT-EQUIVALENT to the rule #1 method that shipped in
// commit 6765f75: same gate, same per-image validation, same log lines,
// same per-image delay, same chapter summary. Do not change the behavior
// here without re-verifying both callers (adapter + backfill).

import type { EnvConfig } from "./config";
import { Logger } from "./logger";
import { getScraperMode, type ScraperName, type ScraperMode } from "./scraper-mode";
import {
  uploadImageToMangoImage,
  MANGO_IMAGE_URL_ENV,
  MANGO_IMAGE_API_KEY_ENV,
} from "./mango-image";
import type { RetryQueue } from "./retry-queue";
import {
  fetchM440,
  getM440CookieHeader,
} from "./m440-cookie-session";
import { fetchImageViaProxy, type ProxyConfig } from "./proxy-fetch";

/** Env var for delay between mango-image uploads (separate from HTML scrape delay). */
export const MANGO_IMAGE_DELAY_MS_ENV = "MANGO_IMAGE_DELAY_MS";

/** Identity origin for the m440/peerless source. Used as Referer/Origin when downloading images. */
const M440_ORIGIN = "https://m440.in";

/** Strict allowlist of image content types the per-image download will accept. */
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** 25 MiB client-side cap. Slightly above mango-image's 20 MiB server cap so we never send something the server will reject for size. */
const MAX_BYTES = 25 * 1024 * 1024;

/** 15s per-image download timeout. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

export interface UploadChapterPagesInput {
  /** Full image URLs to download + upload (e.g. https://s1.m440.in/uploads/...). */
  pages: string[];
  /** Manga slug — used only for the chapter summary log line. */
  mangaSlug: string;
  /** Chapter slug — used only for the chapter summary log line. */
  chapterSlug: string;
  /** Scraper name — drives the gate (only m440/peerless are allowed). */
  scraperName: ScraperName;
  /** Env config — used for the gate (MANGO_IMAGE_URL / MANGO_IMAGE_API_KEY) and upload delays. */
  config: EnvConfig;
  /** Logger from the caller. The log line format (prefix `[m440]`, per-image lines, chapter summary) is fixed regardless of caller. */
  log: Logger;
  /**
   * Optional override for the normalized scraper mode. If omitted, the
   * function reads SCRAPER_MODE from config and normalizes via
   * getScraperMode(). The override exists so the adapter (which already has
   * the normalized value from ScraperService) can pass it in directly
   * without re-normalizing — bit-equivalent to the rule #1 method that used
   * the value the service had computed.
   */
  scraperMode?: ScraperMode;
  /**
   * Optional retry queue. When provided, failed images are enqueued for
   * later retry on the next `bun run upload` cycle. When omitted, failures
   * are only logged (original behavior).
   */
  retryQueue?: RetryQueue;
  /**
   * Optional proxy for downloading m440 images. When provided, images are
   * fetched through this proxy instead of direct fetch (or fetchM440).
   * Useful for rotating IPs to avoid rate limits.
   */
  proxy?: ProxyConfig;
}

export interface UploadChapterPagesResult {
  uploaded: number;
  failed: number;
  skipped: number;
  /**
   * Present when the function returned without doing per-image work:
   *   - "gate": MANGO_IMAGE_URL or MANGO_IMAGE_API_KEY is not set in config.
   *   - "no-config": caller did not pass config (kept for type completeness;
   *     the public API requires config so this is unreachable today).
   *   - "wrong-mode": SCRAPER_MODE is not m440_only|all.
   *   - "no-pages": pages was empty (no work to do, but the gate was open).
   * Undefined when the function ran the per-image loop (skipped may still be
   * non-zero due to per-image validation failures or wrong-scraper gate).
   */
  skippedReason?: "gate" | "no-config" | "wrong-mode" | "no-pages";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeSleep(ms: number): Promise<void> {
  return ms > 0 ? sleep(ms) : Promise.resolve();
}

function getMangoImageDelayMs(config: EnvConfig): number {
  return config.getNumber(MANGO_IMAGE_DELAY_MS_ENV, 0);
}

async function downloadM440Image(
  pageUrl: string,
  config: EnvConfig,
  log: Logger,
  proxy?: ProxyConfig,
): Promise<Response> {
  if (proxy) {
    const cookieHeader = await getM440CookieHeader(config, log);
    const result = await fetchImageViaProxy(
      pageUrl,
      proxy,
      M440_ORIGIN,
      DOWNLOAD_TIMEOUT_MS,
      cookieHeader,
      log,
    );
    if (!result) {
      log.warn(`proxy download failed url=${pageUrl}`);
      return new Response(null, { status: 502, statusText: "proxy fetch failed" });
    }
    return new Response(result.body as BodyInit, {
      status: 200,
      headers: { "content-type": result.contentType },
    });
  }

  return fetchM440(
    pageUrl,
    {
      headers: {
        "Referer": M440_ORIGIN,
        "Origin": M440_ORIGIN,
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    },
    config,
    log,
  );
}

export function m440CoverCanonicalUrl(url: string): string {
  return url
    .replace("://s2.m440.in", "://m440.in")
    .replace("://s1.m440.in", "://m440.in");
}

/**
 * Normalize any m440 chapter image URL to the identity origin path.
 * External URLs pass through unchanged.
 */
export function m440ChapterCanonicalUrl(url: string): string {
  if (!url || url === "undefined") return "";
  return url
    .replace("://s2.m440.in", "://m440.in")
    .replace("://s1.m440.in", "://m440.in");
}

/** Preferred chapter CDN order. Legacy .jpg lives on s1; modern .webp on s2. */
export function m440ChapterImageDownloadCandidates(canonicalUrl: string): string[] {
  const canonical = m440ChapterCanonicalUrl(canonicalUrl);

  // External URLs (blogspot, imgur, etc.) — not hosted on m440 CDN.
  // Use as-is, no CDN fallback needed.
  if (!canonical.startsWith("https://m440.in")) {
    return [canonical];
  }

  const path = canonical.replace(/^https:\/\/m440\.in/, "");
  const s2 = `https://s2.m440.in${path}`;
  const s1 = `https://s1.m440.in${path}`;
  const filename = path.split("/").pop()?.toLowerCase() ?? "";
  // Chapter images live ONLY on s1/s2 — m440.in serves covers only.
  if (filename.endsWith(".webp") || filename.endsWith(".avif")) {
    return [s2, s1];
  }
  return [s1, s2];
}

/** @deprecated Use m440ChapterImageDownloadCandidates — kept for callers that need s2 first only. */
export function m440ChapterImageDownloadUrl(canonicalUrl: string): string {
  return m440ChapterImageDownloadCandidates(canonicalUrl)[0]!;
}

function sniffImageContentType(body: Uint8Array): string | null {
  if (body.length < 4) return null;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return "image/png";
  if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) return "image/gif";
  if (
    body.length >= 12
    && body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46
  ) {
    const brand = String.fromCharCode(body[8]!, body[9]!, body[10]!, body[11]!);
    if (brand === "WEBP") return "image/webp";
  }
  return null;
}

function resolveImageContentType(rawHeader: string, body: Uint8Array): string | null {
  const fromHeader = rawHeader.split(";")[0]!.trim().toLowerCase();
  if (ALLOWED_CONTENT_TYPES.has(fromHeader)) return fromHeader;
  if (fromHeader === "application/octet-stream" || fromHeader === "" || fromHeader === "binary/octet-stream") {
    return sniffImageContentType(body);
  }
  return null;
}

async function downloadM440ImageWithCdnFallback(
  downloadUrls: string[],
  config: EnvConfig,
  log: Logger,
  proxy?: ProxyConfig,
): Promise<{ response: Response; downloadUrl: string } | null> {
  let lastResponse: Response | null = null;
  let lastUrl = downloadUrls[0] ?? "";

  for (const url of downloadUrls) {
    lastUrl = url;
    const response = await downloadM440Image(url, config, log, proxy);
    lastResponse = response;
    if (response.ok) {
      return { response, downloadUrl: url };
    }
    // 404/403 — image is gone from this mirror, skip rest
    if (response.status === 404 || response.status === 403) {
      log.debug(`[m440] CDN miss url=${url} status=${response.status}, trying next mirror`);
      continue;
    }
    // 502/503/etc — transient error, try next mirror
    log.debug(`[m440] CDN error url=${url} status=${response.status}, trying next mirror`);
  }

  if (lastResponse) {
    return { response: lastResponse, downloadUrl: lastUrl };
  }
  return null;
}

export type UploadCoverInput = Omit<UploadChapterPagesInput, "pages" | "chapterSlug"> & {
  /** Canonical cover URL (typically https://m440.in/uploads/manga/.../cover/...). */
  coverUrl: string;
};

/**
 * Upload a manga cover to mango-image. Uses the same gate, validation, logging,
 * and retry-queue behavior as chapter page uploads.
 *
 * Covers are served from m440.in directly — unlike chapter pages, they must NOT
 * be rewritten to s2.m440.in for download.
 */
export async function uploadCoverToMangoImage(
  input: UploadCoverInput,
): Promise<UploadChapterPagesResult> {
  const { coverUrl, ...rest } = input;
  if (!coverUrl) {
    return { uploaded: 0, failed: 0, skipped: 0, skippedReason: "no-pages" };
  }

  const canonicalCoverUrl = m440CoverCanonicalUrl(coverUrl);

  return uploadChapterPagesToMangoImage({
    ...rest,
    pages: [canonicalCoverUrl],
    chapterSlug: "cover",
  });
}

/**
 * Upload a chapter's page images to mango-image.
 *
 * Gate — skipped entirely (zero helper calls, zero per-image logs) when:
 *   - MANGO_IMAGE_URL or MANGO_IMAGE_API_KEY is not set in config
 *   - scraperMode is not 'm440_only' / 'all'
 *   - scraperName is not 'm440' / 'peerless'
 *
 * Per image:
 *   1. Build the canonical key by swapping the image-CDN host for the
 *      identity origin (s1.m440.in → m440.in) so cover and chapter images
 *      share the same key namespace.
 *   2. Download the bytes from the source URL with Referer/Origin headers
 *      (satisfies the antibot check) and a 15s timeout.
 *   3. Validate response.ok, content-type (jpg/png/webp/gif/avif), and
 *      content-length ≤ 25 MiB client-side. On any failure: log warn, count
 *      as skipped, delay, continue.
 *   4. POST to mango-image via the foundation helper. The helper never
 *      throws on HTTP errors — check result.ok and log a single concise
 *      line. delay after every image.
 *   5. try/catch wraps the whole per-image work — any unexpected throw
 *      (fetch abort, body read) is logged at warn and the chapter moves on.
 *
 * Summary — one info line at the end with per-chapter counts.
 *
 * The behavior here is identical to the rule #1 method that shipped in
 * commit 6765f75. The refactor of the adapter to delegate here MUST be
 * bit-equivalent (same logs, same gate, same summary).
 */
export async function uploadChapterPagesToMangoImage(
  input: UploadChapterPagesInput,
): Promise<UploadChapterPagesResult> {
  const { pages, mangaSlug, chapterSlug, scraperName, config, log } = input;
  const scraperMode: ScraperMode = input.scraperMode ?? getScraperMode(config);
  const retryQueue = input.retryQueue;
  const proxy = input.proxy;

  // --- Gate ---------------------------------------------------------------
  // Only one debug log on gate-skip. The wrong-mode / wrong-scraper / empty
  // cases return silently — those are structural (caller wired it wrong),
  // not user-facing configuration, and the rule #1 method was silent too.
  const imageUrl = config.get(MANGO_IMAGE_URL_ENV);
  const apiKey = config.get(MANGO_IMAGE_API_KEY_ENV);
  if (!imageUrl || !apiKey) {
    log.debug(
      `mango-image upload disabled (${MANGO_IMAGE_URL_ENV} or ${MANGO_IMAGE_API_KEY_ENV} not set)`,
    );
    return {
      uploaded: 0,
      failed: 0,
      skipped: pages.length,
      skippedReason: "gate",
    };
  }
  if (scraperMode !== "m440_only" && scraperMode !== "all") {
    return {
      uploaded: 0,
      failed: 0,
      skipped: pages.length,
      skippedReason: "wrong-mode",
    };
  }
  if (scraperName !== "m440" && scraperName !== "peerless") {
    // Wrong scraper — same as rule #1, silent return with no per-image work.
    return { uploaded: 0, failed: 0, skipped: pages.length };
  }
  if (pages.length === 0) {
    return { uploaded: 0, failed: 0, skipped: 0, skippedReason: "no-pages" };
  }

  // Filter out undefined/null pages (legacy retry queue items)
  const validPages = pages.filter((p): p is string => Boolean(p));
  if (validPages.length === 0) {
    return { uploaded: 0, failed: 0, skipped: 0, skippedReason: "no-pages" };
  }

  // --- Per-image loop -----------------------------------------------------
  const perImageDelayMs = getMangoImageDelayMs(config);
  const concurrency = config.getNumber("MANGO_IMAGE_CONCURRENCY", 10);

  let uploaded = 0;
  let failed = 0;
  let skipped = 0;

  const isCover = chapterSlug === "cover";

  // Process images in parallel batches
  async function processPage(pageUrl: string): Promise<{ uploaded: boolean; failed: boolean; skipped: boolean }> {
    // Canonical key: swap chapter CDN hosts for the identity origin so
    // cover and chapter images share the same key namespace
    // (mango-image strips https:// internally; this is the pre-strip form).
    const canonicalKey = m440ChapterCanonicalUrl(pageUrl);

    // Chapter pages: try s1 → s2. Covers stay on m440.in only.
    const downloadUrls = isCover
      ? [m440CoverCanonicalUrl(pageUrl)]
      : m440ChapterImageDownloadCandidates(canonicalKey);

    try {
      const fetched = await downloadM440ImageWithCdnFallback(downloadUrls, config, log, proxy);
      if (!fetched) {
        return { uploaded: false, failed: false, skipped: true };
      }
      const { response, downloadUrl } = fetched;

      if (!response.ok) {
        const errMsg = `HTTP ${response.status}`;
        log.warn(`[m440] download SKIP url=${downloadUrl} status=${response.status}`);
        retryQueue?.enqueue({ canonicalKey, pageUrl: downloadUrl, mangaSlug, chapterSlug, error: errMsg });
        return { uploaded: false, failed: false, skipped: true };
      }

      const rawContentType = response.headers.get("content-type") || "";
      const body = new Uint8Array(await response.arrayBuffer());
      const contentType = resolveImageContentType(rawContentType, body);
      if (!contentType) {
        const errMsg = `invalid content-type: ${rawContentType.split(";")[0]?.trim() || "missing"}`;
        log.warn(`[m440] download SKIP url=${downloadUrl} content-type=${rawContentType.split(";")[0]?.trim() || "missing"}`);
        retryQueue?.enqueue({ canonicalKey, pageUrl: downloadUrl, mangaSlug, chapterSlug, contentType: rawContentType, error: errMsg });
        return { uploaded: false, failed: false, skipped: true };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const size = Number(contentLength);
        if (Number.isFinite(size) && size > MAX_BYTES) {
          const errMsg = `too large: ${size} > ${MAX_BYTES}`;
          log.warn(`[m440] download SKIP url=${downloadUrl} content-length=${size} > ${MAX_BYTES}`);
          retryQueue?.enqueue({ canonicalKey, pageUrl: downloadUrl, mangaSlug, chapterSlug, contentType, error: errMsg });
          return { uploaded: false, failed: false, skipped: true };
        }
      }

      if (body.byteLength > MAX_BYTES) {
        const errMsg = `too large: ${body.byteLength} > ${MAX_BYTES}`;
        log.warn(`[m440] download SKIP url=${downloadUrl} body-bytes=${body.byteLength} > ${MAX_BYTES}`);
        retryQueue?.enqueue({ canonicalKey, pageUrl: downloadUrl, mangaSlug, chapterSlug, contentType, error: errMsg });
        return { uploaded: false, failed: false, skipped: true };
      }

      // The helper never throws on HTTP errors — check result.ok.
      const result = await uploadImageToMangoImage(config, {
        canonicalKey,
        body,
        contentType,
        replace: true,
      });

      if (result.ok) {
        log.log(`[m440] uploaded key=${canonicalKey} status=${result.status}${downloadUrl !== downloadUrls[0] ? ` via=${new URL(downloadUrl).hostname}` : ""}`);
        retryQueue?.resolve(canonicalKey);
        return { uploaded: true, failed: false, skipped: false };
      } else {
        const errMsg = `upload HTTP ${result.status}: ${result.error ?? "n/a"}`;
        log.warn(`[m440] upload FAILED key=${canonicalKey} status=${result.status} err=${result.error ?? "n/a"}`);
        retryQueue?.enqueue({ canonicalKey, pageUrl: downloadUrl, mangaSlug, chapterSlug, contentType, error: errMsg });
        return { uploaded: false, failed: true, skipped: false };
      }
    } catch (e) {
      // Soft-fail: anything unexpected (fetch abort, body read, etc) is
      // logged at warn and the chapter moves on to the next image.
      const errMsg = (e as Error).message;
      const fallbackUrl = downloadUrls[0] ?? pageUrl;
      log.warn(`[m440] upload EXCEPTION key=${canonicalKey} err=${errMsg}`);
      retryQueue?.enqueue({ canonicalKey, pageUrl: fallbackUrl, mangaSlug, chapterSlug, error: errMsg });
      return { uploaded: false, failed: true, skipped: false };
    }
  }

  // Process pages in parallel batches
  for (let i = 0; i < validPages.length; i += concurrency) {
    const batch = validPages.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(processPage));
    
    for (const r of results) {
      if (r.uploaded) uploaded++;
      else if (r.failed) failed++;
      else if (r.skipped) skipped++;
    }

    // Optional delay between batches (default 0)
    if (perImageDelayMs > 0 && i + concurrency < pages.length) {
      await sleep(perImageDelayMs);
    }
  }

  // --- Summary ------------------------------------------------------------
  log.log(
    `[m440] mango-image upload summary manga=${mangaSlug} chapter=${chapterSlug} uploaded=${uploaded} failed=${failed} skipped=${skipped}`,
  );

  return { uploaded, failed, skipped };
}
