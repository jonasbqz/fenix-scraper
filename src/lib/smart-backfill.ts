// Smart backfill: prioritize peerless/m440 mangas by peerless chapter views,
// diff against mango-image catalog, enqueue missing images in Redis, process in batches.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { desc, eq, and, sql } from "drizzle-orm";
import * as schema from "@/database/schema";
import { chapters, comics, comicScans, scanGroups } from "@/database/schema";
import type { EnvConfig } from "@/lib/config";
import type { Logger } from "@/lib/logger";
import type { RetryQueue } from "@/lib/retry-queue";
import type { ScraperName } from "@/lib/scraper-mode";
import {
  createMangoUploadQueue,
  newRunId,
  type MangoUploadJob,
  type MangoUploadQueue,
} from "@/lib/mango-image-redis-queue";
import {
  m440ChapterImageDownloadUrl,
  uploadChapterPagesToMangoImage,
  uploadCoverToMangoImage,
} from "@/lib/mango-image-upload";
import {
  planMissingImagesForManga,
  type MangaImageTarget,
} from "@/lib/mango-image-sync";
import {
  BACKFILL_ELIGIBLE_SCANS,
  SCAN_NAME_TO_GROUP_SLUG,
  type BackfillSummary,
} from "@/lib/backfill";
import { type ProxyConfig } from "@/lib/proxy-fetch";

export const MANGO_SMART_BACKFILL_MANGA_LIMIT_ENV = "MANGO_SMART_BACKFILL_MANGA_LIMIT";
export const MANGO_SMART_BACKFILL_BATCH_SIZE_ENV = "MANGO_SMART_BACKFILL_BATCH_SIZE";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadUrlForJob(job: MangoUploadJob): string {
  if (job.kind === "cover") {
    return job.pageUrl;
  }
  return m440ChapterImageDownloadUrl(job.canonicalKey);
}

function groupJobsByChapter(jobs: MangoUploadJob[]): MangoUploadJob[][] {
  const map = new Map<string, MangoUploadJob[]>();
  for (const job of jobs) {
    const key = `${job.mangaSlug}\0${job.chapterSlug}`;
    const list = map.get(key) ?? [];
    list.push(job);
    map.set(key, list);
  }
  return [...map.values()];
}

async function uploadJobGroup(
  jobs: MangoUploadJob[],
  scan: ScraperName,
  config: EnvConfig,
  log: Logger,
  retryQueue: RetryQueue | undefined,
  proxy?: ProxyConfig,
): Promise<{ uploaded: number; failed: number; skipped: number; gated?: boolean }> {
  const first = jobs[0]!;
  if (first.kind === "cover") {
    const result = await uploadCoverToMangoImage({
      coverUrl: first.pageUrl,
      mangaSlug: first.mangaSlug,
      scraperName: scan,
      config,
      log,
      retryQueue,
      proxy,
    });
    return {
      uploaded: result.uploaded,
      failed: result.failed,
      skipped: result.skipped,
      gated: result.skippedReason === "gate" || result.skippedReason === "wrong-mode",
    };
  }

  const pages = jobs.map(downloadUrlForJob);
  const result = await uploadChapterPagesToMangoImage({
    pages,
    mangaSlug: first.mangaSlug,
    chapterSlug: first.chapterSlug,
    scraperName: scan,
    config,
    log,
    retryQueue,
    proxy,
  });
  return {
    uploaded: result.uploaded,
    failed: result.failed,
    skipped: result.skipped,
    gated: result.skippedReason === "gate" || result.skippedReason === "wrong-mode",
  };
}

async function processBatchGrouped(
  batch: MangoUploadJob[],
  scan: ScraperName,
  config: EnvConfig,
  log: Logger,
  retryQueue: RetryQueue | undefined,
  proxy?: ProxyConfig,
): Promise<{ uploaded: number; failed: number; skipped: number; gated: boolean }> {
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;

  for (const group of groupJobsByChapter(batch)) {
    const result = await uploadJobGroup(group, scan, config, log, retryQueue, proxy);
    if (result.gated) {
      return { uploaded, failed, skipped, gated: true };
    }
    uploaded += result.uploaded;
    failed += result.failed;
    skipped += result.skipped;
  }

  return { uploaded, failed, skipped, gated: false };
}

