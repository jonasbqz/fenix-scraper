// Shared backfill function for rule #3 of the scraper → mango-image
// integration.
//
// Rule #3 = "when NOT actively scraping, upload the images of the scan's
// comics" (the user mentioned peerless specifically). The backfill iterates
// the EXISTING comics + chapters already in the DB (those the scraper has
// previously persisted) and pushes each chapter's page images to
// mango-image via the shared `uploadChapterPagesToMangoImage` helper.
//
// This function is the SINGLE source of truth for the backfill logic — it
// is called from:
//
//   1. CLI  — `bun run upload <scan>` parses argv, then calls runBackfill.
//   2. Worker — on `SCRAPER_BACKFILL_SCANS` × `SCRAPER_BACKFILL_INTERVAL_MIN`,
//      each scan in the list is scheduled via setInterval and calls
//      runBackfill on each tick.
//
// The backfill reuses the same shared per-image upload function as the
// rule #1 adapter, so the gate, per-image validation, log lines, and
// delay are identical. The backfill is IDEMPOTENT — mango-image replaces
// by default, so re-runs are safe.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/database/schema";
import { comics, chapters, comicScans, scanGroups } from "@/database/schema";
import { EnvConfig } from "@/lib/config";
import { Logger } from "@/lib/logger";
import {
  uploadChapterPagesToMangoImage,
  uploadCoverToMangoImage,
  type UploadChapterPagesResult,
} from "@/lib/mango-image-upload";
import type { ScraperName } from "@/lib/scraper-mode";
import type { RetryQueue } from "@/lib/retry-queue";

/**
 * Map from the user-facing scan name (what the CLI accepts / what the
 * worker stores in env) to the `scan_groups.slug` used in the DB. The
 * scraper adapters each create a `scan_groups` row with one of these slugs
 * (see ensureScanGroup() in each adapter).
 */
export const SCAN_NAME_TO_GROUP_SLUG: Record<string, string> = {
  m440: "peerless-scan",
  peerless: "peerless-scan",
  ikigai: "ikigai",
  olympus: "olympus",
  nobledicion: "nobledicion",
  taurus: "taurus",
};

/** Scans that the backfill can actually push to mango-image (gate allows upload). */
export const BACKFILL_ELIGIBLE_SCANS: ReadonlySet<ScraperName> = new Set([
  "m440",
  "peerless",
]);

export interface RunBackfillOptions {
  /** The scan to backfill (e.g. "m440", "peerless", "ikigai"). */
  scan: string;
  /** Env config (used by the shared upload function for the gate and the per-image delay). */
  config: EnvConfig;
  /** Drizzle DB instance. */
  db: NodePgDatabase<typeof schema>;
  /** Logger from the caller (CLI or worker). */
  log: Logger;
  /** Optional retry queue for failed images. */
  retryQueue?: RetryQueue;
}

export interface BackfillSummary {
  /** The scan name that was requested. */
  scan: string;
  /** Number of distinct comics touched (only counted when at least one chapter was processed). */
  comics: number;
  /** Number of chapters that were processed (gate open, non-empty pages). */
  chapters: number;
  /** Total pages uploaded across all chapters. */
  uploaded: number;
  /** Total pages that failed across all chapters. */
  failed: number;
  /** Total pages skipped across all chapters. */
  skipped: number;
  /** When the backfill bailed out before processing any chapter. */
  disabledReason?: "unknown-scan" | "gate" | "wrong-mode" | "no-scan-group";
  /** True if no chapters were found for the scan (not an error — just nothing to do). */
  noChapters?: boolean;
}

/** Resolve the user-facing scan name to a `scan_groups` row. */
async function resolveScanGroup(
  scan: string,
  db: NodePgDatabase<typeof schema>,
): Promise<{ id: number; slug: string } | null> {
  const groupSlug = SCAN_NAME_TO_GROUP_SLUG[scan];
  if (!groupSlug) return null;

  const sg = await db.query.scanGroups.findFirst({
    where: eq(scanGroups.slug, groupSlug),
  });
  if (!sg) return null;
  return { id: sg.id, slug: sg.slug };
}

/**
 * Run the rule #3 backfill for a single scan. Iterates the existing
 * comics + chapters in the DB and re-uploads each chapter's page images
 * to mango-image via the shared helper. Idempotent — safe to re-run.
 *
 * Returns a summary; never throws on per-chapter failures (soft-fail).
 * The caller (CLI or worker) decides how to handle the summary.
 */
