import { Logger } from '@/lib/logger';
import { createScraperRuntime } from '@/lib/runtime';
import { LeerCapituloAdapter } from '@/modules/scraper/adapters/leercapitulo.adapter';
import { chapters, comicScans, comics, scanGroups } from '@/database/schema';
import { eq, and, sql } from 'drizzle-orm';

const logger = new Logger('RescrapeEmptyChapters');

async function main() {
  const scanSlug = process.argv[2] || 'leercapitulo';
  logger.log(`Starting re-scrape for empty chapters of scan group: "${scanSlug}"...`);

  const { db, config, close } = await createScraperRuntime();

  try {
    const scanGroup = await db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, scanSlug),
    });

    if (!scanGroup) {
      logger.error(`Scan group "${scanSlug}" not found in database.`);
      process.exit(1);
    }

    // Find all chapters with empty urlPages
    const emptyChapters = await db
      .select({
        chapterId: chapters.id,
        chapterNumber: chapters.chapterNumber,
        chapterTitle: chapters.title,
        chapterSlug: chapters.slug,
        comicSlug: comics.slug,
        comicTitle: comics.title,
      })
      .from(chapters)
      .innerJoin(comicScans, eq(chapters.comicScanId, comicScans.id))
      .innerJoin(comics, eq(comicScans.comicId, comics.id))
      .where(
        and(
          eq(comicScans.scanGroupId, scanGroup.id),
          sql`jsonb_array_length(COALESCE(${chapters.urlPages}, '[]'::jsonb)) = 0`,
        ),
      );

    logger.log(`Found ${emptyChapters.length} empty chapters to re-scrape for "${scanSlug}".`);

    if (emptyChapters.length === 0) {
      logger.log('No empty chapters found. Everything is up to date!');
      return;
    }

    const adapter = new LeerCapituloAdapter(db, 200, config.get<string>('SCRAPER_LEERCAPITULO_URL'));

    let updatedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < emptyChapters.length; i++) {
      const item = emptyChapters[i];
      // Construct chapter URL for LeerCapitulo
      // Example: https://www.leercapitulo.co/leer/<hash>/<manga-slug>/<chapter-num>/
      const chapterNumStr = item.chapterNumber.toString().replace('.', ',');
      const targetUrl = `https://www.leercapitulo.co/manga/${item.comicSlug}/`;

      logger.log(
        `[${i + 1}/${emptyChapters.length}] Re-scraping ${item.comicTitle} - Cap ${item.chapterNumber}...`,
      );

      try {
        // Scrape comic pages by url
        const res = await adapter.scrapeComicByUrl(item.comicSlug);
        if (res.chapters > 0) {
          updatedCount++;
        }
      } catch (err: any) {
        logger.error(`Failed to re-scrape ${item.comicTitle} Cap ${item.chapterNumber}: ${err.message || err}`);
        failedCount++;
      }
    }

    logger.log(
      `Re-scrape completed! Successfully processed ${updatedCount} comics/chapters, ${failedCount} errors.`,
    );
  } finally {
    await close();
  }
}

main().catch((err) => {
  logger.error(`Rescrape script failed: ${err.message || err}`);
  process.exit(1);
});
