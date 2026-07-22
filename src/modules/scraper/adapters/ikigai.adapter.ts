import { Logger } from '@/lib/logger';
import * as cheerio from 'cheerio';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq, and, ne, sql } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ChapterListItem, ScraperResult } from '../scraper.types';
import {
  isAdultGenreSlug,
  sanitizeGenreNames,
  BaseScraperAdapter,
} from './base.adapter';

const IKIGAI_ORIGIN = 'https://ikigaimangas.com';
const IKIGAI_MEDIA = 'https://media.ikigaimangas.cloud';

export class IkigaiAdapter extends BaseScraperAdapter {
  private readonly logger = new Logger(IkigaiAdapter.name);
  private scanGroupId: number | null = null;
  private baseUrl: string;

  constructor(
    protected db: NodePgDatabase<typeof schema>,
    protected delayMs: number = 100,
    baseUrl?: string,
  ) {
    super(db, delayMs);
    this.baseUrl = baseUrl || process.env.SCRAPER_IKIGAI_URL || IKIGAI_ORIGIN;
  }

  getName() { return 'Ikigai'; }

  async scrape(startPage = 1, endPage = 10): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(`Starting Ikigai scrape: pages ${startPage}-${endPage}, baseUrl: ${this.baseUrl}`);

    try {
      await this.ensureSourceScanGroup();
      this.logger.log(`Fallback scan group ensured: ID ${this.scanGroupId}`);

      const comicUrls = await this.getRecentComicUrls(startPage, endPage);
      this.logger.log(`Found ${comicUrls.length} comics to scrape`);

      if (comicUrls.length === 0) {
        this.logger.warn(`No comics found! Check if the URL is working: ${this.baseUrl}/series/`);
        result.errors.push(`No comics found from ${this.baseUrl}/series/`);
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
      const msg = `Ikigai scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    this.logger.log(`Ikigai scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`);
    return result;
  }

  private async ensureSourceScanGroup(): Promise<void> {
    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'ikigai'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db.insert(scanGroups).values({
      name: 'Ikigai Mangas',
      slug: 'ikigai',
      website: IKIGAI_ORIGIN,
    }).returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(startPage: number, endPage: number): Promise<string[]> {
    const urls: string[] = [];
    const seen = new Set<string>();

    for (let page = startPage; page <= endPage; page++) {
      try {
        const listUrl = `${this.baseUrl}/series/?tipos[]=comic&direccion=desc&ordenar=last_chapter_date&pagina=${page}`;
        this.logger.debug(`Fetching page ${page}: ${listUrl}`);

        const html = await this.fetchHtml(listUrl);
        this.logger.debug(`Got HTML response: ${html.length} characters`);

        const $ = cheerio.load(html);

        let foundOnPage = 0;
        $('section > ul > li').each((_, el) => {
          const chaptersTotal = $(el).find('a ul li:nth-child(1) span:nth-child(2)').text().trim();
          if (chaptersTotal === '0') return;

          const href = $(el).find('a').attr('href');
          if (href && !seen.has(href)) {
            seen.add(href);
            urls.push(this.joinUrl(this.baseUrl, href));
            foundOnPage++;
          }
        });

        this.logger.debug(`Page ${page}: found ${foundOnPage} comics`);

        if (foundOnPage === 0 && page === startPage) {
          // Log the HTML structure to help debug selector issues
          this.logger.warn(`No comics found on first page. HTML preview: ${html.substring(0, 500)}...`);
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
      throw new Error('Could not parse comic title');
    }

    this.logger.log(`Scraping comic: ${comic.title}`);

    const { comicScanId } = await this.upsertComic(comic);
    result.comics++;

    // Get chapter list
    const chapterList = await this.getChapterList(url);
    this.logger.log(`Found ${chapterList.length} chapters for ${comic.title}`);

    for (const chapterItem of chapterList) {
      try {
        const chapter = await this.scrapeChapter(chapterItem.url);
        if (chapter.pages.length > 0) {
          await this.upsertChapter(comicScanId, chapter, chapterItem);
          result.chapters++;
        }
        await this.delay(40);
      } catch (error) {
        this.logger.warn(`Failed to scrape chapter ${chapterItem.url}: ${error}`);
      }
    }
  }

  private parseComicFromHtml($: cheerio.CheerioAPI, url: string): ScrapedComic {
    const title = $('div div article div h1').first().text().trim();
    const description = $('div div article div p').first().text().trim();

    // Status
    const statusText = $('div article figure ul li:nth-child(2)').text().toLowerCase().trim();
    const statusMap: Record<string, ScrapedComic['status']> = {
      'en curso': 'ongoing',
      'activo': 'ongoing',
      'ongoing': 'ongoing',
      'completado': 'completed',
      'completed': 'completed',
      'pausado': 'hiatus',
      'hiatus': 'hiatus',
      'cancelado': 'cancelled',
      'cancelled': 'cancelled',
    };
    const status = statusMap[statusText] || 'ongoing';

    // Type
    const typeText = $('div article figure ul li:nth-child(1)').text().toLowerCase().trim();
    const typeMap: Record<string, ScrapedComic['type']> = {
      'manga': 'manga',
      'manhwa': 'manhwa',
      'manhua': 'manhua',
      'webtoon': 'manhwa',
      'comic': 'comic',
    };
    const type = typeMap[typeText] || 'manga';

    // Genres — only series genre links/badges (never related-comic cards).
    // Old selector `div div article div ul li a` pulled titles + "mil vistas".
    const genresList: string[] = [];
    const genreNodes = $('article a[href*="generos"]').length
      ? $('article a[href*="generos"]')
      : $('article .badge-accent');
    genreNodes.each((_, el) => {
      const genre = $(el).text().trim().toUpperCase();
      if (genre) genresList.push(genre);
    });

    // Cover
    let coverImage = $('div div article figure img').attr('src') || '';
    if (coverImage && !coverImage.startsWith('http')) {
      coverImage = this.joinUrl(this.baseUrl, coverImage);
    }

    // Slug from URL
    const slug = this.extractSlugFromUrl(url);

    // Group scan. Ikigai series pages expose the real scan group inside a
    // .card-body that contains a <span>Equipo de Traducción</span> badge.
    // The live HTML moved away from the old .card.bg-base-300 wrapper, so we
    // use a robust fallback chain to recover the team slug/name/cover.
    let groupLink: string | undefined;
    let groupName: string | undefined;
    let groupCover: string | undefined;

    // 1. PRIMARY: .card-body containing the "Equipo de Traducción" badge.
    const teamCardBody = $('.card-body')
      .filter((_, el) => {
        const badgeText = $(el).find('span.badge').first().text().trim().toLowerCase();
        return badgeText === 'equipo de traducción';
      })
      .first();

    if (teamCardBody.length > 0) {
      groupLink = teamCardBody.find('a[href^="/grupos/"]').first().attr('href');
      // Tag-agnostic: the site frequently changes the tag (h3 → span → div).
// Class .card-title is the stable anchor; the tag is not.
groupName = teamCardBody.find('.card-title').first().text().trim();
      groupCover = teamCardBody.find('img').first().attr('src');
    }

    // 2. No /grupos/ link but team name present -> slugify the name (handled
    //    in the groupSlug computation below).

    // 3. FALLBACK: legacy .card.bg-base-300 wrapper.
    if (!groupLink) {
      const legacyCard = $('.card.bg-base-300')
        .filter((_, el) => $(el).find('a[href^="/grupos/"]').length > 0)
        .first();
      if (legacyCard.length > 0) {
        groupLink = legacyCard.find('a[href^="/grupos/"]').first().attr('href');
        // Tag-agnostic: same rationale — .card-title class, not h3 tag.
groupName = groupName || legacyCard.find('.card-body .card-title').first().text().trim()
          || $('div article + div > div .card-title').text().trim();
        groupCover = groupCover || legacyCard.find('figure img').first().attr('src')
          || $('div article + div > figure img').attr('src');
      }
    }

    // 4. FALLBACK: any /grupos/ link on the page.
    if (!groupLink) {
      groupLink = $('a[href^="/grupos/"]').first().attr('href');
    }

    // 5. LAST RESORT: groupLink stays undefined -> ensureScanGroupForComic
    //    falls back to the generic 'ikigai' group.

    if (groupCover && !groupCover.startsWith('http')) {
      groupCover = this.joinUrl(this.baseUrl, groupCover);
    }
    const groupUrl = groupLink ? this.joinUrl(this.baseUrl, groupLink) : undefined;
    const groupSlug = groupLink
      ? this.extractSlugFromUrl(groupLink)
      : (groupName ? this.slugify(groupName) : undefined);

    // Prefer a named team whenever we have a /grupos/ slug — even if the
    // display name failed to parse (otherwise we recreate the generic ikigai scan).
    const hasTeam = Boolean(groupSlug || groupName);

    return {
      slug,
      title,
      description,
      coverImage,
      type,
      status,
      genres: genresList,
      groupScan: hasTeam
        ? {
            name: groupName || undefined,
            slug: groupSlug,
            cover: groupCover,
            url: groupUrl,
          }
        : undefined,
    };
  }

  private async getChapterList(comicUrl: string): Promise<ChapterListItem[]> {
    const allChapters: ChapterListItem[] = [];
    let page = 1;

    while (page <= 50) {
      const pageUrl = comicUrl.includes('?')
        ? `${comicUrl}&ordenar=asc&pagina=${page}`
        : `${comicUrl}?ordenar=asc&pagina=${page}`;

      try {
        const html = await this.fetchHtml(pageUrl);
        const $ = cheerio.load(html);

        const pageChapters: ChapterListItem[] = [];

        // Site markup moved: chapters live under section.card > ul.grid > li > a
        // (old path was div.w-full > section > ul.grid). Require an h3 title so
        // "Primer/Último Capítulo" shortcuts are skipped.
        $('ul.grid > li > a[href*="/capitulo/"]').each((_, el) => {
          const href = $(el).attr('href') || '';
          const title = $(el).find('h3').first().text().trim();
          if (!href || !title) return;

          const releaseDateStr =
            $(el).find('time').attr('datetime') ||
            $(el).find('time').attr('dateTime') ||
            '';

          let releaseDate: Date | undefined;
          if (releaseDateStr) {
            try {
              releaseDate = new Date(releaseDateStr);
            } catch {
              releaseDate = new Date();
            }
          }

          pageChapters.push({
            id: this.extractSlugFromUrl(href),
            title,
            number: this.extractChapterNumber(title),
            url: this.joinUrl(this.baseUrl, href),
            pathname: href,
            releaseDate,
          });
        });

        if (pageChapters.length === 0) break;
        allChapters.push(...pageChapters);

        // Check for max page
        const navLabels: string[] = [];
        $('section > div > nav > a').each((_, el) => {
          const label = $(el).attr('aria-label');
          if (label) navLabels.push(label);
        });

        if (navLabels.length > 2) {
          const lastLabel = navLabels[navLabels.length - 2];
          const match = lastLabel.match(/Página (\d+)/);
          if (match && page >= parseInt(match[1])) break;
        }

        page++;
        await this.delay(80);
      } catch (error) {
        this.logger.error(`Failed to fetch chapter list page ${page}: ${error}`);
        break;
      }
    }

    return allChapters;
  }

  private async scrapeChapter(chapterUrl: string): Promise<ScrapedChapter> {
    // Add NSFW bypass params
    let url = chapterUrl;
    if (!url.includes('forceSetNsfw=true')) {
      url += url.includes('?') ? '&forceSetNsfw=true' : '?forceSetNsfw=true';
    }
    if (!url.includes('forceSetTheme=')) {
      url += '&forceSetTheme=false';
    }

    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    const chapterName = $('div> div span.line-clamp-1').first().text().trim();
    const chapterNumText = $('div> div span.line-clamp-1 + span').text().trim();
    const chapterNumber = parseFloat(chapterNumText.replace(/[^0-9.]/g, '')) || 0;

    const pages: string[] = [];
    const seenUrls = new Set<string>();

    const pushPage = (src: string) => {
      if (!src || seenUrls.has(src)) return;
      // Reader pages: …/series/<comicId>/<chapterId>/<page>.webp
      // Skip covers, banners, and UI assets under /posts/ or thumbnail transforms.
      if (!/ikigaimangas\.cloud\/series\/\d+\/\d+\//i.test(src)) return;
      if (/\/posts\//i.test(src)) return;
      if (/rs:fill:/i.test(src)) return;
      seenUrls.add(src);
      pages.push(src);
    };

    // Legacy DOM reader (older templates).
    $('div.w-full .w-full.img img, .img img, .reader img').each((_, el) => {
      let src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src) return;

      if (src.startsWith('https://') && src.includes('ikigaimangas.cloud')) {
        // keep
      } else if (src.startsWith('/series/')) {
        src = IKIGAI_MEDIA + src;
      } else if (!src.startsWith('http')) {
        src = this.joinUrl(IKIGAI_MEDIA, src);
      }

      pushPage(src);
    });

    $('img[src*="ikigaimangas.cloud/series"]').each((_, el) => {
      pushPage($(el).attr('src') || '');
    });

    // Current Qwik reader embeds page URLs in SSR/state (image2/image3 CDNs),
    // not always as <img src>. Pull them from the raw HTML in order.
    if (pages.length === 0) {
      const re =
        /https:\/\/(?:image\d*|media)\.ikigaimangas\.cloud\/series\/\d+\/\d+\/[^"'\\\s]+/gi;
      for (const match of html.matchAll(re)) {
        pushPage(match[0]);
      }
    }

    return {
      chapterNumber,
      title: chapterName,
      slug: this.extractSlugFromUrl(chapterUrl),
      pages,
    };
  }

  private async upsertComic(comic: ScrapedComic): Promise<{ comicId: number; comicScanId: number }> {
    const externalUrl = `${IKIGAI_ORIGIN}/series/${comic.slug}`;
    let scanGroupId = await this.ensureScanGroupForComic(comic);

    // First, check if we already have this comic via externalUrl in comicScans
    // This prevents duplicates when URLs/slugs change
    let existingComicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.externalUrl, externalUrl),
        eq(comicScans.scanGroupId, scanGroupId),
      ),
      with: { comic: true },
    });

    // Migrate legacy Ikigai records that used the generic "ikigai" scan group
    // instead of the real team from /grupos/<slug>. This preserves existing
    // chapters by repointing or merging the legacy row into the real team.
    if (!existingComicScan && this.scanGroupId && scanGroupId !== this.scanGroupId) {
      const legacyComicScan = await this.db.query.comicScans.findFirst({
        where: and(
          eq(comicScans.externalUrl, externalUrl),
          eq(comicScans.scanGroupId, this.scanGroupId),
        ),
        with: { comic: true },
      });

      if (legacyComicScan?.comic) {
        const conflict = await this.db.query.comicScans.findFirst({
          where: and(
            eq(comicScans.comicId, legacyComicScan.comic.id),
            eq(comicScans.scanGroupId, scanGroupId),
          ),
        });

        if (!conflict) {
          // No real-team row yet: repoint the legacy row to the real team.
          await this.db.update(comicScans)
            .set({ scanGroupId, externalUrl })
            .where(eq(comicScans.id, legacyComicScan.id));

          existingComicScan = {
            ...legacyComicScan,
            scanGroupId,
            externalUrl,
          };
        } else {
          // A real-team row already exists for this comic. Merge: move
          // chapters from the legacy ikigai-group row into the real-team
          // row (deduping by chapterNumber against the unique index), then
          // delete the legacy row so we don't leave an orphan.
          await this.mergeComicScanChapters(legacyComicScan.id, conflict.id);
          await this.db.delete(comicScans).where(eq(comicScans.id, legacyComicScan.id));

          existingComicScan = {
            ...legacyComicScan,
            id: conflict.id,
            scanGroupId,
            externalUrl,
          };
        }
      }
    }

    // If we would fall back to the generic ikigai group, prefer any existing
    // named-team scan for the same series URL instead of creating a duplicate.
    if (
      !existingComicScan &&
      this.scanGroupId &&
      scanGroupId === this.scanGroupId
    ) {
      const namedSibling = await this.db.query.comicScans.findFirst({
        where: and(
          eq(comicScans.externalUrl, externalUrl),
          ne(comicScans.scanGroupId, this.scanGroupId),
        ),
        with: { comic: true },
      });
      if (namedSibling?.comic) {
        existingComicScan = namedSibling;
        scanGroupId = namedSibling.scanGroupId;
      }
    }

    let comicId: number;
    let comicScanId: number;

    if (existingComicScan && existingComicScan.comic) {
      const existing = existingComicScan.comic;
      const updates = this.buildComicMetadataUpdates(comic, existing);

      await this.db.update(comics).set(updates).where(eq(comics.id, existing.id));
      comicId = existing.id;
      comicScanId = existingComicScan.id;
    } else {
      // Check by slug as fallback, then same title among Ikigai comics.
      let existingComicId: number | null = null;
      let existingMeta: {
        description?: string | null;
        coverImage?: string | null;
      } | null = null;

      const bySlug = await this.db.query.comics.findFirst({
        where: eq(comics.slug, comic.slug),
        columns: { id: true, description: true, coverImage: true },
      });
      if (bySlug) {
        existingComicId = bySlug.id;
        existingMeta = bySlug;
      } else {
        const byTitle = await this.findIkigaiComicByTitle(comic.title);
        if (byTitle) {
          existingComicId = byTitle.id;
          existingMeta = byTitle;
          this.logger.debug(
            `Reusing Ikigai comic by title "${comic.title}" -> #${byTitle.id}`,
          );
        }
      }

      if (existingComicId != null && existingMeta) {
        const updates = this.buildComicMetadataUpdates(comic, existingMeta);
        await this.db.update(comics).set(updates).where(eq(comics.id, existingComicId));
        comicId = existingComicId;
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

      comicScanId = await this.ensureComicScan(comicId, comic, scanGroupId);
    }

    // Named team wins: drop leftover generic "ikigai" scans on this comic.
    if (this.scanGroupId && scanGroupId !== this.scanGroupId) {
      await this.cleanupOrphanIkigaiScans(comicId, comicScanId);
    }

    await this.syncGenres(comicId, comic.genres);

    return { comicId, comicScanId };
  }

  /** Always persist a new cover when Ikigai serves a different URL. */
  private buildComicMetadataUpdates(
    comic: ScrapedComic,
    existing: { description?: string | null; coverImage?: string | null },
  ): Record<string, unknown> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (comic.description && comic.description.length > (existing.description?.length || 0)) {
      updates.description = comic.description;
    }
    if (comic.coverImage && comic.coverImage !== existing.coverImage) {
      updates.coverImage = comic.coverImage;
      if (existing.coverImage) {
        this.logger.debug(`Updated cover image for ${comic.title}`);
      }
    }

    return updates;
  }

  private async findIkigaiComicByTitle(title: string) {
    const normalized = title.trim().toLowerCase();
    if (!normalized) return null;

    const rows = await this.db
      .select({
        id: comics.id,
        description: comics.description,
        coverImage: comics.coverImage,
      })
      .from(comics)
      .innerJoin(comicScans, eq(comicScans.comicId, comics.id))
      .where(
        and(
          sql`lower(trim(${comics.title})) = ${normalized}`,
          sql`${comicScans.externalUrl} like ${`%ikigaimangas.com/%`}`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /** Merge+delete generic ikigai comic_scans once a real team scan exists. */
  private async cleanupOrphanIkigaiScans(
    comicId: number,
    keepComicScanId: number,
  ): Promise<void> {
    if (!this.scanGroupId) return;

    const orphans = await this.db.query.comicScans.findMany({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId),
      ),
    });

    for (const orphan of orphans) {
      if (orphan.id === keepComicScanId) continue;
      await this.mergeComicScanChapters(orphan.id, keepComicScanId);
      await this.db.delete(comicScans).where(eq(comicScans.id, orphan.id));
      this.logger.log(
        `Merged orphan Ikigai scan #${orphan.id} into team scan #${keepComicScanId}`,
      );
    }
  }

  /**
   * Move all chapters from `fromComicScanId` into `toComicScanId`, deduping
   * by chapterNumber against the unique (comicScanId, chapterNumber) index.
   *
   * When a chapter with the same number already exists in the target, keep
   * the target row but adopt the source url_pages/title only if the source
   * has more pages, then delete the source chapter. Otherwise reparent the
   * source chapter by updating its comicScanId.
   */
  private async mergeComicScanChapters(fromComicScanId: number, toComicScanId: number): Promise<void> {
    const sourceChapters = await this.db.query.chapters.findMany({
      where: eq(chapters.comicScanId, fromComicScanId),
    });

    for (const src of sourceChapters) {
      const existing = await this.db.query.chapters.findFirst({
        where: and(
          eq(chapters.comicScanId, toComicScanId),
          eq(chapters.chapterNumber, src.chapterNumber),
        ),
      });

      if (existing) {
        // Same chapterNumber in target: keep target, adopt source pages if richer.
        const srcPages = src.urlPages?.length ?? 0;
        const dstPages = existing.urlPages?.length ?? 0;
        if (srcPages > dstPages) {
          await this.db.update(chapters)
            .set({ urlPages: src.urlPages, title: src.title || existing.title })
            .where(eq(chapters.id, existing.id));
        }
        await this.db.delete(chapters).where(eq(chapters.id, src.id));
      } else {
        // No conflict: reparent the source chapter into the target scan.
        await this.db.update(chapters)
          .set({ comicScanId: toComicScanId })
          .where(eq(chapters.id, src.id));
      }
    }
  }

  private async ensureScanGroupForComic(comic: ScrapedComic): Promise<number> {
    const group = comic.groupScan;
    const slug = group?.slug || group?.id || (group?.name ? this.slugify(group.name) : 'ikigai');
    const website = group?.url || IKIGAI_ORIGIN;

    // Ikigai pages sometimes put the comic title in `.card-title` while the
    // /grupos/<slug> link is correct. Never persist that as the scan name.
    const scrapedName = group?.name?.trim() || '';
    const comicTitle = comic.title?.trim() || '';
    const nameLooksLikeComicTitle =
      Boolean(scrapedName) &&
      Boolean(comicTitle) &&
      scrapedName.toLowerCase() === comicTitle.toLowerCase();
    const nameFromSlug = String(slug)
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    const name = nameLooksLikeComicTitle
      ? nameFromSlug || 'Ikigai Mangas'
      : scrapedName || nameFromSlug || 'Ikigai Mangas';

    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, slug),
    });

    if (existing) {
      const updates: Partial<typeof scanGroups.$inferInsert> = {};

      // Only overwrite name when we have a real team name (not the comic title).
      if (name && existing.name !== name && !nameLooksLikeComicTitle) {
        updates.name = name;
      }
      if (website && existing.website !== website) {
        updates.website = website;
      }

      if (Object.keys(updates).length > 0) {
        await this.db.update(scanGroups).set(updates).where(eq(scanGroups.id, existing.id));
      }

      return existing.id;
    }

    const [created] = await this.db.insert(scanGroups).values({
      name,
      slug,
      website,
    }).returning();

    return created.id;
  }

  private async ensureComicScan(comicId: number, comic: ScrapedComic, scanGroupId: number): Promise<number> {
    const externalUrl = `${IKIGAI_ORIGIN}/series/${comic.slug}`;

    // Find-or-update: never insert a duplicate (comicId, scanGroupId) row.
    const existing = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, scanGroupId),
      ),
    });

    if (existing) {
      if (existing.externalUrl !== externalUrl) {
        await this.db.update(comicScans)
          .set({ externalUrl })
          .where(eq(comicScans.id, existing.id));
      }
      return existing.id;
    }

    // INSERT with onConflictDoNothing so a concurrent insert under the
    // unique (comicId, scanGroupId) index can't throw. If the race won,
    // re-fetch the winning row instead of crashing the scrape.
    const [created] = await this.db.insert(comicScans).values({
      comicId,
      scanGroupId,
      externalUrl,
      language: 'es',
    }).onConflictDoNothing().returning();

    if (created) return created.id;

    // Race condition: another worker inserted first. Re-fetch.
    const refetch = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, scanGroupId),
      ),
    });
    return refetch!.id;
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
    comicScanId: number,
    chapter: ScrapedChapter,
    listItem: ChapterListItem,
  ): Promise<void> {
    // Search by (comicScanId, chapterNumber) instead of just slug
    // This prevents duplicates when chapter URLs change
    const existing = await this.db.query.chapters.findFirst({
      where: and(
        eq(chapters.comicScanId, comicScanId),
        eq(chapters.chapterNumber, chapter.chapterNumber),
      ),
    });

    if (existing) {
      await this.db.update(chapters).set({
        urlPages: chapter.pages,
        slug: chapter.slug, // Update slug in case it changed
        updatedAt: new Date(),
      }).where(eq(chapters.id, existing.id));
    } else {
      await this.db.insert(chapters).values({
        comicScanId,
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
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
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
    if (path.startsWith('/')) return origin.replace(/\/$/, '') + path;
    return origin.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
  }


}
