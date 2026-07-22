/**
 * One-off re-scrape: fix m440 chapters that were saved with antibot
 * placeholder images (all url_pages entries identical).
 *
 * Background: m440.in serves a single placeholder image when it detects a
 * bot-like request. The old fetchHtml used a stale Chrome/122 UA with no
 * proxy, so some chapters were persisted where every url_pages entry is the
 * same image. This script detects those chapters (jsonb_array_length > 1 AND
 * all elements identical), re-fetches the chapter HTML through the
 * mango-proxy with a current Chrome UA, re-parses `var pages = [...]` with
 * the same logic as the adapter (including the antibot dedup guard), and
 * updates url_pages only when the new pages pass the guard AND have more
 * unique URLs than the old ones.
 *
 * Run with:
 *   bun run src/m440-rescrape-antibot.ts              # dry run (default)
 *   DRY_RUN=0 bun run src/m440-rescrape-antibot.ts     # live, writes to DB
 *   DAYS_BACK=60 bun run src/m440-rescrape-antibot.ts  # extend lookback window
 */

import * as cheerio from 'cheerio';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/database/schema';
import { chapters, scanGroups } from '@/database/schema';

const M440_PROXY = 'https://mango-proxy.platformoctopus.workers.dev/m440';
const M440_IMAGE_CDN = 'https://s2.m440.in';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_DELAY_MS = 300;

// DRY_RUN=1 by default; only writes when DRY_RUN=0.
const DRY_RUN = process.env.DRY_RUN !== '0';
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '30', 10);

interface DetectedChapter {
  id: number;
  comicScanId: number;
  slug: string;
  chapterNumber: number;
  urlPages: string[];
  updatedAt: Date;
  comicId: number;
  mangaSlug: string;
}

/**
 * Parse `var pages = [...]` from chapter HTML. Mirrors m440.adapter.ts:
 * external images are base64-encoded URLs; internal images are served from
 * the m440 image CDN under /uploads/manga/<slug>/chapters/<chapter>/.
 */
