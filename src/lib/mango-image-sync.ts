// Sync mango-image uploads from DB chapter urlPages (catalog-aware).
// Used by peerless scrape (per comic) and smart backfill (batch).

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "@/database/schema";
import { chapters, comicScans } from "@/database/schema";
import type { EnvConfig } from "@/lib/config";
import type { Logger } from "@/lib/logger";
import type { RetryQueue } from "@/lib/retry-queue";
import type { ScraperMode, ScraperName } from "@/lib/scraper-mode";
import {
  fetchCatalogChapterPages,
  fetchCatalogManga,
  catalogCoverKeys,
  catalogKeysSet,
} from "@/lib/mango-image-catalog";
import {
  m440CoverCanonicalUrl,
  uploadChapterPagesToMangoImage,
  uploadCoverToMangoImage,
} from "@/lib/mango-image-upload";
import type { MangoUploadJob } from "@/lib/mango-image-redis-queue";

export function toCanonicalKey(url: string): string {
  return url
    .replace("://s2.m440.in", "://m440.in")
    .replace("://s1.m440.in", "://m440.in");
}

/**
 * Check if a URL points to an external image (not on m440 CDN).
 * External images (blogspot, imgur, etc.) should NOT be uploaded to
 * mango-image — they can't be fetched reliably and the scraper should
 * re-scrape those chapters to get m440 CDN URLs.
 */
function isExternalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host !== "m440.in" && host !== "s1.m440.in" && host !== "s2.m440.in";
  } catch {
    return true;
  }
}

export interface MangaImageTarget {
  comicId: number;
  mangaSlug: string;
  coverImage?: string | null;
}

export interface SyncMangaImagesOptions {
  target: MangaImageTarget;
  scanGroupId: number;
  scraperName: ScraperName;
  scraperMode?: ScraperMode;
  config: EnvConfig;
  db: NodePgDatabase<typeof schema>;
  log: Logger;
  retryQueue?: RetryQueue;
  /** Log prefix, e.g. "[m440]" or "[smart-upload]" */
  logPrefix?: string;
  /** When set, only plan/upload these chapter slugs (+ cover if missing). Used on scrape. */
  onlyChapterSlugs?: string[];
}

export interface SyncMangaImagesResult {
  uploaded: number;
  failed: number;
  skipped: number;
  alreadyPresent: number;
  chaptersSynced: number;
  missingImages: number;
  skippedReason?: "gate" | "wrong-mode";
}

interface ChapterRow {
  chapterSlug: string;
  chapterNumber: number;
  urlPages: unknown;
}

async function fetchMangaChapters(
  db: NodePgDatabase<typeof schema>,
  scanGroupId: number,
  comicId: number,
): Promise<ChapterRow[]> {
  return db
    .select({
      chapterSlug: chapters.slug,
      chapterNumber: chapters.chapterNumber,
      urlPages: chapters.urlPages,
    })
    .from(chapters)
    .innerJoin(comicScans, eq(chapters.comicScanId, comicScans.id))
    .where(
      and(
        eq(comicScans.scanGroupId, scanGroupId),
        eq(comicScans.comicId, comicId),
      ),
    )
    .orderBy(chapters.chapterNumber) as Promise<ChapterRow[]>;
}

/** Plan missing images comparing DB urlPages vs mango-image catalog. */
export async function planMissingImagesForManga(
  config: EnvConfig,
  db: NodePgDatabase<typeof schema>,
  scanGroupId: number,
  target: MangaImageTarget,
  log: Logger,
  logPrefix = "[mango-sync]",
  onlyChapterSlugs?: string[],
): Promise<{ jobs: MangoUploadJob[]; alreadyPresent: number }> {
  const jobs: MangoUploadJob[] = [];
  let alreadyPresent = 0;

  const catalogRes = await fetchCatalogManga(config, target.mangaSlug);
  const coverKeys = catalogRes.ok ? catalogCoverKeys(catalogRes.data) : new Set<string>();

  if (target.coverImage) {
    const canonical = m440CoverCanonicalUrl(target.coverImage);
    if (coverKeys.has(canonical)) {
      alreadyPresent += 1;
    } else {
      jobs.push({
        canonicalKey: canonical,
        pageUrl: target.coverImage,
        mangaSlug: target.mangaSlug,
        chapterSlug: "cover",
        kind: "cover",
      });
    }
  }

  const chapterRows = await fetchMangaChapters(db, scanGroupId, target.comicId);
  const catalogChapters = catalogRes.ok
    ? new Map(catalogRes.data.chapters.map((c) => [c.chapter_slug, c.page_count]))
    : new Map<string, number>();
  const slugFilter = onlyChapterSlugs?.length
    ? new Set(onlyChapterSlugs)
    : null;

  for (const ch of chapterRows) {
    if (slugFilter && !slugFilter.has(ch.chapterSlug)) continue;
    const pages: string[] = Array.isArray(ch.urlPages) ? (ch.urlPages as string[]) : [];
    if (pages.length === 0) continue;

    const catalogCount = catalogChapters.get(ch.chapterSlug) ?? 0;

    if (catalogCount >= pages.length) {
      alreadyPresent += pages.length;
      continue;
    }

    // Fast path: nothing in catalog for this chapter — enqueue every page.
    if (catalogCount === 0) {
      for (const pageUrl of pages) {
        if (isExternalUrl(pageUrl)) continue;
        jobs.push({
          canonicalKey: toCanonicalKey(pageUrl),
          pageUrl,
          mangaSlug: target.mangaSlug,
          chapterSlug: ch.chapterSlug,
          kind: "chapter_page",
        });
      }
      continue;
    }

    // Compare canonical keys — page_count alone is not positional; partial or
    // out-of-order uploads must not hide missing prefix pages.
    let existingKeys = new Set<string>();
    const detail = await fetchCatalogChapterPages(config, target.mangaSlug, ch.chapterSlug);
    if (detail.ok) {
      existingKeys = catalogKeysSet(detail.data.pages);
    }

    for (const pageUrl of pages) {
      if (isExternalUrl(pageUrl)) continue;
      const canonical = toCanonicalKey(pageUrl);
      if (existingKeys.has(canonical)) {
        alreadyPresent += 1;
        continue;
      }
      jobs.push({
        canonicalKey: canonical,
        pageUrl,
        mangaSlug: target.mangaSlug,
        chapterSlug: ch.chapterSlug,
        kind: "chapter_page",
      });
    }
  }

  if (!catalogRes.ok) {
    log.warn(
      `${logPrefix} catalog miss manga=${target.mangaSlug} (${catalogRes.error}) — will upload from DB diff`,
    );
  }

  return { jobs, alreadyPresent };
}