async function drainQueueWhilePlanning(
  queue: MangoUploadQueue,
  runId: string,
  scan: ScraperName,
  config: EnvConfig,
  log: Logger,
  retryQueue: RetryQueue | undefined,
  batchSize: number,
  isPlanningDone: () => boolean,
  proxy?: ProxyConfig,
): Promise<{ uploaded: number; failed: number; skipped: number }> {
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;

  for (;;) {
    const batch = await queue.popBatch(batchSize);
    if (batch.length === 0) {
      if (isPlanningDone() && (await queue.pendingCount()) === 0) break;
      await sleep(150);
      continue;
    }

    const result = await processBatchGrouped(batch, scan, config, log, retryQueue, proxy);
    if (result.gated) {
      return { uploaded, failed, skipped };
    }

    uploaded += result.uploaded;
    failed += result.failed;
    skipped += result.skipped;

    if (result.uploaded > 0) await queue.incrProgress(runId, "uploaded", result.uploaded);
    if (result.failed > 0) await queue.incrProgress(runId, "failed", result.failed);
    if (result.skipped > 0) await queue.incrProgress(runId, "skipped", result.skipped);

    const progress = await queue.getProgress(runId);
    if (progress && (progress.uploaded + progress.failed + progress.skipped) % 25 < batchSize) {
      log.log(
        `[smart-upload] progress uploaded=${progress.uploaded} failed=${progress.failed} ` +
          `skipped=${progress.skipped} pending=${progress.pending}/${progress.total}`,
      );
    }
  }

  return { uploaded, failed, skipped };
}

/**
 * Parallel drain: N workers each pop batches and process with their
 * assigned proxy. Each worker is a sequential loop (pop → process → repeat),
 * but all N run concurrently. This distributes m440 image downloads across
 * N different IPs.
 */
async function drainQueueParallel(
  queue: MangoUploadQueue,
  runId: string,
  scan: ScraperName,
  config: EnvConfig,
  log: Logger,
  retryQueue: RetryQueue | undefined,
  batchSize: number,
  proxies: ProxyConfig[],
  isPlanningDone: () => boolean,
): Promise<{ uploaded: number; failed: number; skipped: number }> {
  const totals = { uploaded: 0, failed: 0, skipped: 0 };
  const mu = { lock: false }; // simple mutex for totals

  async function worker(workerId: number, proxy: ProxyConfig) {
    let uploaded = 0;
    let failed = 0;
    let skipped = 0;

    for (;;) {
      const batch = await queue.popBatch(batchSize);
      if (batch.length === 0) {
        if (isPlanningDone() && (await queue.pendingCount()) === 0) break;
        await sleep(150 + workerId * 30); // stagger workers
        continue;
      }

      const result = await processBatchGrouped(batch, scan, config, log, retryQueue, proxy);
      if (result.gated) return;

      uploaded += result.uploaded;
      failed += result.failed;
      skipped += result.skipped;

      if (result.uploaded > 0) await queue.incrProgress(runId, "uploaded", result.uploaded);
      if (result.failed > 0) await queue.incrProgress(runId, "failed", result.failed);
      if (result.skipped > 0) await queue.incrProgress(runId, "skipped", result.skipped);
    }

    // Merge into totals
    while (mu.lock) await sleep(1);
    mu.lock = true;
    totals.uploaded += uploaded;
    totals.failed += failed;
    totals.skipped += skipped;
    mu.lock = false;
  }

  const workers = proxies.map((proxy, i) => worker(i, proxy));
  await Promise.all(workers);

  return totals;
}

export interface SmartBackfillOptions {
  scan: string;
  config: EnvConfig;
  db: NodePgDatabase<typeof schema>;
  log: Logger;
  retryQueue?: RetryQueue;
  mangaLimit?: number;
  batchSize?: number;
  /** Proxy pool for parallel image downloads. When provided, N workers run concurrently. */
  proxies?: ProxyConfig[];
  /** Number of parallel workers (default: proxies.length). */
  concurrency?: number;
}

export interface SmartBackfillSummary extends BackfillSummary {
  runId: string;
  mangasPlanned: number;
  mangasComplete: number;
  queued: number;
  alreadyPresent: number;
}

interface MangaRow extends MangaImageTarget {
  title: string;
  views: number | null;
}

async function resolveScanGroupId(
  scan: string,
  db: NodePgDatabase<typeof schema>,
): Promise<number | null> {
  const groupSlug = SCAN_NAME_TO_GROUP_SLUG[scan];
  if (!groupSlug) return null;
  const sg = await db.query.scanGroups.findFirst({
    where: eq(scanGroups.slug, groupSlug),
  });
  return sg?.id ?? null;
}

async function fetchTopMangas(
  db: NodePgDatabase<typeof schema>,
  scanGroupId: number,
  limit: number,
): Promise<MangaRow[]> {
  const peerlessViews = sql<number>`coalesce(sum(${chapters.views}), 0)`.mapWith(Number);

  const query = db
    .select({
      comicId: comics.id,
      mangaSlug: comics.slug,
      title: comics.title,
      views: peerlessViews,
      coverImage: comics.coverImage,
    })
    .from(comics)
    .innerJoin(comicScans, eq(comicScans.comicId, comics.id))
    .leftJoin(chapters, eq(chapters.comicScanId, comicScans.id))
    .where(eq(comicScans.scanGroupId, scanGroupId))
    .groupBy(comics.id, comics.slug, comics.title, comics.coverImage)
    .orderBy(desc(peerlessViews), comics.slug) as any;

  // limit=0 means "all manga"
  if (limit > 0) {
    query.limit(limit);
  }

  return query as Promise<MangaRow[]>;
}

