/**
 * Local SQLite retry queue for failed mango-image uploads.
 *
 * When an image fails to download or upload, it is inserted into this queue.
 * On the next `bun run upload` cycle, pending items are retried before the
 * normal backfill runs. This ensures no chapter page is silently lost.
 *
 * Retry policy:
 *   - max_attempts: 3
 *   - backoff: 1 min → 10 min → 1 hour
 *   - after max_attempts exhausted: status='dead' (logged, not retried)
 *
 * The DB file lives at ./retry-queue.db (configurable via RETRY_QUEUE_DB).
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 600_000, 3_600_000]; // 1min, 10min, 1h

export interface RetryItem {
  id: number;
  canonicalKey: string;
  pageUrl: string;
  mangaSlug: string;
  chapterSlug: string;
  contentType: string | null;
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'dead';
  lastError: string | null;
  nextRetryAt: string;
  createdAt: string;
}

export interface RetrySummary {
  pending: number;
  dead: number;
  total: number;
}

export class RetryQueue {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath || process.env.RETRY_QUEUE_DB || join(process.cwd(), 'retry-queue.db');
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS retry_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_key TEXT NOT NULL,
        page_url TEXT NOT NULL,
        manga_slug TEXT NOT NULL,
        chapter_slug TEXT NOT NULL,
        content_type TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT ${MAX_ATTEMPTS},
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(canonical_key)
      );
      CREATE INDEX IF NOT EXISTS idx_retry_queue_status_next
        ON retry_queue(status, next_retry_at);
    `);
  }

  /**
   * Insert a failed image into the queue. If it already exists (same
   * canonical_key), bump the attempts and schedule the next retry.
   */
  enqueue(item: {
    canonicalKey: string;
    pageUrl: string;
    mangaSlug: string;
    chapterSlug: string;
    contentType?: string;
    error: string;
  }): void {
    const existing = this.db.query(
      'SELECT id, attempts FROM retry_queue WHERE canonical_key = ?'
    ).get(item.canonicalKey) as { id: number; attempts: number } | null;

    if (existing) {
      const newAttempts = existing.attempts + 1;
      const nextAt = newAttempts < MAX_ATTEMPTS
        ? new Date(Date.now() + BACKOFF_MS[newAttempts]!).toISOString()
        : new Date(Date.now() + BACKOFF_MS[MAX_ATTEMPTS - 1]!).toISOString();
      const status = newAttempts >= MAX_ATTEMPTS ? 'dead' : 'pending';

      this.db.query(
        `UPDATE retry_queue
         SET attempts = ?, last_error = ?, next_retry_at = ?, status = ?
         WHERE id = ?`
      ).run(newAttempts, item.error, nextAt, status, existing.id);
    } else {
      const nextAt = new Date(Date.now() + BACKOFF_MS[0]!).toISOString();
      this.db.query(
        `INSERT INTO retry_queue
           (canonical_key, page_url, manga_slug, chapter_slug, content_type, last_error, next_retry_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(item.canonicalKey, item.pageUrl, item.mangaSlug, item.chapterSlug, item.contentType || null, item.error, nextAt);
    }
  }

  /**
   * Fetch items ready for retry (pending + next_retry_at <= now).
   * Returns up to `limit` items ordered by next_retry_at.
   */
  due(limit = 50): RetryItem[] {
    const now = new Date().toISOString();
    return this.db.query(
      `SELECT * FROM retry_queue
       WHERE status = 'pending' AND next_retry_at <= ?
       ORDER BY next_retry_at ASC
       LIMIT ?`
    ).all(now, limit) as RetryItem[];
  }

  /**
   * Mark an item as resolved (successfully uploaded). Deletes it from the queue.
   */
  resolve(canonicalKey: string): void {
    this.db.query('DELETE FROM retry_queue WHERE canonical_key = ?').run(canonicalKey);
  }

  /**
   * Mark an item as dead (give up). Logged but not retried.
   */
  markDead(canonicalKey: string, error: string): void {
    this.db.query(
      `UPDATE retry_queue SET status = 'dead', last_error = ? WHERE canonical_key = ?`
    ).run(error, canonicalKey);
  }

  /**
   * Reset dead items back to pending (useful after VPN switch or config fix).
   */
  resetDead(): number {
    const now = new Date().toISOString();
    const result = this.db.query(
      `UPDATE retry_queue SET status = 'pending', attempts = 0, next_retry_at = ?
       WHERE status = 'dead'`
    ).run(now);
    return result.changes;
  }

  /**
   * Summary counts by status.
   */
  summary(): RetrySummary {
    const rows = this.db.query(
      `SELECT status, COUNT(*) as cnt FROM retry_queue GROUP BY status`
    ).all() as { status: string; cnt: number }[];

    let pending = 0, dead = 0, total = 0;
    for (const r of rows) {
      total += r.cnt;
      if (r.status === 'pending') pending = r.cnt;
      if (r.status === 'dead') dead = r.cnt;
    }
    return { pending, dead, total };
  }

  /**
   * Delete all resolved items older than `days` days (cleanup).
   * Since resolved items are deleted immediately, this is a no-op today.
   * Kept for future use if we change to soft-delete.
   */
  cleanup(_days = 30): number {
    return 0;
  }

  /**
   * Mark all poisoned items (null/undefined page_url or canonical_key) as dead.
   * These are legacy items from before the undefined-pageUrl fix.
   */
  purgePoisoned(): number {
    const result = this.db.query(
      `UPDATE retry_queue SET status = 'dead', last_error = 'poisoned: missing page_url or canonical_key'
       WHERE (page_url IS NULL OR page_url = '' OR page_url = 'undefined'
           OR canonical_key IS NULL OR canonical_key = '' OR canonical_key = 'undefined')
         AND status = 'pending'`
    ).run();
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
