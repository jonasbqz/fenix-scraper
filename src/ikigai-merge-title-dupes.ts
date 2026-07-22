/**
 * One-off: merge Ikigai comics that share the same display title into one
 * canonical comic, reparenting comic_scans (+ chapters stay on those scans).
 *
 * Canonical comic = most chapters, then newest updated_at, then lowest id.
 *
 * Run:
 *   bun run src/ikigai-merge-title-dupes.ts             # dry run
 *   DRY_RUN=0 bun run src/ikigai-merge-title-dupes.ts   # live
 */

import { Pool, type PoolClient } from 'pg';

const DRY_RUN = process.env.DRY_RUN !== '0';

function isConnError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return (
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03' || // cannot_connect_now
    code === '08006' || // connection_failure
    code === '08003' || // connection_does_not_exist
    code === 'ECONNRESET'
  );
}

async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } catch (err) {
      lastErr = err;
      if (!isConnError(err) || attempt === 3) throw err;
      console.warn(`  connection dropped (${(err as Error).message}); retry ${attempt}/3…`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      client.release();
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
    keepAlive: true,
  });

  console.log('=== Ikigai — merge same-title comic duplicates ===\n');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const groups = await withClient(pool, (client) =>
    client.query<{
      title_key: string;
      comic_ids: number[];
      canonical_id: number;
    }>(
      `
      WITH ikigai_comics AS (
        SELECT DISTINCT c.id, c.title, c.updated_at
        FROM comics c
        JOIN comic_scans cs ON cs.comic_id = c.id
        WHERE cs.external_url ILIKE '%ikigaimangas.com/%'
      ),
      scored AS (
        SELECT
          ic.id,
          lower(trim(ic.title)) AS title_key,
          ic.updated_at,
          COALESCE(ch.cnt, 0)::int AS chapter_count
        FROM ikigai_comics ic
        LEFT JOIN (
          SELECT cs.comic_id, count(ch.id) AS cnt
          FROM comic_scans cs
          JOIN chapters ch ON ch.comic_scan_id = cs.id
          WHERE cs.external_url ILIKE '%ikigaimangas.com/%'
          GROUP BY cs.comic_id
        ) ch ON ch.comic_id = ic.id
      ),
      ranked AS (
        SELECT
          title_key,
          id,
          row_number() OVER (
            PARTITION BY title_key
            ORDER BY chapter_count DESC, updated_at DESC NULLS LAST, id ASC
          ) AS rn,
          array_agg(DISTINCT id) OVER (PARTITION BY title_key) AS comic_ids
        FROM scored
      )
      SELECT title_key, comic_ids, id AS canonical_id
      FROM ranked
      WHERE rn = 1
        AND cardinality(comic_ids) > 1
      ORDER BY title_key
      `,
    ),
  );

  console.log(`Duplicate title groups: ${groups.rows.length}\n`);
  if (groups.rows.length === 0) {
    await pool.end();
    return;
  }

  const allComicIds = [
    ...new Set(groups.rows.flatMap((g) => g.comic_ids)),
  ];

  // One round-trip for all scans — avoids long idle gaps that get admin-killed.
  const scansRes = await withClient(pool, (client) =>
    client.query<{ id: number; comic_id: number; scan_group_id: number }>(
      `SELECT id, comic_id, scan_group_id
       FROM comic_scans
       WHERE comic_id = ANY($1::int[])
       ORDER BY comic_id, id`,
      [allComicIds],
    ),
  );

  const scansByComic = new Map<number, { id: number; scan_group_id: number }[]>();
  for (const s of scansRes.rows) {
    const list = scansByComic.get(s.comic_id) ?? [];
    list.push({ id: s.id, scan_group_id: s.scan_group_id });
    scansByComic.set(s.comic_id, list);
  }

  let movedScans = 0;
  let deletedComics = 0;

  for (const row of groups.rows) {
    const dupes = row.comic_ids.filter((id) => id !== row.canonical_id);
    console.log(
      `"${row.title_key}" → keep #${row.canonical_id}, merge ${dupes.join(', ')}`,
    );

    if (DRY_RUN) {
      for (const dupeId of dupes) {
        const scans = scansByComic.get(dupeId) ?? [];
        for (const scan of scans) {
          const conflict = (scansByComic.get(row.canonical_id) ?? []).find(
            (s) => s.scan_group_id === scan.scan_group_id,
          );
          if (conflict) {
            console.log(
              `  would merge scan #${scan.id} into existing scan #${conflict.id}`,
            );
          } else {
            console.log(
              `  would reparent scan #${scan.id} → comic #${row.canonical_id}`,
            );
          }
          movedScans++;
        }
        deletedComics++;
      }
      continue;
    }

    // LIVE: one short transaction per title group (reconnectable).
    await withClient(pool, async (client) => {
      await client.query('BEGIN');
      try {
        for (const dupeId of dupes) {
          const scans = await client.query<{ id: number; scan_group_id: number }>(
            `SELECT id, scan_group_id FROM comic_scans WHERE comic_id = $1`,
            [dupeId],
          );

          for (const scan of scans.rows) {
            const conflict = await client.query<{ id: number }>(
              `SELECT id FROM comic_scans
               WHERE comic_id = $1 AND scan_group_id = $2`,
              [row.canonical_id, scan.scan_group_id],
            );

            if (conflict.rows[0]) {
              const targetScanId = conflict.rows[0].id;
              await client.query(
                `
                DELETE FROM chapters src
                USING chapters dst
                WHERE src.comic_scan_id = $1
                  AND dst.comic_scan_id = $2
                  AND src.chapter_number = dst.chapter_number
                `,
                [scan.id, targetScanId],
              );
              await client.query(
                `UPDATE chapters SET comic_scan_id = $2 WHERE comic_scan_id = $1`,
                [scan.id, targetScanId],
              );
              await client.query(`DELETE FROM comic_scans WHERE id = $1`, [
                scan.id,
              ]);
              console.log(
                `  scan #${scan.id} merged into existing scan #${targetScanId}`,
              );
            } else {
              await client.query(
                `UPDATE comic_scans SET comic_id = $2 WHERE id = $1`,
                [scan.id, row.canonical_id],
              );
              console.log(
                `  scan #${scan.id} reparented → comic #${row.canonical_id}`,
              );
            }
            movedScans++;
          }

          await client.query(`DELETE FROM comic_genres WHERE comic_id = $1`, [
            dupeId,
          ]);
          // Drop dependent rows that can block comic delete (best-effort).
          await client.query(
            `DELETE FROM bookmarks WHERE comic_id = $1`,
            [dupeId],
          ).catch(() => undefined);
          await client.query(
            `DELETE FROM reading_history WHERE comic_id = $1`,
            [dupeId],
          ).catch(() => undefined);
          await client.query(`DELETE FROM comics WHERE id = $1`, [dupeId]);
          deletedComics++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }

  console.log(
    `\nDone. scans touched=${movedScans}, comics ${DRY_RUN ? 'would delete' : 'deleted'}=${deletedComics}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
