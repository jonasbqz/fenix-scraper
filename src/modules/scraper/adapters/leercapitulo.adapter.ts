import { Logger } from '@/lib/logger';
import * as cheerio from 'cheerio';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq, and } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ScraperResult } from '../scraper.types';
import {
  isAdultGenreSlug,
  sanitizeGenreNames,
  isDmcaBlocked,
  BaseScraperAdapter,
} from './base.adapter';

const LEERCAPITULO_ORIGIN = 'https://www.leercapitulo.co';
const LEERCAPITULO_PROXY_DEFAULT =
  'https://fenix-proxy.sasadane2.workers.dev/leercapitulo';

export function decryptLeerCapituloData(data: string): string {
  const alphabet1 = "EzCIUe3plcrfxuv9hKOsVtkTA6ZjaXRQJ0wWqb5D8gm1nG7LoH2dFyNYB4PiMS";
  const alphabet2 = "xXHbvV7snRpMFkrUPqlS4BzG3jg1aYC5WJ0wcZiLtoAyedQ8D2fTNOI9Eu6mhK";
  
  const translatedChars: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      const idx = alphabet2.indexOf(c);
      if (idx !== -1) {
        translatedChars.push(alphabet1[idx]);
        continue;
      }
    }
    translatedChars.push(c);
  }
  let translated = translatedChars.join("");
  
  const missingPadding = translated.length % 4;
  if (missingPadding) {
    translated += "=".repeat(4 - missingPadding);
  }
  try {
    return Buffer.from(translated, 'base64').toString('utf-8');
  } catch {
    return "";
  }
}

export class LeerCapituloAdapter extends BaseScraperAdapter {
  private readonly logger = new Logger(LeerCapituloAdapter.name);
  private scanGroupId: number | null = null;
  private baseUrl: string;

  constructor(
    protected db: NodePgDatabase<typeof schema>,
    protected delayMs: number = 100,
    baseUrl?: string,
  ) {
    super(db, delayMs);
    this.baseUrl = (
      baseUrl || process.env.SCRAPER_LEERCAPITULO_URL || LEERCAPITULO_PROXY_DEFAULT
    ).replace(/\/$/, '');
  }

  getName() {
    return 'LeerCapitulo';
  }

  async scrape(
    startPage = 1,
    endPage = 1,
    postsPerPage = 18,
  ): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(
      `Starting LeerCapitulo scrape: pages ${startPage}-${endPage}, baseUrl: ${this.baseUrl}`,
    );

