// Redis-backed (or in-memory) queue for mango-image upload jobs with progress.

import Redis from "ioredis";
import type { EnvConfig } from "./config";

export const REDIS_URL_ENV = "REDIS_URL";
export const MANGO_UPLOAD_QUEUE_PREFIX_ENV = "MANGO_UPLOAD_QUEUE_PREFIX";

export interface MangoUploadJob {
  canonicalKey: string;
  pageUrl: string;
  mangaSlug: string;
  chapterSlug: string;
  kind: "cover" | "chapter_page";
}

export interface MangoUploadProgress {
  runId: string;
  total: number;
  pending: number;
  uploaded: number;
  failed: number;
  skipped: number;
  mangasPlanned: number;
  mangasDone: number;
}

export interface MangoUploadQueue {
  initRun(runId: string): Promise<void>;
  enqueue(jobs: MangoUploadJob[]): Promise<number>;
  popBatch(batchSize: number): Promise<MangoUploadJob[]>;
  requeue(jobs: MangoUploadJob[]): Promise<void>;
  pendingCount(): Promise<number>;
  getProgress(runId: string): Promise<MangoUploadProgress | null>;
  incrProgress(
    runId: string,
    field: "uploaded" | "failed" | "skipped" | "mangasDone",
    by?: number,
  ): Promise<void>;
  setProgressTotals(
    runId: string,
    totals: { total: number; mangasPlanned: number },
  ): Promise<void>;
  close(): Promise<void>;
}

function queueKeys(prefix: string, runId: string) {
  return {
    pending: `${prefix}:pending:${runId}`,
    progress: `${prefix}:progress:${runId}`,
  };
}

export class RedisMangoUploadQueue implements MangoUploadQueue {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly runId: string;

  constructor(redisUrl: string, prefix: string, runId: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    this.prefix = prefix;
    this.runId = runId;
  }

  private keys() {
    return queueKeys(this.prefix, this.runId);
  }

  async initRun(runId: string): Promise<void> {
    await this.redis.connect().catch(() => undefined);
    void runId;
    const { progress } = this.keys();
    await this.redis.hset(progress, {
      runId: this.runId,
      total: "0",
      uploaded: "0",
      failed: "0",
      skipped: "0",
      mangasPlanned: "0",
      mangasDone: "0",
    });
    await this.redis.expire(progress, 7 * 24 * 3600);
  }

  async enqueue(jobs: MangoUploadJob[]): Promise<number> {
    if (jobs.length === 0) return 0;
    const { pending } = this.keys();
    const payload = jobs.map((j) => JSON.stringify(j));
    await this.redis.rpush(pending, ...payload);
    await this.redis.expire(pending, 7 * 24 * 3600);
    return jobs.length;
  }

  async popBatch(batchSize: number): Promise<MangoUploadJob[]> {
    const { pending } = this.keys();
    const raw = await this.redis.lpop(pending, batchSize);
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((s) => JSON.parse(s) as MangoUploadJob);
  }

  async requeue(jobs: MangoUploadJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const { pending } = this.keys();
    const payload = jobs.map((j) => JSON.stringify(j));
    await this.redis.lpush(pending, ...payload);
  }

  async pendingCount(): Promise<number> {
    const { pending } = this.keys();
    return this.redis.llen(pending);
  }

  async getProgress(runId: string): Promise<MangoUploadProgress | null> {
    void runId;
    const { pending, progress } = this.keys();
    const h = await this.redis.hgetall(progress);
    if (!h.runId) return null;
    const pendingN = await this.redis.llen(pending);
    return {
      runId: h.runId,
      total: Number(h.total ?? 0),
      pending: pendingN,
      uploaded: Number(h.uploaded ?? 0),
      failed: Number(h.failed ?? 0),
      skipped: Number(h.skipped ?? 0),
      mangasPlanned: Number(h.mangasPlanned ?? 0),
      mangasDone: Number(h.mangasDone ?? 0),
    };
  }

  async incrProgress(
    runId: string,
    field: "uploaded" | "failed" | "skipped" | "mangasDone",
    by = 1,
  ): Promise<void> {
    void runId;
    const { progress } = this.keys();
    await this.redis.hincrby(progress, field, by);
  }

  async setProgressTotals(
    runId: string,
    totals: { total: number; mangasPlanned: number },
  ): Promise<void> {
    void runId;
    const { progress } = this.keys();
    await this.redis.hset(progress, {
      total: String(totals.total),
      mangasPlanned: String(totals.mangasPlanned),
    });
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

/** In-process queue when REDIS_URL is unset (local dev). */
export class MemoryMangoUploadQueue implements MangoUploadQueue {
  private pending: MangoUploadJob[] = [];
  private progress: MangoUploadProgress | null = null;

  constructor(private readonly runId: string) {}

  async initRun(runId: string): Promise<void> {
    this.progress = {
      runId,
      total: 0,
      pending: 0,
      uploaded: 0,
      failed: 0,
      skipped: 0,
      mangasPlanned: 0,
      mangasDone: 0,
    };
  }

  async enqueue(jobs: MangoUploadJob[]): Promise<number> {
    this.pending.push(...jobs);
    if (this.progress) this.progress.pending = this.pending.length;
    return jobs.length;
  }

  async popBatch(batchSize: number): Promise<MangoUploadJob[]> {
    const batch = this.pending.splice(0, batchSize);
    if (this.progress) this.progress.pending = this.pending.length;
    return batch;
  }

  async requeue(jobs: MangoUploadJob[]): Promise<void> {
    this.pending.unshift(...jobs);
    if (this.progress) this.progress.pending = this.pending.length;
  }

  async pendingCount(): Promise<number> {
    return this.pending.length;
  }

  async getProgress(runId: string): Promise<MangoUploadProgress | null> {
    if (!this.progress || this.progress.runId !== runId) return null;
    return { ...this.progress, pending: this.pending.length };
  }

  async incrProgress(
    runId: string,
    field: "uploaded" | "failed" | "skipped" | "mangasDone",
    by = 1,
  ): Promise<void> {
    if (!this.progress || this.progress.runId !== runId) return;
    this.progress[field] += by;
  }

  async setProgressTotals(
    runId: string,
    totals: { total: number; mangasPlanned: number },
  ): Promise<void> {
    if (!this.progress || this.progress.runId !== runId) return;
    this.progress.total = totals.total;
    this.progress.mangasPlanned = totals.mangasPlanned;
  }

  async close(): Promise<void> {
    // no-op
  }
}

export function createMangoUploadQueue(
  config: EnvConfig,
  runId: string,
): MangoUploadQueue {
  const redisUrl = config.get(REDIS_URL_ENV);
  const prefix = config.get(MANGO_UPLOAD_QUEUE_PREFIX_ENV) || "mango:upload";
  if (redisUrl) {
    return new RedisMangoUploadQueue(redisUrl, prefix, runId);
  }
  return new MemoryMangoUploadQueue(runId);
}

export function newRunId(scan: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${scan}-${ts}`;
}
