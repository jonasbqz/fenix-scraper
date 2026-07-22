/**
 * One-off DB cleanup: consolidate orphaned Ikigai comic_scans rows into their
 * real-team siblings, keeping the real team as source of truth.
 *
 * For each comic_scans row under the generic "ikigai" group that has a sibling
 * (same comicId, different scanGroupId):
 *   - DELETE orphan chapters with chapter_number <= sibling max (dupes)
 *   - REPARENT orphan chapters with chapter_number > sibling max
 *   - DELETE the orphan comic_scans row
 *
 * LIVE runs one orphan at a time (short commits + progress) so it won't hang
 * on a single multi-thousand-row DELETE against the whole chapters table.
 *
 * Run:
 *   bun run src/ikigai-merge-orphan-scans.ts             # dry run
 *   DRY_RUN=0 bun run src/ikigai-merge-orphan-scans.ts   # live
 */

import { Pool } from 'pg';

const DRY_RUN = process.env.DRY_RUN !== '0';

type PairRow = {
  orphan_id: number;
  comic_id: number;
  sibling_id: number;
  sibling_max_ch: number;
  to_delete: number;
  to_reparent: number;
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (set in .env or env vars)');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 20_000,
    keepAlive: true,
  });

  console.log('=== Ikigai — merge orphan comic_scans into real-team siblings ===\n');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will merge + delete)'}\n`);

  const ikigaiRes = await pool.query(`SELECT id FROM scan_groups WHERE slug = 'ikigai'`);
  if (ikigaiRes.rows.length === 0) {
    console.error('No scan_groups row with slug="ikigai" found. Nothing to do.');
    await pool.end();
    return;
  }
  const ikigaiGroupId = ikigaiRes.rows[0].id as number;
  console.log(`Ikigai fallback group: id=${ikigaiGroupId}\n`);

  // One sibling per orphan (the one with the most chapters).
  const pairsRes = await pool.query<PairRow>(
    `
    WITH sibling_max AS (
      SELECT comic_scan_id, max(chapter_number) AS max_ch, count(*)::int AS ch_count
      FROM chapters
      GROUP BY comic_scan_id
    ),
    ranked AS (
      SELECT
        o.id AS orphan_id,
        o.comic_id,
        s.id AS sibling_id,
        COALESCE(sm.max_ch, 0) AS sibling_max_ch,
        row_number() OVER (
          PARTITION BY o.id
          ORDER BY COALESCE(sm.ch_count, 0) DESC, s.id ASC
        ) AS rn
      FROM comic_scans o
      JOIN comic_scans s
        ON s.comic_id = o.comic_id
       AND s.scan_group_id <> $1
      LEFT JOIN sibling_max sm ON sm.comic_scan_id = s.id
      WHERE o.scan_group_id = $1
    )
    SELECT
      r.orphan_id,
      r.comic_id,
      r.sibling_id,
      r.sibling_max_ch,
      COALESCE(d.to_delete, 0)::int AS to_delete,
      COALESCE(d.to_reparent, 0)::int AS to_reparent
    FROM ranked r
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE c.chapter_number <= r.sibling_max_ch)::int AS to_delete,
        count(*) FILTER (WHERE c.chapter_number >  r.sibling_max_ch)::int AS to_reparent
      FROM chapters c
      WHERE c.comic_scan_id = r.orphan_id
    ) d ON true
    WHERE r.rn = 1
    ORDER BY r.orphan_id
    `,
    [ikigaiGroupId],
  );

  const keptRes = await pool.query(
    `SELECT count(*) AS cnt
     FROM comic_scans o
     WHERE o.scan_group_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM comic_scans s
         WHERE s.comic_id = o.comic_id AND s.scan_group_id <> $1
       )`,
    [ikigaiGroupId],
  );
  const keptCount = parseInt(keptRes.rows[0].cnt, 10);
  const pairs = pairsRes.rows;

  let totalDeleted = 0;
  let totalReparented = 0;
  for (const row of pairs) {
    totalDeleted += row.to_delete;
    totalReparented += row.to_reparent;
    console.log(
      `[orphan=${row.orphan_id}] sibling=${row.sibling_id} maxRealCh=${row.sibling_max_ch}: delete ${row.to_delete} dups, reparent ${row.to_reparent} new`,
    );
  }

  console.log(`\nOrphan comic_scans under ikigai: ${pairs.length + keptCount}`);
  console.log(`With sibling (will merge): ${pairs.length}`);
  console.log(`No sibling (will keep):    ${keptCount}`);
  console.log(`Pre-write totals: ${totalDeleted} chapters to delete, ${totalReparented} to reparent`);

  if (DRY_RUN) {
    console.log('\n=== Summary (DRY RUN — no writes) ===');
    console.log(`Orphans merged:      ${pairs.length}`);
    console.log(`Orphans kept:        ${keptCount}`);
    console.log(`Chapters deleted:    ${totalDeleted} (not actually deleted)`);
    console.log(`Chapters reparented: ${totalReparented} (not actually reparented)`);
    await pool.end();
    return;
  }

  if (pairs.length === 0) {
    console.log('\nNothing to merge. Done.');
    await pool.end();
    return;
  }

  console.log('\nExecuting merge one orphan at a time…');
  console.log('(Tip: pause mango-scraper / heavy writers if it says lock timeout)\n');

  let deletedCh = 0;
  let reparented = 0;
  let deletedCs = 0;

  for (let i = 0; i < pairs.length; i++) {
    const row = pairs[i];
    const n = i + 1;
    process.stdout.write(
      `[${n}/${pairs.length}] orphan=${row.orphan_id} → sibling=${row.sibling_id} … `,
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Fail fast instead of hanging forever behind scraper/API locks.
      await client.query(`SET LOCAL lock_timeout = '8s'`);
      await client.query(`SET LOCAL statement_timeout = '120s'`);

      // 1) Move truly-new chapters onto the real-team scan (usually 0).
      const rep = await client.query(
        `UPDATE chapters
         SET comic_scan_id = $2
         WHERE comic_scan_id = $1
           AND chapter_number > $3`,
        [row.orphan_id, row.sibling_id, row.sibling_max_ch],
      );

      // 2) Drop the orphan scan — FK ON DELETE CASCADE removes leftover
      //    duplicate chapters (and their likes/comments/history) in one shot.
      //    Much faster than DELETE FROM chapters … for 50–200 rows.
      const before = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM chapters WHERE comic_scan_id = $1`,
        [row.orphan_id],
      );
      const leftover = parseInt(before.rows[0]?.cnt || '0', 10);

      const cs = await client.query(`DELETE FROM comic_scans WHERE id = $1`, [
        row.orphan_id,
      ]);

      await client.query('COMMIT');

      reparented += rep.rowCount ?? 0;
      deletedCh += leftover;
      deletedCs += cs.rowCount ?? 0;
      console.log(
        `ok (rep=${rep.rowCount ?? 0}, cascaded_chapters=${leftover}, scan=${cs.rowCount ?? 0})`,
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string })?.code;
      console.log('FAILED');
      if (code === '55P03' || /lock timeout/i.test(String(err))) {
        console.error(
          '  → lock timeout: otra sesión tiene locked chapters/comic_scans.',
        );
        console.error(
          '  → pausa el scraper (y reintenta). Ver blockers: SELECT * FROM pg_stat_activity WHERE state != \'idle\';',
        );
      }
      console.error(err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`\n=== Summary (LIVE) ===`);
  console.log(`Chapters reparented: ${reparented}`);
  console.log(`Chapters deleted:    ${deletedCh}`);
  console.log(`comic_scans deleted: ${deletedCs}`);
  console.log(`comic_scans kept:    ${keptCount}`);

  await pool.end();
}

main().catch((err) => {
  console.error('\n[ikigai-merge] crashed:', err);
  process.exit(1);
});
