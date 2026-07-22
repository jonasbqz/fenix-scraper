#!/usr/bin/env bun
// Fix malformed chapter image URLs in the DB.
//
// Problem: some external image URLs (blogspot, etc.) were stored with
// "https://s1.m440.in" or "https://s2.m440.in" prepended, creating
// broken URLs like:
//   https://s1.m440.inhttps://2.bp.blogspot.com/...
//
// This script finds and fixes them by stripping the m440 CDN prefix,
// restoring the original external URL.
//
// Usage:
//   bun run src/fix-double-urls.ts              # dry run (show what would change)
//   bun run src/fix-double-urls.ts --apply      # actually update the DB
//
// Env vars:
//   DATABASE_URL — required (same as the scraper)

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, sql, like } from "drizzle-orm";
import * as schema from "@/database/schema";
import { chapters } from "@/database/schema";

const APPLY = process.argv.includes("--apply");

// Patterns that indicate a malformed double URL
const DOUBLE_URL_PATTERNS = [
  "https://s1.m440.inhttps://",
  "https://s2.m440.inhttps://",
  "https://s1.m440.inhttp://",
  "https://s2.m440.inhttp://",
  "https://m440.inhttps://",
  "https://m440.inhttp://",
];

function fixUrl(url: string): string | null {
  for (const prefix of DOUBLE_URL_PATTERNS) {
    if (url.startsWith(prefix)) {
      // Extract the part after the m440 CDN domain
      const prefixLen = "https://s1.m440.in".length; // same length for s2/m440
      return url.slice(prefixLen);
    }
  }
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  console.log(`Mode: ${APPLY ? "APPLY (writing to DB)" : "DRY RUN (no changes)"}`);
  console.log("");

  // Find all chapters with urlPages containing any double-URL pattern
  // We use a raw SQL query with jsonb_array_elements_text to check each URL
  const conditions = DOUBLE_URL_PATTERNS.map(
    (p) => `url_text LIKE '${p}%'`
  ).join(" OR ");

  const query = sql`
    SELECT
      ch.id AS chapter_id,
      ch.slug AS chapter_slug,
      c.slug AS manga_slug,
      ch.url_pages
    FROM chapters ch
    INNER JOIN comic_scans cs ON ch.comic_scan_id = cs.id
    INNER JOIN comics c ON cs.comic_id = c.id
    INNER JOIN scan_groups sg ON cs.scan_group_id = sg.id
    WHERE sg.slug = 'peerless-scan'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(ch.url_pages) AS url_text
        WHERE ${sql.raw(conditions)}
      )
    ORDER BY c.slug, ch.chapter_number
  `;

  console.log("Scanning for malformed URLs...");
  const result = await db.execute(query);
  const rows = result.rows ?? [];

  if (rows.length === 0) {
    console.log("No chapters with malformed URLs found. All good!");
    await pool.end();
    return;
  }

  console.log(`Found ${rows.length} chapters with malformed URLs\n`);

  let totalFixed = 0;
  let totalUrls = 0;
  let totalAlready = 0;
  const affectedMangas = new Set<string>();

  for (const row of rows) {
    const chapterId = row.chapter_id as number;
    const chapterSlug = row.chapter_slug as string;
    const mangaSlug = row.manga_slug as string;
    const urlPages = row.url_pages as string[];

    if (!Array.isArray(urlPages)) continue;

    const fixedUrls: string[] = [];
    let chapterFixed = 0;

    for (const url of urlPages) {
      const fixed = fixUrl(url);
      if (fixed) {
        fixedUrls.push(fixed);
        chapterFixed++;
        totalFixed++;
        affectedMangas.add(mangaSlug);
      } else {
        fixedUrls.push(url);
      }
      totalUrls++;
    }

    if (chapterFixed === 0) {
      totalAlready++;
      continue;
    }

    const preview = urlPages
      .filter((u) => fixUrl(u))
      .slice(0, 2)
      .map((u) => `    ${u}\n    → ${fixUrl(u)}`)
      .join("\n");

    console.log(`[${mangaSlug}] ${chapterSlug}: ${chapterFixed} URLs to fix`);
    if (preview) console.log(preview);
    console.log("");

    if (APPLY) {
      await db
        .update(chapters)
        .set({ urlPages: fixedUrls, updatedAt: new Date() })
        .where(eq(chapters.id, chapterId));
    }
  }

  console.log("═".repeat(60));
  console.log(`Total chapters scanned: ${rows.length}`);
  console.log(`Total URLs: ${totalUrls}`);
  console.log(`URLs to fix: ${totalFixed}`);
  console.log(`Affected mangas: ${affectedMangas.size}`);
  console.log(`Already correct: ${totalAlready}`);

  if (APPLY) {
    console.log(`\n✅ Applied! ${totalFixed} URLs fixed in the database.`);
  } else {
    console.log(`\n⚠️  Dry run. To apply, run with --apply`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
