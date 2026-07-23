import { Logger } from '@/lib/logger';
import { createScraperRuntime } from '@/lib/runtime';
import { comics, chapters, comicScans, bookmarks, comicGenres } from '@/database/schema';
import { isDmcaBlocked } from '@/modules/scraper/adapters/base.adapter';
import { eq, or, inArray } from 'drizzle-orm';

const logger = new Logger('PurgeDmcaComics');

async function main() {
  logger.log('Starting DMCA Cleanup & Purge scan across production database...');

  const { db, close } = await createScraperRuntime();

  try {
    const allComics = await db.query.comics.findMany({
      columns: {
        id: true,
        title: true,
        slug: true,
        copyrighted: true,
      },
    });

    const toDelete = allComics.filter(
      (c) => isDmcaBlocked(c.title, c.slug),
    );

    logger.log(`Analyzed ${allComics.length} comics. Found ${toDelete.length} DMCA-blocked / copyrighted comics to purge.`);

    if (toDelete.length === 0) {
      logger.log('Clean database! No DMCA protected comics found.');
      return;
    }

    const idsToDelete = toDelete.map((c) => c.id);

    for (const c of toDelete) {
      logger.warn(`[DMCA PURGE] Purging DMCA blocked comic: "${c.title}" (ID: ${c.id}, slug: "${c.slug}")`);
    }

    // Delete in order if cascade isn't fully enabled
    await db.delete(comicGenres).where(inArray(comicGenres.comicId, idsToDelete));
    await db.delete(bookmarks).where(inArray(bookmarks.comicId, idsToDelete));
    
    // Find all comic_scans for these comics to delete chapters first
    const scanRecords = await db.query.comicScans.findMany({
      where: inArray(comicScans.comicId, idsToDelete),
      columns: { id: true },
    });
    if (scanRecords.length > 0) {
      const scanIds = scanRecords.map((s) => s.id);
      await db.delete(chapters).where(inArray(chapters.comicScanId, scanIds));
      await db.delete(comicScans).where(inArray(comicScans.id, scanIds));
    }

    // Delete comics
    await db.delete(comics).where(inArray(comics.id, idsToDelete));

    logger.log(`Successfully purged ${toDelete.length} DMCA blocked comics and all their associated chapters from production database.`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  logger.error(`Purge script failed: ${err.message || err}`);
  process.exit(1);
});