export async function runSmartBackfill(
  options: SmartBackfillOptions,
): Promise<SmartBackfillSummary> {
  const { scan, config, db, log, retryQueue } = options;
  const mangaLimit = options.mangaLimit ?? config.getNumber(MANGO_SMART_BACKFILL_MANGA_LIMIT_ENV, 25);
  const batchSize = options.batchSize ?? config.getNumber(MANGO_SMART_BACKFILL_BATCH_SIZE_ENV, 50);
  const proxies = options.proxies;
  const concurrency = options.concurrency ?? proxies?.length ?? 0;
  const runId = newRunId(scan);

  const isParallel = proxies && proxies.length > 0 && concurrency > 0;
  log.log(
    `[smart-upload] ${scan} starting runId=${runId} mangaLimit=${mangaLimit === 0 ? "all" : mangaLimit} batchSize=${batchSize}` +
      (isParallel ? ` proxy_workers=${concurrency}` : ""),
  );

  const empty: SmartBackfillSummary = {
    scan,
    runId,
    comics: 0,
    chapters: 0,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    mangasPlanned: 0,
    mangasComplete: 0,
    queued: 0,
    alreadyPresent: 0,
  };

  if (!(scan in SCAN_NAME_TO_GROUP_SLUG)) {
    return { ...empty, disabledReason: "unknown-scan" };
  }
  if (!BACKFILL_ELIGIBLE_SCANS.has(scan as ScraperName)) {
    return { ...empty, disabledReason: "gate" };
  }

  const scanGroupId = await resolveScanGroupId(scan, db);
  if (!scanGroupId) {
    return { ...empty, disabledReason: "no-scan-group" };
  }

  const mangas = await fetchTopMangas(db, scanGroupId, mangaLimit);
  if (mangas.length === 0) {
    log.log(`[smart-upload] no comics found for scan=${scan}`);
    return { ...empty, noChapters: true };
  }

  log.log(
    `[smart-upload] planning ${mangas.length} manga(s) by peerless chapter views ` +
      `(top: ${mangas[0]?.title} views=${mangas[0]?.views ?? 0}) — uploads start as each manga is planned`,
  );

  const queue = createMangoUploadQueue(config, runId);
  await queue.initRun(runId);

  let alreadyPresent = 0;
  let mangasComplete = 0;
  let totalQueued = 0;
  let planningDone = false;

  const uploadPromise = isParallel
    ? drainQueueParallel(
        queue,
        runId,
        scan as ScraperName,
        config,
        log,
        retryQueue,
        batchSize,
        proxies!,
        () => planningDone,
      )
    : drainQueueWhilePlanning(
        queue,
        runId,
        scan as ScraperName,
        config,
        log,
        retryQueue,
        batchSize,
        () => planningDone,
      );

  for (const manga of mangas) {
    const { jobs, alreadyPresent: present } = await planMissingImagesForManga(
      config,
      db,
      scanGroupId,
      manga,
      log,
      "[smart-upload]",
    );
    alreadyPresent += present;

    if (jobs.length === 0) {
      mangasComplete += 1;
      log.log(
        `[smart-upload] manga=${manga.mangaSlug} views=${manga.views ?? 0} complete (nothing missing)`,
      );
      continue;
    }

    const enqueued = await queue.enqueue(jobs);
    totalQueued += enqueued;
    await queue.setProgressTotals(runId, {
      total: totalQueued,
      mangasPlanned: mangas.length,
    });

    log.log(
      `[smart-upload] manga=${manga.mangaSlug} views=${manga.views ?? 0} ` +
        `missing=${jobs.length} already=${present} queued_total=${totalQueued}`,
    );
  }

  planningDone = true;
  log.log(
    `[smart-upload] planning done queued=${totalQueued} alreadyPresent=${alreadyPresent} ` +
      `mangasComplete=${mangasComplete}/${mangas.length} — draining queue`,
  );

  if (totalQueued === 0) {
    await uploadPromise;
    await queue.close();
    return {
      ...empty,
      comics: mangas.length,
      mangasPlanned: mangas.length,
      mangasComplete: mangas.length,
      alreadyPresent,
    };
  }

  const { uploaded, failed, skipped } = await uploadPromise;

  await queue.incrProgress(runId, "mangasDone", mangasComplete);
  await queue.close();

  const summary: SmartBackfillSummary = {
    scan,
    runId,
    comics: mangas.length,
    chapters: totalQueued,
    uploaded,
    failed,
    skipped,
    mangasPlanned: mangas.length,
    mangasComplete: mangasComplete,
    queued: totalQueued,
    alreadyPresent,
  };

  log.log(
    `[smart-upload] ${scan} done runId=${runId} uploaded=${uploaded} failed=${failed} ` +
      `skipped=${skipped} queued=${totalQueued} alreadyPresent=${alreadyPresent}`,
  );

  return summary;
}
