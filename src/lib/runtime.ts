import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/database/schema';
import { EnvConfig } from '@/lib/config';
import { ScraperQueue } from '@/modules/scraper/scraper.queue';
import { ScraperService } from '@/modules/scraper/scraper.service';
import { RetryQueue } from '@/lib/retry-queue';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export async function createScraperRuntime(): Promise<{
  service: ScraperService;
  config: EnvConfig;
  db: NodePgDatabase<typeof schema>;
  retryQueue: RetryQueue;
  close: () => Promise<void>;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const config = new EnvConfig(process.env);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  });

  const db = drizzle(pool, { schema });
  const queue = new ScraperQueue();
  const retryQueue = new RetryQueue();
  const service = new ScraperService(db, config, queue, retryQueue);

  return {
    service,
    config,
    db,
    retryQueue,
    close: async () => {
      retryQueue.close();
      await pool.end();
    },
  };
}