export async function runBackfill(
  options: RunBackfillOptions,
): Promise<BackfillSummary> {
  const { scan, config, db, log, retryQueue } = options;

  log.log(`[upload] ${scan} backfill starting`);

  // 1. Resolve the scan name to a scan group. If unknown, bail early with
  //    a clear message — this is a user-input error, not a gate.
  if (!(scan in SCAN_NAME_TO_GROUP_SLUG)) {
    const known = Object.keys(SCAN_NAME_TO_GROUP_SLUG).join(", ");
    log.warn(`[upload] unknown scan "${scan}". Known scans: ${known}`);
    return { scan, comics: 0, chapters: 0, uploaded: 0, failed: 0, skipped: 0, disabledReason: "unknown-scan" };
  }

  // 2. Only scans whose scraperName passes the shared gate are eligible.
  //    The shared function will gate-skip other scans, but we short-circuit
  //    here with a clearer message — and we still need to know whether the
  //    gate is open at all (MANGO_IMAGE_URL etc).
  if (!BACKFILL_ELIGIBLE_SCANS.has(scan as ScraperName)) {
    log.log(
      `[upload] ${scan} backfill is a no-op (mango-image upload is only wired for m440/peerless; gate is m440/peerless-only).`,
    );
    return { scan, comics: 0, chapters: 0, uploaded: 0, failed: 0, skipped: 0, disabledReason: "gate" };
  }

  // 3. Find the scan group in the DB.
  const sg = await resolveScanGroup(scan, db);
  if (!sg) {
    log.warn(
      `[upload] no scan_groups row for "${scan}" (slug=${SCAN_NAME_TO_GROUP_SLUG[scan]}). ` +
        `The scraper for this scan has not been run yet, or the slug mapping is wrong. Nothing to backfill.`,
    );
    return { scan, comics: 0, chapters: 0, uploaded: 0, failed: 0, skipped: 0, disabledReason: "no-scan-group" };
  }

  // 4. Upload covers for all comics in this scan group.
  type ComicRow = {
    comicId: number;
    mangaSlug: string;
    coverImage: string | null;
  };

  const comicRows = (await db
    .select({
      comicId: comics.id,
      mangaSlug: comics.slug,
      coverImage: comics.coverImage,
    })
    .from(comics)
    .innerJoin(comicScans, eq(comicScans.comicId, comics.id))
    .where(eq(comicScans.scanGroupId, sg.id))
    .orderBy(comics.slug)) as ComicRow[];

  const distinctComics = new Set<number>();
  let chaptersProcessed = 0;
  let totalUploaded = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let gateSeen = false;
  let gateReason: "gate" | "wrong-mode" | undefined;
  const perChapterDelayMs = config.getNumber("MANGO_IMAGE_CHAPTER_DELAY_MS", 0);

  const comicsWithCover = comicRows.filter((row) => Boolean(row.coverImage));
  if (comicsWithCover.length > 0) {
    log.log(`[upload] ${scan} backfill: ${comicsWithCover.length} cover(s) to upload`);
  }

  for (const row of comicsWithCover) {
    const result = await uploadCoverToMangoImage({
      coverUrl: row.coverImage!,
      mangaSlug: row.mangaSlug,
      scraperName: scan as ScraperName,
      config,
      log,
      retryQueue,
    });

    if (result.skippedReason === "gate" || result.skippedReason === "wrong-mode") {
      gateSeen = true;
      gateReason = result.skippedReason;
      log.log(
        `[upload] mango-image upload disabled (${result.skippedReason === "gate" ? "missing MANGO_IMAGE_URL or MANGO_IMAGE_API_KEY" : "mode not m440_only|all"})`,
      );
      break;
    }

    distinctComics.add(row.comicId);
    totalUploaded += result.uploaded;
    totalFailed += result.failed;
    totalSkipped += result.skipped;

    log.log(
      `[upload] ${scan} comic=${row.mangaSlug} cover ` +
        `uploaded=${result.uploaded} failed=${result.failed} skipped=${result.skipped}`,
    );

    await new Promise((r) => setTimeout(r, perChapterDelayMs));
  }

  if (gateSeen) {
    const summary: BackfillSummary = {
      scan,
      comics: distinctComics.size,
      chapters: chaptersProcessed,
      uploaded: totalUploaded,
      failed: totalFailed,
      skipped: totalSkipped,
      disabledReason: gateReason,
    };
    log.log(
      `[upload] ${scan} done. comics=${summary.comics} chapters=${summary.chapters} ` +
        `uploaded=${summary.uploaded} failed=${summary.failed} skipped=${summary.skipped} (gated: ${gateReason})`,
    );
    return summary;
  }

  // 5. Query all chapters of all comics under this scan group, joined
  //    through comicScans. Same shape as the m440-rescrape-antibot pattern.
  //    Ordered by comic slug + chapter number for stable, greppable output.
  type Row = {
    chapterId: number;
    chapterSlug: string;
    chapterNumber: number;
    urlPages: unknown;
    comicId: number;
    mangaSlug: string;
  };

  const rows = (await db
    .select({
      chapterId: chapters.id,
      chapterSlug: chapters.slug,
      chapterNumber: chapters.chapterNumber,
      urlPages: chapters.urlPages,
      comicId: comics.id,
      mangaSlug: comics.slug,
    })
    .from(chapters)
    .innerJoin(comicScans, eq(chapters.comicScanId, comicScans.id))
    .innerJoin(comics, eq(comicScans.comicId, comics.id))
    .where(eq(comicScans.scanGroupId, sg.id))
    .orderBy(comics.slug, chapters.chapterNumber)) as Row[];

  if (rows.length === 0) {
    if (comicsWithCover.length === 0) {
      log.log(`[upload] ${scan} backfill: no covers or chapters found. Nothing to do.`);
      return { scan, comics: 0, chapters: 0, uploaded: 0, failed: 0, skipped: 0, noChapters: true };
    }

    const summary: BackfillSummary = {
      scan,
      comics: distinctComics.size,
      chapters: 0,
      uploaded: totalUploaded,
      failed: totalFailed,
      skipped: totalSkipped,
    };
    log.log(
      `[upload] ${scan} done. comics=${summary.comics} chapters=0 ` +
        `uploaded=${summary.uploaded} failed=${summary.failed} skipped=${summary.skipped}`,
    );
    return summary;
  }

  log.log(
    `[upload] ${scan} backfill: ${rows.length} chapter(s) across ${new Set(rows.map((r) => r.comicId)).size} comic(s)`,
  );

  // 6. Iterate and upload chapters. The shared helper handles the gate — if
  //    the env is not configured, the first chapter's call returns
  //    skippedReason="gate" and we bail with a friendly message.
  for (const row of rows) {
    // urlPages is jsonb typed as string[] in the Drizzle schema. Guard
    // against null/undefined/non-array defensively (Drizzle's $type is a
    // compile-time hint — at runtime, missing values can come through as
    // null on nullable columns).
    const pages: string[] = Array.isArray(row.urlPages) ? (row.urlPages as string[]) : [];

    if (pages.length === 0) {
      // Nothing to upload for this chapter — skip silently (don't even
      // log a per-chapter line; the per-image loop would also be a no-op).
      continue;
    }

    const result: UploadChapterPagesResult = await uploadChapterPagesToMangoImage({
      pages,
      mangaSlug: row.mangaSlug,
      chapterSlug: row.chapterSlug,
      scraperName: scan as ScraperName,
      config,
      log,
      retryQueue,
    });

    // Gate-skip detection: if the first non-empty chapter's call returns
    // a gate reason, the gate is closed for this run. Bail with a clear
    // message and don't iterate the rest.
    if (result.skippedReason === "gate" || result.skippedReason === "wrong-mode") {
      gateSeen = true;
      gateReason = result.skippedReason;
      log.log(
        `[upload] mango-image upload disabled (${result.skippedReason === "gate" ? "missing MANGO_IMAGE_URL or MANGO_IMAGE_API_KEY" : "mode not m440_only|all"})`,
      );
      break;
    }

    distinctComics.add(row.comicId);
    chaptersProcessed++;
    totalUploaded += result.uploaded;
    totalFailed += result.failed;
    totalSkipped += result.skipped;

    // Per-chapter progress line — concise and grep-able. Complements the
    // shared function's chapter summary (which uses the [m440] prefix).
    log.log(
      `[upload] ${scan} comic=${row.mangaSlug} chapter=${row.chapterSlug} ` +
        `uploaded=${result.uploaded} failed=${result.failed} skipped=${result.skipped}`,
    );

    // Small delay between chapters to be polite (the shared helper already
    // delays between images; this is in addition).
    await new Promise((r) => setTimeout(r, perChapterDelayMs));
  }

  const summary: BackfillSummary = {
    scan,
    comics: distinctComics.size,
    chapters: chaptersProcessed,
    uploaded: totalUploaded,
    failed: totalFailed,
    skipped: totalSkipped,
  };
  if (gateSeen) {
    summary.disabledReason = gateReason;
  }

  log.log(
    `[upload] ${scan} done. comics=${summary.comics} chapters=${summary.chapters} ` +
      `uploaded=${summary.uploaded} failed=${summary.failed} skipped=${summary.skipped}` +
      (gateSeen ? ` (gated: ${gateReason})` : ""),
  );

  return summary;
}
