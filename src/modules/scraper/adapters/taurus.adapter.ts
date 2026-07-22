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

const TAURUS_ORIGIN = 'https://lectortaurus.com';
const TAURUS_PROXY_DEFAULT =
  'https://mango-proxy.platformoctopus.workers.dev/taurus';

/**
 * Madara / wp-manga scraper for Lector Taurus.
 * HTML + ajax go through mango-proxy by default; DB external URLs keep the
 * real origin so readers/deeplinks stay stable.
 */
export class TaurusAdapter extends BaseScraperAdapter {
  private readonly logger = new Logger(TaurusAdapter.name);
  private scanGroupId: number | null = null;
  /** Fetch base (proxy or origin). */
  private baseUrl: string;

  constructor(
    protected db: NodePgDatabase<typeof schema>,
    protected delayMs: number = 100,
    baseUrl?: string,
  ) {
    super(db, delayMs);
    this.baseUrl =
      (baseUrl || process.env.SCRAPER_TAURUS_URL || TAURUS_PROXY_DEFAULT).replace(
        /\/$/,
        '',
      );
  }

  getName() {
    return 'Taurus';
  }

  async scrape(
    startPage = 0,
    endPage = 3,
    postsPerPage = 18,
  ): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(
      `Starting Taurus scrape: pages ${startPage}-${endPage} (${postsPerPage} items/page), baseUrl: ${this.baseUrl}`,
    );

    try {
      await this.ensureScanGroup();
      this.logger.log(`Scan group ensured: ID ${this.scanGroupId}`);

      const comicUrls = await this.getRecentComicUrls(
        startPage,
        endPage,
        postsPerPage,
      );
      this.logger.log(`Found ${comicUrls.length} comics to scrape`);

      if (comicUrls.length === 0) {
        this.logger.warn(
          `No comics found! Check Admin Ajax: ${this.baseUrl}/wp-admin/admin-ajax.php`,
        );
        result.errors.push(
          `No comics found from ${this.baseUrl}/wp-admin/admin-ajax.php`,
        );
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
      const msg = `Taurus scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    this.logger.log(
      `Taurus scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
    );
    return result;
  }

