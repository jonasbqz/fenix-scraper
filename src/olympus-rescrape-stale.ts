/**
 * One-off utility for olympus chapters:
 *
 * 1. CLEANUP: strip every url_pages entry that contains `/comics/covers/`
 *    from EVERY olympus chapter (one-shot SQL UPDATE). This undoes the
 *    historical damage from the previous __NUXT_DATA__ filter that mixed
 *    "recommended comics" cover thumbnails with real chapter pages.
 *
 * 2. RE-SCRAPE: for each comic in the olympus scan group, look at the
 *    last RANGE_BACK integer chapters. If urlPages has <= MIN_PAGES
 *    items (because the cleanup emptied them, or because the original
 *    scrape only captured covers), re-fetch the chapter HTML through
 *    the proxy and extract pages with cheerio + `main section img`.
 *    If the new page count > existing, UPDATE chapters.urlPages.
 *
 * NOT part of the main scraper pipeline. Run ad-hoc:
 *   bun run src/olympus-rescrape-stale.ts              # live, writes to DB
 *   DRY_RUN=1 bun run src/olympus-rescrape-stale.ts    # log only, no writes
 */

import * as cheerio from "cheerio";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { chapters, comics, comicScans, scanGroups } from "@/database/schema";

const PROXY = "https://mango-proxy.platformoctopus.workers.dev";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const MIN_PAGES = 5; // re-scrape if existing has this many or fewer
const RANGE_BACK = 15; // only check the last N integer chapters per comic
const REQUEST_DELAY_MS = 200; // politeness between requests
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT_COMICS = process.env.LIMIT_COMICS
  ? parseInt(process.env.LIMIT_COMICS, 10)
  : 0; // 0 = no limit