    try {
      await this.ensureScanGroup();
      this.logger.log(`Scan group ensured: ID ${this.scanGroupId}`);

      const comicUrls = await this.getRecentComicUrls();
      this.logger.log(`Found ${comicUrls.length} comics to scrape from LeerCapitulo`);

      for (const url of comicUrls) {
        try {
          await this.scrapeComic(url, result);
          await this.delay();
        } catch (error: any) {
          const msg = `Failed to scrape comic ${url}: ${error.message || error}`;
          this.logger.error(msg);
          result.errors.push(msg);
        }
      }
    } catch (error: any) {
      const msg = `LeerCapitulo scrape failed: ${error.message || error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    return result;
  }

  /**
   * Scrape a single specific comic by URL or slug
   */
  async scrapeComicByUrl(targetUrl: string): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };
    await this.ensureScanGroup();
    
    let url = targetUrl;
    if (!url.startsWith('http')) {
      url = `${LEERCAPITULO_ORIGIN}/manga/${targetUrl.replace(/^\//, '')}/`;
    }
    
    await this.scrapeComic(url, result);
    return result;
  }

  private async ensureScanGroup(): Promise<void> {
    if (this.scanGroupId) return;

    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'leercapitulo'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db
      .insert(scanGroups)
      .values({
        name: 'LeerCapitulo',
        slug: 'leercapitulo',
        website: LEERCAPITULO_ORIGIN,
      })
      .returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(): Promise<string[]> {
    const urls: string[] = [];
    const seen = new Set<string>();

    try {
      const html = await this.fetchHtml(`${this.baseUrl}/`);
      const $ = cheerio.load(html);

      $('.hot-manga a[href*="/manga/"], .mainpage-manga a[href*="/manga/"]').each(
        (_, el) => {
          let href = $(el).attr('href');
          if (href) {
            href = href.trim();
            if (!href.endsWith('/')) href += '/';
            if (!seen.has(href)) {
              seen.add(href);
              urls.push(this.toRealOriginUrl(href));
            }
          }
        },
      );
    } catch (error) {
      this.logger.error(`Failed to fetch home page for LeerCapitulo: ${error}`);
    }

    return urls;
  }

  private async scrapeComic(realUrl: string, result: ScraperResult): Promise<void> {
    const proxyUrl = this.toProxyUrl(realUrl);
    const html = await this.fetchHtml(proxyUrl);
    const $ = cheerio.load(html);

    const comic = this.parseComicFromHtml($, realUrl);
    if (!comic.title) {
      throw new Error(`Could not parse comic title from ${realUrl}`);
    }

    this.logger.log(`Scraping comic: ${comic.title}`);

    const comicId = await this.upsertComic(comic);
    result.comics++;

    const chapterItems = this.getChapterList($, realUrl);
    this.logger.log(`Found ${chapterItems.length} chapters for ${comic.title}`);

    for (const item of chapterItems) {
      try {
        const pages = await this.scrapeChapterPages(item.url);
        await this.upsertChapter(comicId, {
          chapterNumber: item.chapterNumber,
          title: item.title,
          slug: item.slug,
          pages,
        });
        result.chapters++;
        await this.delay();
      } catch (error: any) {
        const msg = `Failed chapter ${item.chapterNumber} of ${comic.title}: ${error.message || error}`;
        this.logger.error(msg);
        result.errors.push(msg);
      }
    }
  }

  private parseComicFromHtml($: cheerio.CheerioAPI, realUrl: string): ScrapedComic {
    let title =
      $('h1.title-manga').text().trim() ||
      $('h1.title').text().trim() ||
      $('.manga-info h1').text().trim() ||
      $('h1').first().text().trim();

    let description =
      $('.manga-collapse').text().trim() ||
      $('.sinopsis').text().trim() ||
      $('.manga-description').text().trim();

    let author =
      $('a[href*="/autor/"]').first().text().trim() ||
      $('a[href*="/author/"]').first().text().trim() ||
      'Autor desconocido';

    let coverImage = '';
    const imgEl = $('.cover-detail img, .manga-cover img, .cover-manga img').first();
    if (imgEl.length) {
      const src = imgEl.attr('data-src') || imgEl.attr('src') || '';
      if (src) {
        if (src.startsWith('//')) coverImage = 'https:' + src;
        else if (src.startsWith('/')) coverImage = LEERCAPITULO_ORIGIN + src;
        else coverImage = src;
      }
    }

    const genreNames: string[] = [];
    $('.manga-detail a[href*="/genre/"], .manga-info a[href*="/genre/"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text && !genreNames.includes(text)) {
        genreNames.push(text);
      }
    });

    let status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' = 'ongoing';
    const descText = $('p.description-update').text();
    if (/Estado:\s*finalizado|completed/i.test(descText)) {
      status = 'completed';
    }

    const slug = this.extractMangaSlug(realUrl);
    const sanitizedGenres = sanitizeGenreNames(genreNames);
    const isNsfw = sanitizedGenres.some(g => isAdultGenreSlug(this.slugify(g)));

    return {
      title,
      slug,
      description,
      author,
      coverImage,
      status,
      type: 'manga',
      genres: sanitizedGenres,
      isNsfw,
    };
  }

