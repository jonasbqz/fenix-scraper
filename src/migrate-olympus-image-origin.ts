/**
 * One-off migration: rewrite every image URL whose origin is the old Olympus
 * dashboard storage host so it points at the dedicated image CDN.
 *
 *   dashboard.olympusxyz.com/storage/<path>      -> media.imagesolymp.xyz/<path>
 *   dashboard.olympusbiblioteca.com/storage/<path> -> media.imagesolymp.xyz/<path>
 *
 * The path after /storage/ is kept intact; only the host + /storage prefix
 * is replaced. Applies to:
 *   - chapters.urlPages       (JSONB array of page image URLs)
 *   - comics.coverImage       (single cover URL)
 *   - comicScans.externalUrl (the "go to read" link — rewritten only when
 *                              it points at the old storage path, which is
 *                              rare but happened in earlier scrapes)
 *
 * Why a SQL regex instead of touching each row in code: doing it in a
 * single UPDATE per table is O(N rows) DB round-trips, vs O(N rows)
 * Node round-trips if we read/write each row. The regex only matches
 * the literal host + /storage/ prefix, so the rest of the URL is
 * preserved verbatim.
 *
 * Run with:
 *   DRY_RUN=1 bun run src/migrate-olympus-image-origin.ts   # count only
 *   bun run src/migrate-olympus-image-origin.ts             # apply
 *
 * Idempotent: the regex only matches the old host, so re-running on
 * already-migrated data is a no-op.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

// Matches both legacy hosts. The /storage/ prefix is consumed by the
// replacement so the resulting URL is media.imagesolymp.xyz/<rest>.
const OLD_PATTERN = "https://dashboard.olympus(xyz|biblioteca).com/storage/";
const OLD_PATTERN_SQL = `%dashboard.olympus%`;
const REPLACEMENT = "https://media.imagesolymp.xyz/";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const dryRun = process.env.DRY_RUN === "1";

  console.log("=== Migrate olympus image origin ===\n");
  console.log(`From: ${OLD_PATTERN}`);
  console.log(`To:   ${REPLACEMENT}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  // Count before
  const before = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM chapters c
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.url_pages) AS u
                      WHERE u LIKE ${OLD_PATTERN_SQL})
      ) AS chapters_with_old,
      (SELECT COUNT(*)::int FROM comics
        WHERE cover_image LIKE ${OLD_PATTERN_SQL}
      ) AS covers_with_old,
      (SELECT COUNT(*)::int FROM comic_scans
        WHERE external_url LIKE ${OLD_PATTERN_SQL}
      ) AS external_urls_with_old
  `);
  const b = before.rows?.[0] as { chapters_with_old: number; covers_with_old: number; external_urls_with_old: number };
  console.log(`Before:`);
  console.log(`  chapters    with old host in url_pages:     ${b.chapters_with_old}`);
  console.log(`  comics      with old host in cover_image:    ${b.covers_with_old}`);
  console.log(`  comic_scans with old host in external_url:   ${b.external_urls_with_old}\n`);

  if (dryRun) {
    console.log("DRY RUN — no updates performed.");
    await pool.end();
    return;
  }

  // 1) Rewrite chapters.url_pages: every string element gets the host
  // swapped via regex, the rest of the URL is untouched.
  const chapterRes = await db.execute(sql`
    UPDATE chapters
    SET url_pages = (
      SELECT jsonb_agg(regexp_replace(elem::text, ${OLD_PATTERN}, ${REPLACEMENT}, 'g'))
      FROM jsonb_array_elements(url_pages) AS elem
    ),
    updated_at = NOW()
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(url_pages) AS u
      WHERE u LIKE ${OLD_PATTERN_SQL}
    )
  `);
  console.log(`chapters updated:       ${chapterRes.rowCount ?? "?"}`);

  // 2) Rewrite comics.cover_image: same regex swap on the single string.
  const coverRes = await db.execute(sql`
    UPDATE comics
    SET cover_image = regexp_replace(cover_image, ${OLD_PATTERN}, ${REPLACEMENT}, 'g'),
        updated_at = NOW()
    WHERE cover_image LIKE ${OLD_PATTERN_SQL}
  `);
  console.log(`comics updated:         ${coverRes.rowCount ?? "?"}`);

  // 3) Rewrite comic_scans.external_url: the "go to read" link.
  // Only rows pointing at the old storage path are rewritten; normal
  // external_url rows (olympusxyz.com/series/...) are untouched.
  const externalRes = await db.execute(sql`
    UPDATE comic_scans
    SET external_url = regexp_replace(external_url, ${OLD_PATTERN}, ${REPLACEMENT}, 'g')
    WHERE external_url LIKE ${OLD_PATTERN_SQL}
  `);
  console.log(`comic_scans updated:    ${externalRes.rowCount ?? "?"}\n`);

  // Count after to confirm 0 remain.
  const after = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM chapters c
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.url_pages) AS u
                      WHERE u LIKE ${OLD_PATTERN_SQL})
      ) AS chapters_with_old,
      (SELECT COUNT(*)::int FROM comics
        WHERE cover_image LIKE ${OLD_PATTERN_SQL}
      ) AS covers_with_old,
      (SELECT COUNT(*)::int FROM comic_scans
        WHERE external_url LIKE ${OLD_PATTERN_SQL}
      ) AS external_urls_with_old
  `);
  const a = after.rows?.[0] as { chapters_with_old: number; covers_with_old: number; external_urls_with_old: number };
  console.log(`After:`);
  console.log(`  chapters    with old host remaining: ${a.chapters_with_old}`);
  console.log(`  comics      with old host remaining: ${a.covers_with_old}`);
  console.log(`  comic_scans with old host remaining: ${a.external_urls_with_old}`);

  if (a.chapters_with_old === 0 && a.covers_with_old === 0 && a.external_urls_with_old === 0) {
    console.log("\n✅ All references migrated.");
  } else {
    console.log("\n⚠️  Some references remain — check manually.");
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("\n[migrate] crashed:", err);
  process.exit(1);
});