async function fetchChapterPages(slug: string, chapterId: string): Promise<string[]> {
  const url = `${PROXY}/olympus/capitulo/${chapterId}/comic-${slug}`;
  const res = await fetch(url, {
    headers: { Accept: "text/html", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  // The reader area is scoped inside <main><section>; the "recommended
  // comics" cover thumbnails are in a different section outside the
  // reader, so this selector picks up only the actual chapter pages.
  const $ = cheerio.load(html);
  const pages: string[] = [];
  $("main section img").each((_, el) => {
    const src = $(el).attr("src");
    if (src && src.startsWith("http")) pages.push(src);
  });
  return pages;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required (set in .env or env vars)");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log("=== Olympus — Cleanup + re-scrape integer chapters ===\n");
  console.log(`Threshold:    <= ${MIN_PAGES} pages`);
  console.log(`Range:        last ${RANGE_BACK} integer chapters per comic`);
  console.log(`Mode:         ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE (will UPDATE)"}\n`);

  // Find Olympus scan group
  const sgRows = await db
    .select()
    .from(scanGroups)
    .where(eq(scanGroups.slug, "olympus"))
    .limit(1);
  if (sgRows.length === 0) {
    console.error("No olympus scan group");
    process.exit(1);
  }
  const sgId = sgRows[0].id;

  // ── Cleanup pass: strip every `/comics/covers/` URL from every olympus
  // chapter. This undoes the historical damage from the previous
  // __NUXT_DATA__ filter that pulled in "recommended comics" thumbnails.
  // After this, chapters that contained only covers become empty and
  // will be re-scraped by the loop below.
  if (!DRY_RUN) {
    const cleanupRes = await db.execute(sql`
      UPDATE chapters
      SET url_pages = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(url_pages) AS elem
        WHERE elem::text NOT LIKE '%/comics/covers/%'
      ),
      updated_at = NOW()
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(url_pages) AS u
        WHERE u LIKE '%/comics/covers/%'
      )
    `);
    console.log(`Cleanup: stripped covers from ${cleanupRes.rowCount ?? "?"} chapters\n`);
  } else {
    const countRows = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM chapters c
      JOIN comic_scans cs ON cs.id = c.comic_scan_id
      WHERE cs.scan_group_id = ${sgId}
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.url_pages) AS u
          WHERE u LIKE '%/comics/covers/%'
        )
    `);
    const n = (countRows.rows?.[0] as any)?.n ?? "?";
    console.log(`Cleanup (DRY): would strip covers from ${n} chapters\n`);
  }

  // Get all comics linked to Olympus
  const scans = await db
    .select({
      comicScanId: comicScans.id,
      comicId: comics.id,
      slug: comics.slug,
      title: comics.title,
    })
    .from(comicScans)
    .innerJoin(comics, eq(comics.id, comicScans.comicId))
    .where(eq(comicScans.scanGroupId, sgId))
    .orderBy(comics.title);

  console.log(`Comics linked to Olympus: ${scans.length}${LIMIT_COMICS ? ` (limited to ${LIMIT_COMICS})` : ""}\n`);

  let examined = 0;
  let replaced = 0;
  let unchanged = 0;
  let errors = 0;
  const errorSamples: string[] = [];

  const scanList = LIMIT_COMICS > 0 ? scans.slice(0, LIMIT_COMICS) : scans;

  for (const scan of scanList) {
    // Max integer chapter for this comic
    const maxRows = await db
      .select({ max: sql<number>`MAX(${chapters.chapterNumber})` })
      .from(chapters)
      .where(
        and(
          eq(chapters.comicScanId, scan.comicScanId),
          sql`${chapters.chapterNumber} = FLOOR(${chapters.chapterNumber})`,
        ),
      );
    const max = maxRows[0]?.max != null ? Number(maxRows[0].max) : null;
    if (max === null) continue;

    // Integer chapters in [max-RANGE_BACK+1, max], newest first
    const candidates = await db
      .select()
      .from(chapters)
      .where(
        and(
          eq(chapters.comicScanId, scan.comicScanId),
          sql`${chapters.chapterNumber} = FLOOR(${chapters.chapterNumber})`,
          gte(chapters.chapterNumber, max - RANGE_BACK + 1),
          lte(chapters.chapterNumber, max),
        ),
      )
      .orderBy(desc(chapters.chapterNumber));

    for (const ch of candidates) {
      const existingCount = ch.urlPages?.length ?? 0;
      if (existingCount > MIN_PAGES) continue;

      examined++;
      process.stdout.write(
        `  [${scan.title}] Ch ${ch.chapterNumber} (existing=${existingCount}) → `,
      );

      try {
        const newPages = await fetchChapterPages(scan.slug, ch.slug);
        const newCount = newPages.length;

        if (newCount > existingCount) {
          if (!DRY_RUN) {
            await db
              .update(chapters)
              .set({ urlPages: newPages, updatedAt: new Date() })
              .where(eq(chapters.id, ch.id));
          }
          process.stdout.write(
            `✅ ${existingCount} → ${newCount}\n`,
          );
          replaced++;
        } else {
          process.stdout.write(
            `⏭ ${newCount} pages (not better than ${existingCount})\n`,
          );
          unchanged++;
        }
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      } catch (err: any) {
        process.stdout.write(`❌ ${err.message}\n`);
        errors++;
        if (errorSamples.length < 5) {
          errorSamples.push(`${scan.title} Ch ${ch.chapterNumber}: ${err.message}`);
        }
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Comics scanned:  ${scanList.length}${LIMIT_COMICS ? ` (of ${scans.length} total, limited by LIMIT_COMICS=${LIMIT_COMICS})` : ""}`);
  console.log(`Chapters examined (had <= ${MIN_PAGES} pages): ${examined}`);
  console.log(`Replaced:        ${replaced}${DRY_RUN ? "  (DRY RUN — no writes)" : ""}`);
  console.log(`Unchanged:       ${unchanged} (re-scrape didn't find more pages)`);
  console.log(`Errors:          ${errors}`);
  if (errorSamples.length > 0) {
    console.log(`\nError samples:`);
    for (const s of errorSamples) console.log(`  - ${s}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("\n[rescrape] crashed:", err);
  process.exit(1);
});