function parseChapterPages(html: string, mangaSlug: string, chapterSlug: string): string[] {
  const $ = cheerio.load(html);
  const pages: string[] = [];

  $('script').each((_, el) => {
    const content = $(el).html() || '';
    const match = content.match(/var\s+pages\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return;
    try {
      const pagesData: { page_image: string; page_slug: string; external: string }[] = JSON.parse(match[1]);
      for (const p of pagesData) {
        if (p.external === '1') {
          // External image: base64-encoded URL, sometimes prefixed with https://
          try {
            let b64 = p.page_image;
            if (b64.startsWith('https://') || b64.startsWith('http://')) {
              b64 = b64.replace(/^https?:\/\//, '');
            }
            const decoded = decodeURIComponent(atob(b64));
            pages.push(decoded);
          } catch {
            pages.push(p.page_image);
          }
        } else {
          pages.push(`${M440_IMAGE_CDN}/uploads/manga/${mangaSlug}/chapters/${chapterSlug}/${p.page_image}`);
        }
      }
    } catch (e) {
      console.warn(`[parse] Failed to parse pages JSON for ${chapterSlug}: ${e}`);
    }
  });

  return pages;
}

/** Antibot guard: throws if all pages resolve to the same image filename. */
function assertNotAntibot(pages: string[], chapterSlug: string): void {
  if (pages.length > 0) {
    const uniqueFilenames = new Set(pages.map(p => { const parts = p.split('/'); return parts[parts.length - 1] || p; }));
    if (uniqueFilenames.size === 1) {
      throw new Error(`Antibot placeholder detected: all ${pages.length} pages resolve to the same image (${pages[0]}) for ${chapterSlug}. Skipping.`);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (set in .env or env vars)');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  console.log('=== m440 — re-scrape antibot placeholder chapters ===\n');
  console.log(`Lookback: last ${DAYS_BACK} days`);
  console.log(`Mode:     ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will UPDATE)'}\n`);

  // 2. Find the Peerless/m440 scan group (created by m440.adapter.ts with
  //    slug='peerless-scan').
  const sg = await db.query.scanGroups.findFirst({
    where: eq(scanGroups.slug, 'peerless-scan'),
  });
  if (!sg) {
    console.error('No scan_groups row with slug="peerless-scan" found. Nothing to do.');
    await pool.end();
    return;
  }
  const sgId = sg.id;
  console.log(`Peerless scan group: id=${sgId}\n`);

  // 3. Detection query: chapters with >1 url_pages where all entries are
  //    identical (antibot placeholder). Limited to the last DAYS_BACK days.
  const detectionRes = await db.execute(sql`
    SELECT c.id, c.comic_scan_id, c.slug, c.chapter_number, c.url_pages, c.updated_at,
           cs.comic_id, comics.slug as manga_slug
    FROM chapters c
    JOIN comic_scans cs ON c.comic_scan_id = cs.id
    JOIN comics ON cs.comic_id = comics.id
    WHERE cs.scan_group_id = ${sgId}
      AND jsonb_array_length(c.url_pages) > 1
      AND (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(c.url_pages)) = 1
      AND c.updated_at >= now() - (${DAYS_BACK}::int * interval '1 day')
    ORDER BY c.updated_at DESC
  `);

  const detected: DetectedChapter[] = (detectionRes.rows || []).map((r: any) => ({
    id: r.id,
    comicScanId: r.comic_scan_id,
    slug: r.slug,
    chapterNumber: r.chapter_number,
    urlPages: r.url_pages || [],
    updatedAt: r.updated_at,
    comicId: r.comic_id,
    mangaSlug: r.manga_slug,
  }));

  console.log(`Detected antibot placeholder chapters: ${detected.length}\n`);

  let rescraped = 0;
  let skipped = 0;
  let stillBad = 0;
  let errors = 0;
  const errorSamples: string[] = [];

  for (const ch of detected) {
    const oldCount = ch.urlPages.length;
    const oldUnique = new Set(ch.urlPages).size;
    process.stdout.write(
      `  [${ch.mangaSlug}] Ch ${ch.slug} (old: ${oldCount} pages, ${oldUnique} unique) → `,
    );

    try {
      // 4. Reconstruct chapter URL via the proxy and re-fetch with the new UA.
      const chapterUrl = `${M440_PROXY}/manga/${ch.mangaSlug}/${ch.slug}`;
      const res = await fetch(chapterUrl, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Referer': M440_PROXY,
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${chapterUrl}`);
      const html = await res.text();

      const newPages = parseChapterPages(html, ch.mangaSlug, ch.slug);
      assertNotAntibot(newPages, ch.slug);

      const newCount = newPages.length;
      const newUnique = new Set(newPages).size;

      // Only update when the new pages pass the guard AND have more unique
      // URLs than the old (all-identical) set.
      if (newCount > 0 && newUnique > oldUnique) {
        if (!DRY_RUN) {
          await db.update(chapters)
            .set({ urlPages: newPages, updatedAt: new Date() })
            .where(eq(chapters.id, ch.id));
        }
        process.stdout.write(`✅ ${oldCount} → ${newCount} (${newUnique} unique)\n`);
        rescraped++;
      } else if (newCount === 0) {
        process.stdout.write(`⏭ no pages parsed\n`);
        skipped++;
      } else {
        process.stdout.write(`⏭ still antibot (${newCount} pages, ${newUnique} unique)\n`);
        stillBad++;
      }

      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    } catch (err: any) {
      process.stdout.write(`❌ ${err.message}\n`);
      errors++;
      if (err.message.includes('Antibot placeholder')) {
        stillBad++;
      }
      if (errorSamples.length < 5) {
        errorSamples.push(`${ch.mangaSlug} Ch ${ch.slug}: ${err.message}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Detected:   ${detected.length}`);
  console.log(`Re-scraped: ${rescraped}${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  console.log(`Skipped:    ${skipped} (no pages parsed)`);
  console.log(`Still bad:  ${stillBad} (re-scrape still returned placeholder)`);
  console.log(`Errors:     ${errors}`);
  console.log(`Mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  if (errorSamples.length > 0) {
    console.log(`\nError samples:`);
    for (const s of errorSamples) console.log(`  - ${s}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('\n[m440-rescrape] crashed:', err);
  process.exit(1);
});
