import { Logger } from '@/lib/logger';
import { createScraperRuntime } from '@/lib/runtime';
import { LeerCapituloAdapter } from '@/modules/scraper/adapters/leercapitulo.adapter';
import { chapters, comicScans, comics, scanGroups } from '@/database/schema';
import { eq, and, sql } from 'drizzle-orm';

const logger = new Logger('RescrapeEmptyChapters');

async function resolveMangaUrl(comicTitle: string, comicSlug: string): Promise<string> {
  try {
    const searchUrl = `https://fenix-proxy.sasadane2.workers.dev/leercapitulo/search-autocomplete?term=${encodeURIComponent(comicTitle.slice(0, 20))}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    if (res.ok) {
      const items = (await res.json()) as any[];
      if (Array.isArray(items) && items.length > 0) {
        const found = items.find((i) => (i.link || '').includes(comicSlug)) || items[0];
        if (found && found.link) {
          return `https://www.leercapitulo.co${found.link}`;
        }
      }
    }
  } catch (e) {}

  const nameSlug = comicTitle
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `https://www.leercapitulo.co/manga/${comicSlug}/${nameSlug}/`;
}

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

    // Find all unique comics having empty chapters
    const emptyComics = await db
      .selectDistinct({
        comicId: comics.id,
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

    logger.log(`Found ${emptyComics.length} comics with empty chapters for "${scanSlug}".`);

    if (emptyComics.length === 0) {
      logger.log('No comics with empty chapters found. Everything is up to date!');
      return;
    }

    const adapter = new LeerCapituloAdapter(db, 200, config.get<string>('SCRAPER_LEERCAPITULO_URL'));

    let updatedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < emptyComics.length; i++) {
      const comic = emptyComics[i];
      logger.log(`[${i + 1}/${emptyComics.length}] Resolving manga URL for "${comic.comicTitle}"...`);

      try {
        const fullMangaUrl = await resolveMangaUrl(comic.comicTitle, comic.comicSlug);
        logger.log(`[${i + 1}/${emptyComics.length}] Re-scraping "${comic.comicTitle}" via ${fullMangaUrl}...`);

        const res = await adapter.scrapeComicByUrl(fullMangaUrl);
        logger.log(`[${i + 1}/${emptyComics.length}] Finished "${comic.comicTitle}": ${res.chapters} chapters updated.`);
        updatedCount++;
      } catch (err: any) {
        logger.error(`Failed to re-scrape "${comic.comicTitle}": ${err.message || err}`);
        failedCount++;
      }
    }

    logger.log(`Re-scrape completed! Successfully processed ${updatedCount} comics, ${failedCount} errors.`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  logger.error(`Rescrape script failed: ${err.message || err}`);
  process.exit(1);
});
