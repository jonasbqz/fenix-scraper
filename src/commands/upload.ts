#!/usr/bin/env bun
// Rule #3 CLI: `bun run upload <scan>` — backfill chapter images of a scan's
// existing comics to mango-image.
//
// Two-phase approach:
//   Phase 1: drain the local retry queue (failed images from previous runs).
//   Phase 2: normal backfill of all chapters in the DB.
//
// Usage:
//   bun run upload peerless              # smart backfill (top 25 by views)
//   bun run upload peerless --all        # smart backfill ALL manga
//   bun run upload peerless --legacy     # old full scan of all chapters
//   bun run upload m440 --reset-dead     # reset dead retry items first
//
// The command respects the same gate as rule #1: if MANGO_IMAGE_URL /
// MANGO_IMAGE_API_KEY are not set, or SCRAPER_MODE is not m440_only|all,
// the backfill prints a clear "disabled" message and exits 0.

import { Logger } from "@/lib/logger";
import { runBackfill, SCAN_NAME_TO_GROUP_SLUG, type BackfillSummary } from "@/lib/backfill";
import { runSmartBackfill } from "@/lib/smart-backfill";
import { createScraperRuntime } from "@/lib/runtime";
import type { RetryQueue } from "@/lib/retry-queue";

function printUsage(): never {
  console.error(`
Usage:
  bun run upload <scan> [--all] [--legacy] [--reset-dead]

  scan: one of ${Object.keys(SCAN_NAME_TO_GROUP_SLUG).join(", ")}

  --all: process ALL manga (default: top 25 by chapter views)
  --legacy: old full scan of all chapters (slower, no catalog diff)
  --reset-dead: reset dead retry items to pending first

Examples:
  bun run upload peerless              # top 25 manga
  bun run upload peerless --all        # all peerless manga
  bun run upload m440 --legacy
  bun run upload peerless --reset-dead

The command reads MANGO_IMAGE_URL / MANGO_IMAGE_API_KEY and SCRAPER_MODE
from the environment (same as the scraper). It is a no-op against the
gate if mango-image is not configured or the mode does not allow m440.
`);
  process.exit(1);
}

function parseScanArg(argv: string[]): { scan: string; resetDead: boolean; legacy: boolean; all: boolean } {
  const resetDead = argv.includes("--reset-dead");
  const legacy = argv.includes("--legacy");
  const all = argv.includes("--all");
  const scan = argv.find((a) => !a.startsWith("--"));
  if (!scan) printUsage();
  return { scan, resetDead, legacy, all };
}

async function drainRetryQueue(retryQueue: RetryQueue, log: Logger): Promise<void> {
  // Purge poisoned items (missing pageUrl/canonicalKey) before retrying
  const purged = retryQueue.purgePoisoned();
  if (purged > 0) {
    log.log(`[retry] purged ${purged} poisoned items (missing pageUrl/canonicalKey)`);
  }

  const summary = retryQueue.summary();
  if (summary.total === 0) {
    log.log("[retry] queue is empty");
    return;
  }

  log.log(`[retry] queue: ${summary.pending} pending, ${summary.dead} dead`);

  if (summary.pending === 0) {
    log.log("[retry] nothing to retry (all dead or empty)");
    return;
  }

  const { config } = await import("@/lib/config").then(m => ({ config: new m.EnvConfig(process.env) }));
  const { uploadChapterPagesToMangoImage } = await import("@/lib/mango-image-upload");

  const dueItems = retryQueue.due(100);
  let retried = 0;
  let resolved = 0;
  let stillFailed = 0;

  for (const item of dueItems) {
    // Skip poisoned items (legacy bug: pageUrl/canonicalKey = undefined or string "undefined")
    if (!item.pageUrl || !item.canonicalKey || item.pageUrl === "undefined" || item.canonicalKey === "undefined") {
      retryQueue.markDead(item.canonicalKey ?? `id:${item.id}`, "poisoned: missing pageUrl or canonicalKey");
      log.log(`[retry] skipping poisoned item id=${item.id} key=${item.canonicalKey} url=${item.pageUrl}`);
      continue;
    }

    log.log(`[retry] retrying key=${item.canonicalKey} attempt=${item.attempts + 1}/${item.maxAttempts}`);

    const result = await uploadChapterPagesToMangoImage({
      pages: [item.pageUrl],
      mangaSlug: item.mangaSlug,
      chapterSlug: item.chapterSlug,
      scraperName: "peerless",
      config,
      log,
      retryQueue,
    });

    if (result.uploaded > 0) {
      resolved++;
    } else {
      stillFailed++;
    }
    retried++;
  }

  log.log(`[retry] done. retried=${retried} resolved=${resolved} still-failed=${stillFailed}`);

  const after = retryQueue.summary();
  log.log(`[retry] queue after: ${after.pending} pending, ${after.dead} dead`);
}

async function run() {
  const { scan, resetDead, legacy, all } = parseScanArg(process.argv.slice(2));
  const log = new Logger(`Upload:${scan}`);

  // Reject unknown scans upfront with a clearer message than the
  // backfill's own "unknown scan" log.
  if (!(scan in SCAN_NAME_TO_GROUP_SLUG)) {
    log.error(
      `unknown scan "${scan}". Known scans: ${Object.keys(SCAN_NAME_TO_GROUP_SLUG).join(", ")}`,
    );
    process.exit(1);
  }

  const { db, config, retryQueue, close } = await createScraperRuntime();
  try {
    // Phase 0: optionally reset dead items
    if (resetDead) {
      const resetCount = retryQueue.resetDead();
      log.log(`[retry] reset ${resetCount} dead items to pending`);
    }

    // Phase 1: drain retry queue
    await drainRetryQueue(retryQueue, log);

    // Phase 2: backfill (smart by default for m440/peerless)
    if (!legacy && (scan === "m440" || scan === "peerless")) {
      const summary = await runSmartBackfill({
        scan, config, db, log, retryQueue,
        mangaLimit: all ? 0 : undefined,  // 0 = all manga
      });
      log.log(
        `[smart-upload] summary runId=${summary.runId} queued=${summary.queued} ` +
          `uploaded=${summary.uploaded} alreadyPresent=${summary.alreadyPresent} ` +
          `mangas=${summary.mangasComplete}/${summary.mangasPlanned}`,
      );
    } else {
      const summary: BackfillSummary = await runBackfill({ scan, config, db, log, retryQueue });
      void summary;
    }
  } finally {
    await close();
  }
}

run().catch((error) => {
  console.error("[upload] failed:", error);
  process.exit(1);
});
