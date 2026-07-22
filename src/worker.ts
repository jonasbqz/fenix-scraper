import { open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { Logger } from '@/lib/logger';
import { createScraperRuntime } from '@/lib/runtime';
import { getScraperMode, getScrapersForMode, type ScraperName, type ScraperMode } from '@/lib/scraper-mode';
import { runBackfill, BACKFILL_ELIGIBLE_SCANS } from '@/lib/backfill';
import { runSmartBackfill } from '@/lib/smart-backfill';

interface LastRunState {
  ok: boolean;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}

interface WorkerStatus {
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  mode: ScraperMode;
  enabledScrapers: ScraperName[];
  running: string[];
  lastRun: Record<string, LastRunState>;
}

const logger = new Logger('ScraperWorker');
const startedAt = new Date().toISOString();
const running = new Set<string>();
/**
 * Separate running set for the rule #3 backfill (mango-image backfill
 * scheduler). We do NOT reuse `running` because the scraper and the
 * backfill are different work and we want them to be able to coexist for
 * the same scan name (e.g. a scrape and a backfill of m440 can both run
 * concurrently — lock coordination is explicitly out of scope for v1,
 * per the rule #3 spec).
 */
const backfillRunning = new Set<string>();
const lastRun: Record<string, LastRunState> = {};
let workerStatus: WorkerStatus['status'] = 'starting';
let closeRuntime: (() => Promise<void>) | undefined;
let lockHandle: FileHandle | undefined;
let lockFilePath: string | undefined;

function intervalMs(minutes: number): number {
  return Math.max(1, minutes) * 60_000;
}

function getIntervalMinutes(name: ScraperName, getNumber: (key: string, fallback: number) => number): number {
  switch (name) {
    case 'ikigai':
      return getNumber('SCRAPER_IKIGAI_INTERVAL_MIN', 60);
    case 'olympus':
      return getNumber('SCRAPER_OLYMPUS_INTERVAL_MIN', 120);
    case 'nobledicion':
      return getNumber('SCRAPER_NOBLEDICION_INTERVAL_MIN', 120);
    case 'taurus':
      return getNumber('SCRAPER_TAURUS_INTERVAL_MIN', 120);
    case 'm440':
    case 'peerless':
      return getNumber('SCRAPER_M440_INTERVAL_MIN', 60);
  }
}

function defaultOptionsFor(name: ScraperName) {
  switch (name) {
    case 'nobledicion':
      return { startPage: 0, endPage: 0, postsPerPage: 6 };
    case 'taurus':
      return { startPage: 0, endPage: 0, postsPerPage: 6 };
    case 'olympus':
      return { startPage: 1, endPage: 1 };
    case 'ikigai':
      return { startPage: 1, endPage: 1 };
    case 'm440':
    case 'peerless':
      return { startPage: 1, endPage: 1 };
  }
}

async function acquireWorkerLock(lockFile: string) {
  try {
    const handle = await open(lockFile, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt }, null, 2));
    lockHandle = handle;
    lockFilePath = lockFile;
    return;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  let existingPid: number | undefined;
  try {
    const payload = JSON.parse(await readFile(lockFile, 'utf8'));
    existingPid = Number(payload.pid);
  } catch {
    // If the lock is unreadable, treat it as stale and recreate it.
  }

  if (existingPid && Number.isInteger(existingPid)) {
    try {
      process.kill(existingPid, 0);
      throw new Error(`Scraper worker already running with PID=${existingPid}. Refusing to start a duplicate worker.`);
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  await unlink(lockFile).catch(() => undefined);
  const handle = await open(lockFile, 'wx');
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt }, null, 2));
  lockHandle = handle;
  lockFilePath = lockFile;
}

async function releaseWorkerLock() {
  await lockHandle?.close().catch(() => undefined);
  if (lockFilePath) {
    await unlink(lockFilePath).catch(() => undefined);
  }
  lockHandle = undefined;
  lockFilePath = undefined;
}

async function writeStatus(statusFile: string, mode: ScraperMode, enabledScrapers: ScraperName[]) {
  const payload: WorkerStatus = {
    status: workerStatus,
    pid: process.pid,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    mode,
    enabledScrapers,
    running: [...running],
    lastRun,
  };

  await writeFile(statusFile, JSON.stringify(payload, null, 2));
}

