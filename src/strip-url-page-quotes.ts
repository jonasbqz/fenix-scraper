/**
 * One-off cleanup: strip leading/trailing double-quote characters from
 * every URL in chapters.url_pages. These quotes were introduced at some
 * point in the upstream data (or a previous scraper) and cause the
 * reader UI to render broken URLs like
 *   https://lectorfenix.com/comics/<slug>/chapters/"https://..."
 * which the browser then URL-encodes to
 *   https://lectorfenix.com/comics/<slug>/chapters/%22https://...%22
 *
 * The fix is a single SQL UPDATE: rebuild the url_pages array using
 * `jsonb_array_elements_text` (which yields plain text directly, no
 * `::text` re-cast needed) and a single regex `^"|"$` with the `g`
 * flag to strip a leading and/or trailing quote in one pass.
 *
 * Idempotent: re-running on already-clean data is a no-op.
 *
 * Run with:
 *   DRY_RUN=1 bun run src/strip-url-page-quotes.ts
 *   bun run src/strip-url-page-quotes.ts
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const dryRun = process.env.DRY_RUN === "1";

  console.log("=== Strip wrapping quotes from chapters.url_pages ===\n");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  // Count: chapters that have at least one element with a leading or
  // trailing quote. A single subquery avoids the SRF aliasing pitfall
  // that bites when calling jsonb_array_elements_text inside SELECT.
  const before = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM chapters c
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.url_pages) AS elem
          WHERE elem LIKE '"%' OR elem LIKE '%"'
        )
      ) AS chapters_any_quote,
      (SELECT COUNT(*)::int FROM chapters c
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.url_pages) AS elem
          WHERE elem LIKE '"%"'
        )
      ) AS chapters_wrapped
  `);
  const b = before.rows?.[0] as any;
  console.log(`Before:`);
  console.log(`  chapters with any leading/trailing quote:  ${b.chapters_any_quote}`);
  console.log(`  chapters with elements wrapped in quotes:  ${b.chapters_wrapped}\n`);

  if (dryRun) {
    console.log("DRY RUN — no updates performed.");
    await pool.end();
    return;
  }

  // Rebuild each affected chapter's url_pages array. Using
  // jsonb_array_elements_text (not jsonb_array_elements + ::text) so the
  // regex operates on the actual string content. The pattern ^"|"$ with
  // the 'g' flag strips a leading AND/OR trailing quote in one pass.
  const res = await db.execute(sql`
    UPDATE chapters
    SET url_pages = (
      SELECT jsonb_agg(regexp_replace(elem, '^"|"$', '', 'g'))
      FROM jsonb_array_elements_text(url_pages) AS elem
    ),
    updated_at = NOW()
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(url_pages) AS elem
      WHERE elem LIKE '"%' OR elem LIKE '%"'
    )
  `);
  console.log(`chapters updated: ${res.rowCount ?? "?"}\n`);

  // Verify
  const after = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM chapters c
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.url_pages) AS elem
          WHERE elem LIKE '"%' OR elem LIKE '%"'
        )
      ) AS chapters_any_quote,
      (SELECT COUNT(*)::int FROM chapters c
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.url_pages) AS elem
          WHERE elem LIKE '"%"'
        )
      ) AS chapters_wrapped
  `);
  const a = after.rows?.[0] as any;
  console.log(`After:`);
  console.log(`  chapters with any leading/trailing quote:  ${a.chapters_any_quote}`);
  console.log(`  chapters with elements wrapped in quotes:  ${a.chapters_wrapped}`);

  if (a.chapters_any_quote === 0) {
    console.log("\n✅ All quotes stripped.");
  } else {
    console.log("\n⚠️  Some quotes remain — check manually.");
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("\n[strip-quotes] crashed:", err);
  process.exit(1);
});