/**
 * Upload all missing images for one manga from DB (existing + newly saved chapters).
 * Groups chapter pages per chapter for efficient upload.
 */
export async function syncMangaImagesFromDb(
  options: SyncMangaImagesOptions,
): Promise<SyncMangaImagesResult> {
  const {
    target,
    scanGroupId,
    scraperName,
    scraperMode,
    config,
    db,
    log,
    retryQueue,
    logPrefix = "[mango-sync]",
    onlyChapterSlugs,
  } = options;

  const empty: SyncMangaImagesResult = {
    uploaded: 0,
    failed: 0,
    skipped: 0,
    alreadyPresent: 0,
    chaptersSynced: 0,
    missingImages: 0,
  };

  const { jobs, alreadyPresent } = await planMissingImagesForManga(
    config,
    db,
    scanGroupId,
    target,
    log,
    logPrefix,
    onlyChapterSlugs,
  );

  if (jobs.length === 0) {
    log.log(
      `${logPrefix} manga=${target.mangaSlug} all images present (${alreadyPresent} in catalog)`,
    );
    return { ...empty, alreadyPresent };
  }

  log.log(
    `${logPrefix} manga=${target.mangaSlug} uploading ${jobs.length} missing image(s) ` +
      `(${alreadyPresent} already in catalog)`,
  );

  let uploaded = 0;
  let failed = 0;
  let skipped = 0;
  let chaptersSynced = 0;

  const coverJobs = jobs.filter((j) => j.kind === "cover");
  const chapterJobs = jobs.filter((j) => j.kind === "chapter_page");

  for (const job of coverJobs) {
    const result = await uploadCoverToMangoImage({
      coverUrl: job.pageUrl,
      mangaSlug: job.mangaSlug,
      scraperName,
      scraperMode,
      config,
      log,
      retryQueue,
    });
    if (result.skippedReason === "gate" || result.skippedReason === "wrong-mode") {
      return { ...empty, alreadyPresent, skippedReason: result.skippedReason };
    }
    uploaded += result.uploaded;
    failed += result.failed;
    skipped += result.skipped;
  }

  const byChapter = new Map<string, string[]>();
  for (const job of chapterJobs) {
    const list = byChapter.get(job.chapterSlug) ?? [];
    list.push(job.pageUrl);
    byChapter.set(job.chapterSlug, list);
  }

  for (const [chapterSlug, pages] of byChapter) {
    const result = await uploadChapterPagesToMangoImage({
      pages,
      mangaSlug: target.mangaSlug,
      chapterSlug,
      scraperName,
      scraperMode,
      config,
      log,
      retryQueue,
    });

    if (result.skippedReason === "gate" || result.skippedReason === "wrong-mode") {
      return {
        uploaded,
        failed,
        skipped,
        alreadyPresent,
        chaptersSynced,
        missingImages: jobs.length,
        skippedReason: result.skippedReason,
      };
    }

    uploaded += result.uploaded;
    failed += result.failed;
    skipped += result.skipped;
    chaptersSynced += 1;
  }

  log.log(
    `${logPrefix} manga=${target.mangaSlug} sync done uploaded=${uploaded} failed=${failed} ` +
      `skipped=${skipped} chapters=${chaptersSynced} already=${alreadyPresent}`,
  );

  return {
    uploaded,
    failed,
    skipped,
    alreadyPresent,
    chaptersSynced,
    missingImages: jobs.length,
  };
}
