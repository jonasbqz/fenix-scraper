#!/usr/bin/env bun
// Proxy-accelerated upload: `bun run upload-proxy <scan>`
//
// Same as `bun run upload` but downloads m440 images through rotating
// residential proxies, distributing load across N IPs for faster throughput.
//
// Usage:
//   bun run upload-proxy peerless
//   bun run upload-proxy peerless --concurrency 5
//   bun run upload-proxy m440 --reset-dead
//
// Env vars:
//   M440_PROXIES              — comma/newline-separated ip:port:user:pass
//   M440_PROXY_CONCURRENCY    — parallel workers (default: min(3, proxies.length))
//   M440_PROXY_READ_DELAY_MS  — delay between pages (default: 200ms)
//
// All other env vars (MANGO_IMAGE_URL, MANGO_IMAGE_API_KEY, etc.) are
// shared with `bun run upload`.

import { Logger } from "@/lib/logger";
import { runSmartBackfill, type SmartBackfillSummary } from "@/lib/smart-backfill";
import { createScraperRuntime } from "@/lib/runtime";
import { parseProxiesFromEnv, type ProxyConfig } from "@/lib/proxy-fetch";
import type { RetryQueue } from "@/lib/retry-queue";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const M440_PROXIES_ENV = "M440_PROXIES";
const M440_PROXY_CONCURRENCY_ENV = "M440_PROXY_CONCURRENCY";

/**
 * Load .env file manually into process.env.
 * Bun auto-loads .env for `bun run` scripts, but this is a safety fallback
 * in case auto-loading is disabled or .env is not picked up.
 */
function loadDotEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Only set if not already in env (env vars set externally take precedence)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function printUsage(): never {
  console.error(`
Usage:
  bun run upload-proxy <scan> [--concurrency N] [--reset-dead]

  scan: one of peerless, m440

  Reads M440_PROXIES from env (comma-separated ip:port:user:pass).
  Downloads m440 images through rotating proxies for faster upload.

Env vars:
  M440_PROXIES            — required, comma-separated ip:port:user:pass
  M440_PROXY_CONCURRENCY  — parallel workers (default: min(3, proxies.length))
  MANGO_IMAGE_URL         — required (same as bun run upload)
  MANGO_IMAGE_API_KEY     — required (same as bun run upload)

Examples:
  bun run upload-proxy peerless
  bun run upload-proxy peerless --concurrency 3
  bun run upload-proxy m440 --reset-dead
`);
  process.exit(1);
}

function parseArgs(argv: string[]): { scan: string; resetDead: boolean; concurrency: number | null } {
  const resetDead = argv.includes("--reset-dead");
  const concurrencyIdx = argv.indexOf("--concurrency");
  const concurrencyValueIdx = concurrencyIdx >= 0 ? concurrencyIdx + 1 : -1;
  const concurrency = concurrencyValueIdx >= 0 ? parseInt(argv[concurrencyValueIdx] ?? "", 10) : null;

  // Filter out flags (--*) and the value after --concurrency
  const positional = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (i === concurrencyValueIdx) return false;
    return true;
  });

  const scan = positional[0];
  if (!scan) printUsage();
  return { scan, resetDead, concurrency: Number.isFinite(concurrency) ? concurrency : null };
}

async function drainRetryQueue(retryQueue: RetryQueue, log: Logger): Promise<void> {
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
  let skipped = 0;

  for (const item of dueItems) {
    // Skip items with missing fields (legacy schema)
    if (!item.pageUrl || !item.mangaSlug || !item.chapterSlug) {
      log.debug(`[retry] skipping legacy item id=${item.id} canonicalKey=${item.canonicalKey}`);
      retryQueue.resolve(item.canonicalKey || `legacy:${item.id}`);
      skipped++;
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

  log.log(`[retry] done. retried=${retried} resolved=${resolved} still-failed=${stillFailed} skipped=${skipped}`);

  const after = retryQueue.summary();
  log.log(`[retry] queue after: ${after.pending} pending, ${after.dead} dead`);
}

async function run() {
  // Ensure .env is loaded (Bun auto-loads, but this is a safety fallback)
  loadDotEnv();

  const { scan, resetDead, concurrency } = parseArgs(process.argv.slice(2));
  const log = new Logger(`UploadProxy:${scan}`);

  // Validate scan name
  const VALID_SCANS = ["peerless", "m440"];
  if (!VALID_SCANS.includes(scan)) {
    log.error(`unknown scan "${scan}". Known scans: ${VALID_SCANS.join(", ")}`);
    process.exit(1);
  }

  // Parse proxies
  const proxiesRaw = process.env[M440_PROXIES_ENV];
  const proxies: ProxyConfig[] = parseProxiesFromEnv(proxiesRaw);

  if (proxies.length === 0) {
    log.error(
      `No proxies configured. Set ${M440_PROXIES_ENV} env var.\n` +
      `Format: ip:port:user:pass (comma-separated)\n` +
      `Example: ${M440_PROXIES_ENV}="31.59.20.176:6754:user:pass,31.56.127.193:7684:user:pass"`,
    );
    process.exit(1);
  }

  const workerCount = concurrency ?? Math.min(3, proxies.length);
  log.log(`[proxy] ${proxies.length} proxies loaded, using ${workerCount} workers`);

  const { config, db, retryQueue, close } = await createScraperRuntime();
  try {
    // Phase 0: optionally reset dead items
    if (resetDead) {
      const resetCount = retryQueue.resetDead();
      log.log(`[retry] reset ${resetCount} dead items to pending`);
    }

    // Phase 1: drain retry queue (sequential, no proxy — retry is rare)
    await drainRetryQueue(retryQueue, log);

    // Phase 2: smart backfill with proxy workers
    const summary: SmartBackfillSummary = await runSmartBackfill({
      scan,
      config,
      db,
      log,
      retryQueue,
      proxies,
      concurrency: workerCount,
    });

    log.log(
      `[smart-upload] summary runId=${summary.runId} queued=${summary.queued} ` +
        `uploaded=${summary.uploaded} alreadyPresent=${summary.alreadyPresent} ` +
        `mangas=${summary.mangasComplete}/${summary.mangasPlanned}` +
        (summary.failed > 0 ? ` failed=${summary.failed}` : ""),
    );

    if (summary.disabledReason) {
      log.error(`Upload disabled: ${summary.disabledReason}`);
    }
  } finally {
    await close();
  }
}

run().catch((error) => {
  console.error("[upload-proxy] failed:", error);
  process.exit(1);
});
