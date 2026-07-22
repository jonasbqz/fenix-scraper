/**
 * Delete polluted genre rows (Ikigai list-card text scraped as genres).
 *
 * Dry-run by default. Apply with: DRY_RUN=0 bun run src/genres-cleanup-polluted.ts
 */
import { Pool } from 'pg';

const DRY_RUN = process.env.DRY_RUN !== '0';

const BAD_SQL = `
  SELECT id, name, slug
  FROM genres
  WHERE
    name ILIKE '%vistas%'
    OR name ~* 'comic[[:space:]]*[0-9]'
    OR name ~* 'novel[[:space:]]*[0-9]'
    OR name ~ ','
    OR length(name) > 40
    OR name ~ '^\\+[0-9]+$' AND name <> '+18'
  ORDER BY name
`;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ id: number; name: string; slug: string }>(
      BAD_SQL,
    );
    console.log(`[genres-cleanup] found ${rows.length} polluted genres (dryRun=${DRY_RUN})`);
    for (const row of rows.slice(0, 40)) {
      console.log(`  #${row.id} ${row.name}`);
    }
    if (rows.length > 40) console.log(`  … +${rows.length - 40} more`);

    if (DRY_RUN || rows.length === 0) {
      console.log('[genres-cleanup] dry-run only. Re-run with DRY_RUN=0 to delete.');
      return;
    }

    const ids = rows.map((r) => r.id);
    const delLinks = await pool.query(
      `DELETE FROM comic_genres WHERE genre_id = ANY($1::int[])`,
      [ids],
    );
    const delGenres = await pool.query(
      `DELETE FROM genres WHERE id = ANY($1::int[])`,
      [ids],
    );
    console.log(
      `[genres-cleanup] deleted comic_genres=${delLinks.rowCount} genres=${delGenres.rowCount}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