async function run() {
  const runtime = await createScraperRuntime();
  closeRuntime = runtime.close;
  const { service, config, db } = runtime;
  const mode = getScraperMode(config);
  const enabledScrapers = getScrapersForMode(mode);
  const statusFile = config.get<string>('SCRAPER_STATUS_FILE') || './scraper-status.json';
  const lockFile = config.get<string>('SCRAPER_LOCK_FILE') || `${statusFile}.lock`;
  const heartbeatSeconds = config.getNumber('SCRAPER_HEARTBEAT_SECONDS', 30);
  const runOnStartup = config.getBoolean('SCRAPER_RUN_ON_STARTUP', true);

  await acquireWorkerLock(lockFile);

  workerStatus = 'running';
  logger.log(`Worker encendido. PID=${process.pid}, mode=${mode}, scrapers=${enabledScrapers.join(', ')}`);
  await writeStatus(statusFile, mode, enabledScrapers);

  async function runScraper(name: ScraperName) {
    if (running.has(name)) {
      logger.warn(`${name} already running; skipping overlapping schedule.`);
      return;
    }

    running.add(name);
    lastRun[name] = { ok: false, startedAt: new Date().toISOString() };
    await writeStatus(statusFile, mode, enabledScrapers);

    try {
      logger.log(`Scheduled run starting: ${name}`);
      const result = await service.triggerScraper(name, defaultOptionsFor(name));
      lastRun[name] = {
        ok: true,
        startedAt: lastRun[name].startedAt,
        finishedAt: new Date().toISOString(),
        result,
      };
      logger.log(`Scheduled run finished: ${name}`);
    } catch (error) {
      lastRun[name] = {
        ok: false,
        startedAt: lastRun[name].startedAt,
        finishedAt: new Date().toISOString(),
        error: String(error),
      };
      logger.error(`Scheduled run failed: ${name}: ${error}`);
    } finally {
      running.delete(name);
      await writeStatus(statusFile, mode, enabledScrapers);
    }
  }

  /**
   * Rule #3 backfill: scheduled upload of a scan's existing chapter images
   * to mango-image. Calls the SAME runBackfill() function the CLI uses, so
   * the per-chapter behavior is identical to `bun run upload <scan>`.
   *
   * Configuration:
   *   SCRAPER_BACKFILL_SCANS         — comma-separated list of scan names
   *                                     (e.g. "m440,peerless"). Empty =
   *                                     backfill disabled (no-op).
   *   SCRAPER_BACKFILL_INTERVAL_MIN  — minutes between backfill runs per
   *                                     scan. Default 30.
   *
   * Lock coordination with the scraper is OUT OF SCOPE for v1: the
   * backfill runs on its own schedule and the scraper on its own. They
   * may overlap (e.g. a backfill is running while a scrape starts). This
   * is acceptable because the backfill is idempotent (mango-image replaces
   * by default) and the scraper writes to the DB while the backfill reads
   * from the DB — worst case the backfill sees the chapters as they were
   * at query time.
   */
  async function runBackfillTick(scan: string) {
    if (backfillRunning.has(scan)) {
      logger.warn(`[backfill] ${scan} already running; skipping overlapping tick.`);
      return;
    }
    backfillRunning.add(scan);
    const tickLog = new Logger(`Backfill:${scan}`);
    const smartBackfill = config.getBoolean('SCRAPER_SMART_BACKFILL', true);
    try {
      tickLog.log(`[backfill] scheduled tick starting (smart=${smartBackfill})`);
      if (
        smartBackfill &&
        (scan === 'm440' || scan === 'peerless') &&
        BACKFILL_ELIGIBLE_SCANS.has(scan as ScraperName)
      ) {
        const { retryQueue } = runtime;
        const summary = await runSmartBackfill({
          scan,
          config,
          db,
          log: tickLog,
          retryQueue,
        });
        tickLog.log(
          `[backfill] smart tick finished runId=${summary.runId} uploaded=${summary.uploaded} ` +
            `queued=${summary.queued} already=${summary.alreadyPresent}`,
        );
      } else {
        await runBackfill({ scan, config, db, log: tickLog });
      }
      tickLog.log(`[backfill] scheduled tick finished`);
    } catch (error) {
      // The backfill must NOT throw out of the interval — a single failed
      // tick should not stop the next tick from firing.
      tickLog.error(`[backfill] scheduled tick failed: ${error}`);
    } finally {
      backfillRunning.delete(scan);
    }
  }

  for (const name of enabledScrapers) {
    const minutes = getIntervalMinutes(name, config.getNumber.bind(config));
    logger.log(`${name} scheduled every ${minutes} minutes.`);
    setInterval(() => void runScraper(name), intervalMs(minutes));

    if (runOnStartup) {
      void runScraper(name);
    }
  }

  // Rule #3 backfill scheduler. Reads SCRAPER_BACKFILL_SCANS — if empty,
  // the backfill is disabled and no intervals are created. Each scan in
  // the list gets its own setInterval. The shared runBackfill() function
  // is the single source of truth (also called by the CLI).
  const backfillScansRaw = config.get<string>('SCRAPER_BACKFILL_SCANS') || '';
  const backfillScans = backfillScansRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const backfillIntervalMin = config.getNumber('SCRAPER_BACKFILL_INTERVAL_MIN', 30);

  if (backfillScans.length === 0) {
    logger.log('Backfill disabled (SCRAPER_BACKFILL_SCANS is empty).');
  } else {
    for (const scan of backfillScans) {
      if (!BACKFILL_ELIGIBLE_SCANS.has(scan as ScraperName)) {
        logger.warn(
          `[backfill] skipping scan "${scan}" — only ${[...BACKFILL_ELIGIBLE_SCANS].join(', ')} are wired for the mango-image backfill.`,
        );
        continue;
      }
      logger.log(`[backfill] ${scan} scheduled every ${backfillIntervalMin} minutes.`);
      setInterval(() => void runBackfillTick(scan), intervalMs(backfillIntervalMin));

      if (runOnStartup) {
        void runBackfillTick(scan);
      }
    }
  }

  setInterval(() => {
    logger.log(`Heartbeat encendido. mode=${mode}, running=${[...running].join(', ') || 'none'}`);
    void writeStatus(statusFile, mode, enabledScrapers);
  }, Math.max(5, heartbeatSeconds) * 1000);
}

async function shutdown(signal: string) {
  workerStatus = 'stopping';
  logger.warn(`Received ${signal}. Stopping worker...`);

  try {
    await closeRuntime?.();
  } finally {
    await releaseWorkerLock();
    workerStatus = 'stopped';
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

run().catch((error) => {
  workerStatus = 'error';
  logger.error(`Worker failed to start: ${error}`);
  void releaseWorkerLock().finally(() => process.exit(1));
});