  private async ensureScanGroup(): Promise<void> {
    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'taurus'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db
      .insert(scanGroups)
      .values({
        name: 'Taurus Scan',
        slug: 'taurus',
        website: TAURUS_ORIGIN,
      })
      .returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(
    startPage: number,
    endPage: number,
    postsPerPage: number,
  ): Promise<string[]> {
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
        formData.append(
          'vars[meta_query][0][posts_per_page]',
          postsPerPage.toString(),
        );
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
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `${this.baseUrl}/`,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        this.logger.debug(`Got HTML response: ${html.length} characters`);

        const $ = cheerio.load(html);

        let foundOnPage = 0;
        const pushMangaHref = (href?: string) => {
          if (!href || !this.isMangaSeriesUrl(href)) return;
          const fetchUrl = this.toFetchUrl(href);
          if (!seen.has(fetchUrl)) {
            seen.add(fetchUrl);
            urls.push(fetchUrl);
            foundOnPage++;
          }
        };

        $('div.manga-title-badges').each((_, el) => {
          pushMangaHref(
            $(el).closest('.page-item-detail').find('a').attr('href'),
          );
        });

        if (foundOnPage === 0) {
          $('.post-title a').each((_, el) => {
            pushMangaHref($(el).attr('href'));
          });
        }

        this.logger.debug(`Page ${page}: found ${foundOnPage} comics`);

        if (foundOnPage === 0 && page === startPage) {
          this.logger.warn(
            `No comics found on first page. HTML preview: ${html.substring(0, 500)}...`,
          );
          break;
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
      comic.title = $('h1.post-title, .post-title h1, h1')
        .first()
        .text()
        .trim();
      if (!comic.title) {
        throw new Error('Could not parse comic title');
      }
    }

    this.logger.log(`Scraping comic: ${comic.title}`);

    const comicId = await this.upsertComic(comic);
    result.comics++;

    const chapterList = await this.getChapterList(url, comic.id || '');
    this.logger.log(`Found ${chapterList.length} chapters for ${comic.title}`);

    for (const chapterItem of chapterList) {
      try {
        const chapter = await this.scrapeChapter(chapterItem.url, chapterItem);
        if (chapter.pages.length > 0 && chapter.chapterNumber > 0) {
          await this.upsertChapter(comicId, chapter, chapterItem);
          result.chapters++;
        } else if (chapter.pages.length > 0) {
          this.logger.warn(
            `Skipping chapter with unresolved number 0: ${chapterItem.url}`,
          );
        }
        await this.delay(40);
      } catch (error) {
        this.logger.warn(`Failed to scrape chapter ${chapterItem.url}: ${error}`);
      }
    }
  }

  private parseComicFromHtml($: cheerio.CheerioAPI, url: string): ScrapedComic {
    // Live Madara dropped `.summary-layout-1`; keep both for compatibility.
    const layout = $('.profile-manga.summary-layout-1').length
      ? $('.profile-manga.summary-layout-1')
      : $('.profile-manga');

    layout.find('.post-title span').remove();
    let title = layout.find('.post-title').first().text().trim();
    if (!title) {
      title = $('h1.post-title, .post-title h1, h1').first().text().trim();
    }

    const description =
      $('.description-summary p').text().trim() ||
      $('.description-summary').text().trim();

    const statusText = layout
      .find('.post-status .post-content_item:nth-child(2) .summary-content')
      .text()
      .toLowerCase()
      .trim();
    const statusMap: Record<string, ScrapedComic['status']> = {
      ongoing: 'ongoing',
      'en curso': 'ongoing',
      activo: 'ongoing',
      completado: 'completed',
      completed: 'completed',
      pausado: 'hiatus',
      hiatus: 'hiatus',
      cancelado: 'cancelled',
      cancelled: 'cancelled',
    };
    const status = statusMap[statusText] || 'ongoing';

    let typeText = layout
      .find('.post-content .post-content_item:contains("Type") .summary-content')
      .text()
      .toLowerCase()
      .trim();
    if (!typeText) {
      typeText = layout
        .find('.post-content .post-content_item:nth-child(7) .summary-content')
        .text()
        .toLowerCase()
        .trim();
    }

    // Type often appears as a genre chip (Manhwa/Manhua/Manga) on newer layouts.
    if (!typeText || !['manga', 'manhwa', 'manhua', 'webtoon', 'comic'].includes(typeText)) {
      const genreHints = this.collectGenreLabels($).map((g) => g.toLowerCase());
      typeText =
        genreHints.find((g) =>
          ['manga', 'manhwa', 'manhua', 'webtoon', 'comic'].includes(g),
        ) || typeText;
    }

    const typeMap: Record<string, ScrapedComic['type']> = {
      manga: 'manga',
      manhwa: 'manhwa',
      manhua: 'manhua',
      webtoon: 'manhwa',
      comic: 'comic',
    };
    const type = typeMap[typeText] || 'manga';

    // Header chip is often only the primary genre; full list is in description tabs.
    const genresList = this.collectGenreLabels($).map((g) => g.toUpperCase());

    let coverImage =
      layout.find('.summary_image img').attr('data-src') ||
      layout.find('.summary_image img').attr('src') ||
      '';
    if (coverImage && !coverImage.startsWith('http')) {
      coverImage = this.joinUrl(TAURUS_ORIGIN, coverImage);
    } else if (coverImage) {
      // Prefer absolute CDN/origin URLs in DB, not the proxy host.
      coverImage = this.toOriginAssetUrl(coverImage);
    }

    const slug = this.extractSlugFromUrl(url);

    const postId =
      $('#manga-chapters-holder').attr('data-id') ||
      $('link[rel="shortlink"]').attr('href')?.split('=')[1] ||
      '';

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
        name: 'Taurus Scan',
      },
    };
  }

  /** Pick the richest `.genres-content` block (deduped). */
  private collectGenreLabels($: cheerio.CheerioAPI): string[] {
    const buckets: string[][] = [];
    $('.genres-content').each((_, box) => {
      const bucket: string[] = [];
      $(box)
        .find('a')
        .each((__, el) => {
          const genre = $(el).text().trim();
          if (genre) bucket.push(genre);
        });
      if (bucket.length) buckets.push(bucket);
    });
    buckets.sort((a, b) => b.length - a.length);
    return [...new Set(buckets[0] || [])];
  }

  /** Madara archive also emits /manga-genre/ links next to titles — skip those. */
  private isMangaSeriesUrl(url: string): boolean {
    try {
      const path = new URL(url, TAURUS_ORIGIN).pathname.replace(/\/$/, '');
      if (/\/manga-genre\//i.test(path)) return false;
      return /^\/manga\/[^/]+$/i.test(path);
    } catch {
      return false;
    }
  }

  private async getChapterList(
    comicUrl: string,
    postId: string,
  ): Promise<ChapterListItem[]> {
    const allChapters: ChapterListItem[] = [];

    const ajaxChaptersUrl = `${comicUrl.replace(/\/$/, '')}/ajax/chapters/`;
    try {
      this.logger.debug(
        `Fetching chapters for ${comicUrl} from ${ajaxChaptersUrl} with postId ${postId}`,
      );
      let html = '';
      if (postId) {
        const formData = new URLSearchParams();
        formData.append('action', 'manga_get_chapters');
        formData.append('manga', postId);

        const ajaxUrl = `${this.baseUrl}/wp-admin/admin-ajax.php`;
        const response = await fetch(ajaxUrl, {
          method: 'POST',
          body: formData,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: comicUrl,
          },
        });
        if (response.ok) {
          html = await response.text();
        }
      }

      if (!html || html.length < 50 || html.trim() === '0') {
        const response = await fetch(ajaxChaptersUrl, {
          method: 'POST',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Referer: comicUrl,
          },
        });
        if (response.ok) {
          html = await response.text();
        }
      }

      if (!html || html.trim() === '0') {
        html = await this.fetchHtml(comicUrl);
      }

      const $ = cheerio.load(html);

      $('.wp-manga-chapter').each((_, el) => {
        // Theme wraps date/likes in extra <a> tags — pick the real chapter link.
        let aTag = $(el)
          .find('a[href*="/capitulo-"], a[href*="/chapter-"]')
          .first();
        if (!aTag.length) {
          aTag = $(el)
            .find('a')
            .filter((_, a) => {
              const text = $(a).text().trim();
              return /capitulo|capítulo|chapter|cap\.?\s*\d/i.test(text);
            })
            .first();
        }

        const href = aTag.attr('href') || '';
        const title = aTag.text().trim();
        const releaseDateStr = $(el)
          .find('.chapter-release-date i')
          .text()
          .trim();

        let releaseDate: Date | undefined;
        if (releaseDateStr) {
          releaseDate = new Date();
        }

        if (href && title) {
          const fetchUrl = this.toFetchUrl(href);
          const number =
            this.extractChapterNumber(title) ||
            this.extractChapterNumber(href) ||
            '0';
          allChapters.push({
            id: this.extractSlugFromUrl(href),
            title,
            number,
            url: fetchUrl,
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

  private async scrapeChapter(
    chapterUrl: string,
    listItem?: ChapterListItem,
  ): Promise<ScrapedChapter> {
    const html = await this.fetchHtml(chapterUrl);
    const $ = cheerio.load(html);

    // Reader pages often omit #chapter-heading / h1 — never trust that alone.
    const titleFull =
      $('#chapter-heading').text().trim() ||
      $('h1').text().trim() ||
      listItem?.title ||
      '';

    const chapterNumber = this.resolveChapterNumber(
      listItem?.number,
      titleFull,
      chapterUrl,
      listItem?.url,
    );

    const pages: string[] = [];
    const seenUrls = new Set<string>();

    $(
      '.page-break.no-gaps img.wp-manga-chapter-img, .reading-content img',
    ).each((_, el) => {
      let src = $(el).attr('data-src') || $(el).attr('src') || '';
      src = src.trim();
      if (!src) return;

      src = this.toOriginAssetUrl(this.joinUrl(TAURUS_ORIGIN, src));

      if (!seenUrls.has(src)) {
        seenUrls.add(src);
        pages.push(src);
      }
    });

    return {
      chapterNumber,
      title: titleFull || listItem?.title,
      slug: this.extractSlugFromUrl(chapterUrl),
      pages,
    };
  }

  /** Prefer list number / URL slug — reader headings are often empty on Taurus. */
  private resolveChapterNumber(...candidates: Array<string | undefined>): number {
    for (const raw of candidates) {
      if (!raw) continue;
      const parsed = parseFloat(this.extractChapterNumber(raw));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  private async upsertComic(comic: ScrapedComic): Promise<number> {
    const externalUrl = `${TAURUS_ORIGIN}/manga/${comic.slug}/`;

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
      const updates: Record<string, unknown> = { updatedAt: new Date() };

      if (
        comic.description &&
        comic.description.length > (existing.description?.length || 0)
      ) {
        updates.description = comic.description;
      }
      if (
        comic.coverImage &&
        existing.coverImage &&
        comic.coverImage !== existing.coverImage
      ) {
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
      const existingBySlug = await this.db.query.comics.findFirst({
        where: eq(comics.slug, comic.slug),
      });

      if (existingBySlug) {
        const updates: Record<string, unknown> = { updatedAt: new Date() };

        if (
          comic.description &&
          comic.description.length > (existingBySlug.description?.length || 0)
        ) {
          updates.description = comic.description;
        }
        if (
          comic.coverImage &&
          existingBySlug.coverImage &&
          comic.coverImage !== existingBySlug.coverImage
        ) {
          const isFailing = await this.checkImageFailing(
            existingBySlug.coverImage,
          );
          if (isFailing) {
            updates.coverImage = comic.coverImage;
            this.logger.debug(
              `Replaced failing cover image for ${comic.title}`,
            );
          }
        } else if (comic.coverImage && !existingBySlug.coverImage) {
          updates.coverImage = comic.coverImage;
        }

        await this.db
          .update(comics)
          .set(updates)
          .where(eq(comics.id, existingBySlug.id));
        comicId = existingBySlug.id;
      } else {
        const [created] = await this.db
          .insert(comics)
          .values({
            title: comic.title,
            slug: comic.slug,
            description: comic.description,
            coverImage: comic.coverImage,
            type: comic.type === 'comic' ? 'manga' : comic.type,
            status: comic.status,
          })
          .returning();
        comicId = created.id;
      }
    }

    await this.ensureComicScan(comicId, comic);
    await this.syncGenres(comicId, comic.genres);

    return comicId;
  }

  private async ensureComicScan(
    comicId: number,
    comic: ScrapedComic,
  ): Promise<number> {
    const existing = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (existing) return existing.id;

    const externalUrl = `${TAURUS_ORIGIN}/manga/${comic.slug}/`;

    const [created] = await this.db
      .insert(comicScans)
      .values({
        comicId,
        scanGroupId: this.scanGroupId!,
        externalUrl,
        language: 'es',
      })
      .returning();

    return created.id;
  }

  private async syncGenres(
    comicId: number,
    genreNames: string[],
  ): Promise<void> {
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
        const [created] = await this.db
          .insert(genres)
          .values({
            name: name.charAt(0) + name.slice(1).toLowerCase(),
            slug,
          })
          .returning();
        genre = created;
      }

      await this.db
        .insert(comicGenres)
        .values({
          comicId,
          genreId: genre.id,
        })
        .onConflictDoNothing();
    }

    await this.db
      .update(comics)
      .set({
        isNsfw: hasAdultGenre,
      })
      .where(eq(comics.id, comicId));
  }

  private async upsertChapter(
    comicId: number,
    chapter: ScrapedChapter,
    listItem: ChapterListItem,
  ): Promise<void> {
    const comicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (!comicScan) return;

    const existing = await this.db.query.chapters.findFirst({
      where: and(
        eq(chapters.comicScanId, comicScan.id),
        eq(chapters.chapterNumber, chapter.chapterNumber),
      ),
    });

    if (existing) {
      await this.db
        .update(chapters)
        .set({
          urlPages: chapter.pages,
          slug: chapter.slug,
          updatedAt: new Date(),
        })
        .where(eq(chapters.id, existing.id));
    } else {
      await this.db
        .insert(chapters)
        .values({
          comicScanId: comicScan.id,
          chapterNumber: chapter.chapterNumber,
          title: chapter.title || listItem.title,
          slug: chapter.slug,
          releaseDate: listItem.releaseDate,
          urlPages: chapter.pages,
        })
        .onConflictDoNothing();
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetch(this.toFetchUrl(url), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: `${this.baseUrl}/`,
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.text();
  }

  /** Rewrite lectortaurus absolute URLs onto the configured fetch base (proxy). */
  private toFetchUrl(url: string): string {
    if (!url) return '';
    try {
      const parsed = new URL(url, TAURUS_ORIGIN);
      if (
        parsed.hostname === 'lectortaurus.com' ||
        parsed.hostname.endsWith('.lectortaurus.com')
      ) {
        return `${this.baseUrl}${parsed.pathname}${parsed.search}`;
      }
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
      }
    } catch {
      // fall through
    }
    return this.joinUrl(this.baseUrl, url);
  }

  /** Keep page/cover assets on the public origin (not the proxy host). */
  private toOriginAssetUrl(url: string): string {
    if (!url) return '';
    try {
      const parsed = new URL(url, TAURUS_ORIGIN);
      if (parsed.hostname.includes('platformoctopus.workers.dev')) {
        const path = parsed.pathname.replace(/^\/taurus/, '') || '/';
        return `${TAURUS_ORIGIN}${path}${parsed.search}`;
      }
      return parsed.toString();
    } catch {
      return this.joinUrl(TAURUS_ORIGIN, url);
    }
  }

  private extractSlugFromUrl(url: string): string {
    const parts = url.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || '';
  }

  private extractChapterNumber(title: string): string {
    const normalized = title
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const match = normalized.match(
      /(?:capitulo|chapter|cap|ch)[\s\-_]*([0-9]+(?:\.[0-9]+)?)/i,
    );
    if (match) return match[1];

    // URL path: .../capitulo-39/ or .../chapter-12/
    const pathMatch = normalized.match(
      /\/(?:capitulo|chapter|cap|ch)[\s\-_]*([0-9]+(?:\.[0-9]+)?)/i,
    );
    if (pathMatch) return pathMatch[1];

    const numMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)/);
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