  private getChapterList($: cheerio.CheerioAPI, realMangaUrl: string): { chapterNumber: number; title: string; slug: string; url: string }[] {
    const items: { chapterNumber: number; title: string; slug: string; url: string }[] = [];
    const seen = new Set<string>();

    $('.chapter-list a, a[href*="/leer/"]').each((_, el) => {
      let href = $(el).attr('href');
      if (!href) return;
      href = href.trim();

      if (!href.includes('/leer/') && !href.includes('capitulo-')) return;

      let fullRealUrl = href;
      if (!fullRealUrl.startsWith('http')) {
        if (fullRealUrl.startsWith('/')) {
          fullRealUrl = LEERCAPITULO_ORIGIN + fullRealUrl;
        } else {
          fullRealUrl = `${LEERCAPITULO_ORIGIN}/leer/${fullRealUrl}`;
        }
      }

      if (seen.has(fullRealUrl)) return;
      seen.add(fullRealUrl);

      const parts = fullRealUrl.replace(/\/$/, '').split('/');
      const rawNumStr = parts[parts.length - 1] || '';
      const chapterNumber = this.parseChapterNumber(rawNumStr.replace(',', '.'));

      const title = $(el).text().trim() || `Capítulo ${chapterNumber}`;
      const slug = `capitulo-${chapterNumber}`;

      items.push({
        chapterNumber,
        title,
        slug,
        url: fullRealUrl,
      });
    });

    // Sort descending by chapter number
    items.sort((a, b) => b.chapterNumber - a.chapterNumber);
    return items;
  }

