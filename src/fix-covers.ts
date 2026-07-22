/**
 * Replace ALL cover images in mango-image for peerless/m440 manga.
 *
 * Uses the coverImage URL already stored in the comics table (set by the
 * m440 adapter during scraping). If coverImage is null, falls back to the
 * standard m440.in cover URL pattern.
 *
 * For every peerless manga:
 *   - Re-uploads the cover from the DB's coverImage URL (overwrite existing)
 *   - Uploads covers for manga that have NO cover in the catalog
 *   - Detects s1/s2 URLs in existing covers and replaces with m440.in
 *
 * Usage:
 *   bun run fix-covers                    # dry run (default)
 *   DRY_RUN=0 bun run fix-covers          # live, re-uploads all covers
 *   MANGA_SLUG=martial-peak bun run fix-covers  # single manga only
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import * as schema from "@/database/schema";
import { comics, comicScans, scanGroups } from "@/database/schema";
import { EnvConfig } from "@/lib/config";
import { Logger } from "@/lib/logger";
import { fetchCatalogManga } from "@/lib/mango-image-catalog";
import { uploadCoverToMangoImage } from "@/lib/mango-image-upload";

// Configuration
const DRY_RUN = process.env.DRY_RUN !== "0";
const MANGA_SLUG_FILTER = process.env.MANGA_SLUG || null;

// No delay between uploads — we're fixing covers, not scraping
process.env.MANGO_IMAGE_DELAY_MS = "0";

/** Fallback cover URL when DB has no coverImage. */
function fallbackCoverUrl(slug: string): string {
  return `https://m440.in/uploads/manga/${slug}/cover/cover_250x350.jpg`;
}

/** Detect s1/s2 CDN URLs that should be m440.in for covers. */
function isS1S2Url(url: string): boolean {
  return url.includes("s1.m440.in") || url.includes("s2.m440.in");
}

/** Detect s1/s2 in catalog cover keys. */
function catalogHasS1S2(covers: Array<{ key: string }>): boolean {
  return covers.some((c) => isS1S2Url(c.key));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const config = new EnvConfig();
  const log = new Logger("fix-covers");

  console.log("=== Replace ALL cover images ===\n");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE (will re-upload)"}`);

  // 1. Get peerless manga with their coverImage from DB
  let mangaRows: Array<{ slug: string; coverImage: string | null }>;
  if (MANGA_SLUG_FILTER) {
    mangaRows = [{ slug: MANGA_SLUG_FILTER, coverImage: null }];
  } else {
    const peerlessGroup = await db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, "peerless-scan"),
    });
    if (!peerlessGroup) {
      console.error('No scan_groups row with slug="peerless-scan"');
      await pool.end();
      return;
    }
    mangaRows = await db
      .select({ slug: comics.slug, coverImage: comics.coverImage })
      .from(comics)
      .innerJoin(comicScans, eq(comicScans.comicId, comics.id))
      .where(eq(comicScans.scanGroupId, peerlessGroup.id))
      .orderBy(comics.slug);
  }

  console.log(`Found ${mangaRows.length} peerless manga(s)\n`);

  // 2. Process each manga
  let processed = 0;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let noCover = 0;
  let s1s2Fixed = 0;
  let usedFallback = 0;

  for (const row of mangaRows) {
    processed++;
    const { slug, coverImage: dbCoverUrl } = row;

    // Use DB coverImage if available, otherwise fallback
    let coverUrl = dbCoverUrl;
    if (!coverUrl || coverUrl.trim() === "") {
      coverUrl = fallbackCoverUrl(slug);
      usedFallback++;
    }

    // If the DB URL has s1/s2, normalize to m440.in
    if (isS1S2Url(coverUrl)) {
      coverUrl = coverUrl
        .replace("://s1.m440.in", "://m440.in")
        .replace("://s2.m440.in", "://m440.in");
      s1s2Fixed++;
    }

    process.stdout.write(`[${processed}/${mangaRows.length}] ${slug}... `);

    try {
      // Check catalog for s1/s2 or missing cover
      const catalog = await fetchCatalogManga(config, slug);
      if (catalog.ok) {
        const manga = catalog.data;
        if (manga.covers.length === 0) {
          process.stdout.write(`no cover → `);
        } else if (catalogHasS1S2(manga.covers)) {
          process.stdout.write(`s1/s2 in catalog → `);
        }
      }

      // Always upload (or re-upload) the cover
      if (!DRY_RUN) {
        const result = await uploadCoverToMangoImage({
          coverUrl,
          mangaSlug: slug,
          scraperName: "peerless",
          config,
          log,
        });

        if (result.uploaded > 0) {
          console.log(`✓ uploaded`);
          uploaded++;
        } else if (result.skipped > 0) {
          if (result.skippedReason === "gate" || result.skippedReason === "wrong-mode") {
            console.log(`✗ skipped (${result.skippedReason})`);
            skipped++;
          } else {
            console.log(`✗ download failed`);
            failed++;
          }
        } else {
          console.log(`✗ failed`);
          failed++;
        }
      } else {
        const catalog = await fetchCatalogManga(config, slug);
        if (catalog.ok && catalog.data.covers.length > 0) {
          const sizeKB = catalog.data.covers[0]!.byte_size / 1024;
          console.log(`exists (${sizeKB.toFixed(0)}KB) → will replace`);
        } else {
          console.log(`→ will upload from ${coverUrl}`);
          noCover++;
        }
      }
    } catch (e) {
      console.log(`✗ error: ${(e as Error).message}`);
      failed++;
    }
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  if (usedFallback > 0) console.log(`Used fallback URL: ${usedFallback}`);
  if (s1s2Fixed > 0) console.log(`s1/s2 normalized: ${s1s2Fixed}`);
  if (DRY_RUN) {
    console.log(`Would upload: ${processed - skipped - failed}`);
    console.log(`Skipped (gate): ${skipped}`);
    console.log(`Failed: ${failed}`);
    console.log(`\nTo apply: DRY_RUN=0 bun run fix-covers`);
  } else {
    console.log(`Uploaded: ${uploaded}`);
    console.log(`Failed:   ${failed}`);
    console.log(`Skipped:  ${skipped}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("\n[fix-covers] crashed:", err);
  process.exit(1);
});
