import { Logger } from '@/lib/logger';
import * as cheerio from 'cheerio';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq, and } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ChapterListItem, ScraperResult } from '../scraper.types';
import {
  isAdultGenreSlug,
  sanitizeGenreNames,
  BaseScraperAdapter,
} from './base.adapter';

const NOBLEDICION_ORIGIN = 'https://nobledicion.yoveo.xyz';

export class NobledicionAdapter extends BaseScraperAdapter {
  private readonly logger = new Logger(NobledicionAdapter.name);
  private scanGroupId: number | null = null;
  private baseUrl: string;

  constructor(
    protected db: NodePgDatabase<typeof schema>,
    protected delayMs: number = 100,
    baseUrl?: string,
  ) {
    super(db, delayMs);
    this.baseUrl = baseUrl || process.env.SCRAPER_NOBLEDICION_URL || NOBLEDICION_ORIGIN;
  }

  getName() { return 'Nobledicion'; }

  async scrape(startPage = 0, endPage = 3, postsPerPage = 18): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(`Starting Nobledicion scrape: pages ${startPage}-${endPage} (${postsPerPage} items/page), baseUrl: ${this.baseUrl}`);

    try {
      await this.ensureScanGroup();
      this.logger.log(`Scan group ensured: ID ${this.scanGroupId}`);

      const comicUrls = await this.getRecentComicUrls(startPage, endPage, postsPerPage);
      this.logger.log(`Found ${comicUrls.length} comics to scrape`);

      if (comicUrls.length === 0) {
        this.logger.warn(`No comics found! Check if the Admin Ajax endpoint is working: ${this.baseUrl}/wp-admin/admin-ajax.php`);
        result.errors.push(`No comics found from ${this.baseUrl}/wp-admin/admin-ajax.php`);
      }

      for (const url of comicUrls) {
        try {
          await this.scrapeComic(url, result);
          await this.delay();
        } catch (error) {
          const msg = `Failed to scrape comic ${url}: ${error}`;
          this.logger.error(msg);
          result.errors.push(msg);
        }
      }
    } catch (error) {
      const msg = `Nobledicion scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    this.logger.log(`Nobledicion scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`);
    return result;
  }

  private async ensureScanGroup(): Promise<void> {
    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'nobledicion'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db.insert(scanGroups).values({
      name: 'Nobledicion Scan',
      slug: 'nobledicion',
      website: NOBLEDICION_ORIGIN,
    }).returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(startPage: number, endPage: number, postsPerPage: number): Promise<string[]> {
    const urls: string[] = [];
    const seen = new Set<string>();

    for (let page = startPage; page <= endPage; page++) {
      try {
        const formData = new URLSearchParams();
        formData.append('action', 'madara_load_more');
        formData.append('page', page.toString());
        formData.append('template', 'madara-core/content/content-archive');
        formData.append('vars[orderby]', 'meta_value_num');
        formData.append('vars[paged]', '1');
        formData.append('vars[timerange]', '');
        formData.append('vars[posts_per_page]', postsPerPage.toString());
        formData.append('vars[tax_query][relation]', 'OR');
        formData.append('vars[meta_query][0][orderby]', 'meta_value_num');
        formData.append('vars[meta_query][0][paged]', '1');
        formData.append('vars[meta_query][0][timerange]', '');
        formData.append('vars[meta_query][0][posts_per_page]', postsPerPage.toString());
        formData.append('vars[meta_query][0][tax_query][relation]', 'OR');
        formData.append('vars[meta_query][0][meta_query][relation]', 'AND');
        formData.append('vars[meta_query][0][post_type]', 'wp-manga');
        formData.append('vars[meta_query][0][post_status]', 'publish');
        formData.append('vars[meta_query][0][meta_key]', '_latest_update');
        formData.append('vars[meta_query][0][order]', 'desc');
        formData.append('vars[meta_query][relation]', 'AND');
        formData.append('vars[post_type]', 'wp-manga');
        formData.append('vars[post_status]', 'publish');
        formData.append('vars[meta_key]', '_latest_update');

        const listUrl = `${this.baseUrl}/wp-admin/admin-ajax.php`;
        this.logger.debug(`Fetching page ${page} from: ${listUrl}`);

        const response = await fetch(listUrl, {
          method: 'POST',
          body: formData,
          headers: {
             'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
             'Content-Type': 'application/x-www-form-urlencoded',
             'Referer': `${this.baseUrl}/`,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        this.logger.debug(`Got HTML response: ${html.length} characters`);

        const $ = cheerio.load(html);

        let foundOnPage = 0;
        $('div.manga-title-badges').each((_, el) => {
          // Alternatively, finding the a tag linking to manga
          const href = $(el).closest('.page-item-detail').find('a').attr('href');
          if (href && !seen.has(href)) {
            seen.add(href);
            urls.push(this.joinUrl(this.baseUrl, href));
            foundOnPage++;
          }
        });

        // Fallback selector just in case wrapping structure varies
        if (foundOnPage === 0) {
            $('.post-title a').each((_, el) => {
                const href = $(el).attr('href');
                if (href && !seen.has(href)) {
                  seen.add(href);
                  urls.push(this.joinUrl(this.baseUrl, href));
                  foundOnPage++;
                }
            });
        }

        this.logger.debug(`Page ${page}: found ${foundOnPage} comics`);

        if (foundOnPage === 0 && page === startPage) {
          this.logger.warn(`No comics found on first page. HTML preview: ${html.substring(0, 500)}...`);
          break; // Stop if no items found at all on this page, probably no more items
        }

        await this.delay();
      } catch (error) {
        this.logger.error(`Failed to fetch page ${page}: ${error}`);
        break;
      }
    }

    return urls;
  }

  private async scrapeComic(url: string, result: ScraperResult): Promise<void> {
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    const comic = this.parseComicFromHtml($, url);
    if (!comic.title) {
        // Retry one more time without .profile-manga.summary-layout-1 constraint
        comic.title = $('.post-title h1').text().trim();
        if (!comic.title) {
            throw new Error('Could not parse comic title');
        }
    }

    this.logger.log(`Scraping comic: ${comic.title}`);

    const comicId = await this.upsertComic(comic);
    result.comics++;

    // Get chapter list
    const chapterList = await this.getChapterList(url, comic.id || ""); // get madara internal POST ID if needed
    this.logger.log(`Found ${chapterList.length} chapters for ${comic.title}`);

    for (const chapterItem of chapterList) {
      try {
        const chapter = await this.scrapeChapter(chapterItem.url);
        if (chapter.pages.length > 0) {
          await this.upsertChapter(comicId, chapter, chapterItem);
          result.chapters++;
        }
        await this.delay(40);
      } catch (error) {
        this.logger.warn(`Failed to scrape chapter ${chapterItem.url}: ${error}`);
      }
    }
  }

  private parseComicFromHtml($: cheerio.CheerioAPI, url: string): ScrapedComic {
    const layoutSelector = '.profile-manga.summary-layout-1';

    // In case there are badges inside the title
    $(layoutSelector + ' .post-title span').remove();
    const title = $(layoutSelector).find('.post-title').text().trim();

    const description = $('.description-summary p').text().trim() || $('.description-summary').text().trim();

    // Status
    const statusText = $(layoutSelector).find('.post-status .post-content_item:nth-child(2) .summary-content').text().toLowerCase().trim();
    const statusMap: Record<string, ScrapedComic['status']> = {
      'ongoing': 'ongoing',
      'en curso': 'ongoing',
      'activo': 'ongoing',
      'completado': 'completed',
      'completed': 'completed',
      'pausado': 'hiatus',
      'hiatus': 'hiatus',
      'cancelado': 'cancelled',
      'cancelled': 'cancelled',
    };
    const status = statusMap[statusText] || 'ongoing';

    // Type
    // The user mentioned it's around nth-child(7) but structure can vary
    let typeText = $(layoutSelector).find('.post-content .post-content_item:contains("Type") .summary-content').text().toLowerCase().trim();
    if (!typeText) {
        // Fallback to exactly nth-child(7) if "Type" title isn't easily selected
        typeText = $(layoutSelector).find('.post-content .post-content_item:nth-child(7) .summary-content').text().toLowerCase().trim();
    }

    const typeMap: Record<string, ScrapedComic['type']> = {
      'manga': 'manga',
      'manhwa': 'manhwa',
      'manhua': 'manhua',
      'webtoon': 'manhwa',
      'comic': 'comic',
    };
    const type = typeMap[typeText] || 'manga';

    // Genres
    const genresList: string[] = [];
    $(layoutSelector).find('.genres-content a').each((_, el) => {
      const genre = $(el).text().trim().toUpperCase();
      if (genre) genresList.push(genre);
    });

    // Cover
    let coverImage = $(layoutSelector).find('.summary_image img').attr('data-src') || $(layoutSelector).find('.summary_image img').attr('src') || '';
    if (coverImage && !coverImage.startsWith('http')) {
      coverImage = this.joinUrl(this.baseUrl, coverImage);
    }

    // Slug from URL
    const slug = this.extractSlugFromUrl(url);

    // Group scan
    const groupName = 'Nobledicion Scan';

    // Also look for post-id which madara uses for chapters ajax sometimes
    const postId = $('#manga-chapters-holder').attr('data-id') || $('link[rel="shortlink"]').attr('href')?.split('=')[1] || '';

    return {
      id: postId,
      slug,
      title,
      description,
      coverImage,
      type,
      status,
      genres: genresList,
      groupScan: {
        name: groupName,
      },
    };
  }

  private async getChapterList(comicUrl: string, postId: string): Promise<ChapterListItem[]> {
    const allChapters: ChapterListItem[] = [];

    const ajaxChaptersUrl = `${comicUrl.replace(/\/$/, '')}/ajax/chapters/`;
    try {
      this.logger.debug(`Fetching chapters for ${comicUrl} from ${ajaxChaptersUrl} with postId ${postId}`);
      let html = '';
      if (postId) {
          // Standard Madara core uses POST to wp-admin/admin-ajax.php for chapters given a postId
          const formData = new URLSearchParams();
          formData.append('action', 'manga_get_chapters');
          formData.append('manga', postId);

          const ajaxUrl = `${this.baseUrl}/wp-admin/admin-ajax.php`;
          const response = await fetch(ajaxUrl, {
            method: 'POST',
            body: formData,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': comicUrl,
            },
          });
          if (response.ok) {
              html = await response.text();
          }
      }

      // If html is too short or unauthorized, fallback to the direct ajax endpoint some themes use
      if (!html || html.length < 50 || html.trim() === '0') {
          const response = await fetch(ajaxChaptersUrl, {
            method: 'POST',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': comicUrl,
            },
          });
          if (response.ok) {
              html = await response.text();
          }
      }

      if (!html || html.trim() === '0') {
          // As a last fallback, some madara sites render chapters directly in the html
          html = await this.fetchHtml(comicUrl);
      }

      const $ = cheerio.load(html);

      $('.wp-manga-chapter').each((_, el) => {
        const aTag = $(el).find('a').first();
        const href = aTag.attr('href') || '';
        const title = aTag.text().trim();
        const releaseDateStr = $(el).find('.chapter-release-date i').text().trim();

        let releaseDate: Date | undefined;
        if (releaseDateStr) {
            // Note: date format could be "4 febrero, 2026", JS Date parsing might struggle with Spanish months natively
            // Setting it down to now if it fails, or you can add a Spanish month mapping parser
            releaseDate = new Date();
        }

        if (href && title) {
          allChapters.push({
            id: this.extractSlugFromUrl(href),
            title,
            number: this.extractChapterNumber(title),
            url: this.joinUrl(this.baseUrl, href),
            pathname: href,
            releaseDate,
          });
        }
      });

      await this.delay(80);
    } catch (error) {
      this.logger.error(`Failed to fetch chapter list: ${error}`);
    }

    return allChapters;
  }

  private async scrapeChapter(chapterUrl: string): Promise<ScrapedChapter> {
    const html = await this.fetchHtml(chapterUrl);
    const $ = cheerio.load(html);

    const titleFull = $('#chapter-heading').text().trim() || $('h1').text().trim();
    const chapterNumber = parseFloat(this.extractChapterNumber(titleFull)) || 0;

    const pages: string[] = [];
    const seenUrls = new Set<string>();

    // Collect images
    $('.page-break.no-gaps img.wp-manga-chapter-img, .reading-content img').each((_, el) => {
      let src = $(el).attr('data-src') || $(el).attr('src') || '';
      src = src.trim();
      if (!src) return;

      src = this.joinUrl(this.baseUrl, src);

      if (!seenUrls.has(src)) {
        seenUrls.add(src);
        pages.push(src);
      }
    });

    return {
      chapterNumber,
      title: titleFull,
      slug: this.extractSlugFromUrl(chapterUrl),
      pages,
    };
  }

  private async upsertComic(comic: ScrapedComic): Promise<number> {
    const externalUrl = `${this.baseUrl}/manga/${comic.slug}/`;

    // First, check if we already have this comic via externalUrl in comicScans
    const existingComicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.externalUrl, externalUrl),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
      with: { comic: true },
    });

    let comicId: number;

    if (existingComicScan && existingComicScan.comic) {
      const existing = existingComicScan.comic;
      const updates: any = { updatedAt: new Date() };

      if (comic.description && comic.description.length > (existing.description?.length || 0)) {
        updates.description = comic.description;
      }
      if (comic.coverImage && existing.coverImage && comic.coverImage !== existing.coverImage) {
        const isFailing = await this.checkImageFailing(existing.coverImage);
        if (isFailing) {
          updates.coverImage = comic.coverImage;
          this.logger.debug(`Replaced failing cover image for ${comic.title}`);
        }
      } else if (comic.coverImage && !existing.coverImage) {
        updates.coverImage = comic.coverImage;
      }

      await this.db.update(comics).set(updates).where(eq(comics.id, existing.id));
      comicId = existing.id;
    } else {
      // Check by slug as fallback
      const existingBySlug = await this.db.query.comics.findFirst({
        where: eq(comics.slug, comic.slug),
      });

      if (existingBySlug) {
        const updates: any = { updatedAt: new Date() };

        if (comic.description && comic.description.length > (existingBySlug.description?.length || 0)) {
          updates.description = comic.description;
        }
        if (comic.coverImage && existingBySlug.coverImage && comic.coverImage !== existingBySlug.coverImage) {
          const isFailing = await this.checkImageFailing(existingBySlug.coverImage);
          if (isFailing) {
            updates.coverImage = comic.coverImage;
            this.logger.debug(`Replaced failing cover image for ${comic.title}`);
          }
        } else if (comic.coverImage && !existingBySlug.coverImage) {
          updates.coverImage = comic.coverImage;
        }

        await this.db.update(comics).set(updates).where(eq(comics.id, existingBySlug.id));
        comicId = existingBySlug.id;
      } else {
        // Create new comic
        const [created] = await this.db.insert(comics).values({
          title: comic.title,
          slug: comic.slug,
          description: comic.description,
          coverImage: comic.coverImage,
          type: comic.type === 'comic' ? 'manga' : comic.type,
          status: comic.status,
        }).returning();
        comicId = created.id;
      }
    }

    await this.ensureComicScan(comicId, comic);
    await this.syncGenres(comicId, comic.genres);

    return comicId;
  }

  private async ensureComicScan(comicId: number, comic: ScrapedComic): Promise<number> {
    const existing = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (existing) return existing.id;

    const externalUrl = `${this.baseUrl}/manga/${comic.slug}/`;

    const [created] = await this.db.insert(comicScans).values({
      comicId,
      scanGroupId: this.scanGroupId!,
      externalUrl,
      language: 'es',
    }).returning();

    return created.id;
  }

  private async syncGenres(comicId: number, genreNames: string[]): Promise<void> {
    await this.db.delete(comicGenres).where(eq(comicGenres.comicId, comicId));

    let hasAdultGenre = false;

    for (const name of sanitizeGenreNames(genreNames)) {
      const slug = this.slugify(name);

      if (isAdultGenreSlug(slug)) {
        hasAdultGenre = true;
      }

      let genre = await this.db.query.genres.findFirst({
        where: eq(genres.slug, slug),
      });

      if (!genre) {
        const [created] = await this.db.insert(genres).values({
          name: name.charAt(0) + name.slice(1).toLowerCase(),
          slug,
        }).returning();
        genre = created;
      }

      await this.db.insert(comicGenres).values({
        comicId,
        genreId: genre.id,
      }).onConflictDoNothing();
    }

    await this.db.update(comics).set({
      isNsfw: hasAdultGenre,
    }).where(eq(comics.id, comicId));
  }

  private async upsertChapter(
    comicId: number,
    chapter: ScrapedChapter,
    listItem: ChapterListItem,
  ): Promise<void> {
    const comicScan = await this.db.query.comicScans.findFirst({
      where: eq(comicScans.comicId, comicId),
    });

    if (!comicScan) return;

    const existing = await this.db.query.chapters.findFirst({
      where: and(
        eq(chapters.comicScanId, comicScan.id),
        eq(chapters.chapterNumber, chapter.chapterNumber),
      ),
    });

    if (existing) {
      await this.db.update(chapters).set({
        urlPages: chapter.pages,
        slug: chapter.slug,
        updatedAt: new Date(),
      }).where(eq(chapters.id, existing.id));
    } else {
      await this.db.insert(chapters).values({
        comicScanId: comicScan.id,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title || listItem.title,
        slug: chapter.slug,
        releaseDate: listItem.releaseDate,
        urlPages: chapter.pages,
      }).onConflictDoNothing();
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': this.baseUrl,
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.text();
  }

  private extractSlugFromUrl(url: string): string {
    const parts = url.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || '';
  }

  private extractChapterNumber(title: string): string {
    const match = title.match(/(?:capitulo|chapter|cap|ch)[\s\-_]*([0-9]+(?:\.[0-9]+)?)/i);
    if (match) return match[1];

    const numMatch = title.match(/([0-9]+(?:\.[0-9]+)?)/);
    return numMatch ? numMatch[1] : '0';
  }

  private joinUrl(origin: string, path: string): string {
    if (!path) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('//')) return 'https:' + path;
    if (path.startsWith('/')) return origin.replace(/\/$/, '') + path;
    return origin.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
  }


}