  private async scrapeChapterPages(realChapterUrl: string): Promise<string[]> {
    let normalizedUrl = realChapterUrl;
    if (!normalizedUrl.endsWith('/')) normalizedUrl += '/';

    const proxyChapterUrl = this.toProxyUrl(normalizedUrl);
    const html = await this.fetchHtml(proxyChapterUrl);
    const $ = cheerio.load(html);

    let imageUrls: string[] = [];

    let arrayDataText =
      $('#array_data').text().trim() ||
      ($('#array_data').val() || '').trim() ||
      ($('#array_data').attr('value') || '').trim();

    if (!arrayDataText) {
      const match =
        html.match(/id=["']array_data["'][^>]*>([^<]+)</i) ||
        html.match(/id=["']array_data["'][^>]*value=["']([^"']+)["']/i);
      if (match) {
        arrayDataText = match[1].trim();
      }
    }

    if (arrayDataText) {
      const decrypted = decryptLeerCapituloData(arrayDataText);
      if (decrypted) {
        imageUrls = decrypted
          .split(',')
          .map(u => u.trim())
          .filter(u => u.startsWith('http'));
      }
    }

    if (imageUrls.length === 0) {
      $('#page_select option, #page_select_top option').each((_, el) => {
        const val = ($(el).attr('value') || '').trim();
        if (val && val.startsWith('http') && !imageUrls.includes(val)) {
          imageUrls.push(val);
        }
      });
    }

    if (imageUrls.length === 0) {
      $('.comic_wraCon img, .reading-content img, .chapter-images img').each((_, el) => {
        const src = ($(el).attr('data-src') || $(el).attr('src') || '').trim();
        if (src && src.startsWith('http') && !imageUrls.includes(src)) {
          imageUrls.push(src);
        }
      });
    }

    if (imageUrls.length === 0) {
      this.logger.warn(`Extracted 0 images for chapter: ${realChapterUrl}`);
    }

    return imageUrls;
  }

  private async upsertComic(comic: ScrapedComic): Promise<number> {
    if (isDmcaBlocked(comic.title, comic.slug)) {
      throw new Error(`[DMCA Guard] Comic "${comic.title}" (${comic.slug}) is DMCA blocked.`);
    }

    const existing = await this.db.query.comics.findFirst({
      where: eq(comics.slug, comic.slug),
    });

    if (existing && existing.copyrighted) {
      throw new Error(`[DMCA Guard] Comic "${comic.title}" is marked copyrighted=true in database.`);
    }

    let comicId: number;

    if (existing) {
      comicId = existing.id;
      await this.db
        .update(comics)
        .set({
          title: comic.title,
          description: comic.description || existing.description,
          author: comic.author || existing.author,
          coverImage: comic.coverImage || existing.coverImage,
          status: comic.status || existing.status,
          isNsfw: comic.isNsfw ?? existing.isNsfw,
          updatedAt: new Date(),
        })
        .where(eq(comics.id, comicId));
    } else {
      const [inserted] = await this.db
        .insert(comics)
        .values({
          title: comic.title,
          slug: comic.slug,
          description: comic.description,
          author: comic.author,
          coverImage: comic.coverImage,
          status: comic.status || 'ongoing',
          type: comic.type || 'manga',
          isNsfw: comic.isNsfw || false,
        })
        .returning();
      comicId = inserted.id;
    }

    if (this.scanGroupId) {
      const existingScan = await this.db.query.comicScans.findFirst({
        where: and(
          eq(comicScans.comicId, comicId),
          eq(comicScans.scanGroupId, this.scanGroupId),
        ),
      });

      if (!existingScan) {
        await this.db.insert(comicScans).values({
          comicId,
          scanGroupId: this.scanGroupId,
        });
      }
    }

    if (comic.genres && comic.genres.length > 0) {
      for (const genreName of comic.genres) {
        const genreSlug = this.slugify(genreName);
        let genre = await this.db.query.genres.findFirst({
          where: eq(genres.slug, genreSlug),
        });

        if (!genre) {
          const [insertedGenre] = await this.db
            .insert(genres)
            .values({ name: genreName, slug: genreSlug })
            .returning();
          genre = insertedGenre;
        }

        const existingComicGenre = await this.db.query.comicGenres.findFirst({
          where: and(
            eq(comicGenres.comicId, comicId),
            eq(comicGenres.genreId, genre.id),
          ),
        });

        if (!existingComicGenre) {
          await this.db.insert(comicGenres).values({
            comicId,
            genreId: genre.id,
          });
        }
      }
    }

    return comicId;
  }

  private async upsertChapter(
    comicId: number,
    ch: { chapterNumber: number; title: string; slug: string; pages: string[] },
  ): Promise<void> {
    const comicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (!comicScan) {
      throw new Error(`No comicScan record found for comicId=${comicId}`);
    }

    const existingChapter = await this.db.query.chapters.findFirst({
      where: and(
        eq(chapters.comicScanId, comicScan.id),
        eq(chapters.chapterNumber, ch.chapterNumber),
      ),
    });

    if (existingChapter) {
      await this.db
        .update(chapters)
        .set({
          title: ch.title,
          urlPages: ch.pages,
          updatedAt: new Date(),
        })
        .where(eq(chapters.id, existingChapter.id));
    } else {
      await this.db.insert(chapters).values({
        comicScanId: comicScan.id,
        chapterNumber: ch.chapterNumber,
        title: ch.title,
        slug: ch.slug,
        urlPages: ch.pages,
      });
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        return await response.text();
      }
      this.logger.warn(`Primary fetch for ${url} returned ${response.status}. Falling back to direct origin.`);
    } catch (err: any) {
      this.logger.warn(`Primary fetch for ${url} failed (${err.message || err}). Falling back to direct origin.`);
    }

    const directUrl = this.toRealOriginUrl(url);
    const directRes = await fetch(directUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!directRes.ok) {
      throw new Error(`HTTP ${directRes.status}: ${directRes.statusText} on ${directUrl}`);
    }

    return directRes.text();
  }

  private extractMangaSlug(url: string): string {
    const parts = url.replace(/\/$/, '').split('/').filter(Boolean);
    const idx = parts.lastIndexOf('manga');
    if (idx !== -1 && idx < parts.length - 1) {
      return parts[idx + 1];
    }
    return parts[parts.length - 1] || 'manga';
  }

  private toProxyUrl(realUrl: string): string {
    let path = realUrl.replace(/^https?:\/\/(www\.)?leercapitulo\.co/, '');
    if (!path || path === '') path = '/';
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private toRealOriginUrl(pathOrUrl: string): string {
    if (pathOrUrl.startsWith('http')) {
      return pathOrUrl.replace(/^https?:\/\/[^\/]+/, LEERCAPITULO_ORIGIN);
    }
    return `${LEERCAPITULO_ORIGIN}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }
}
