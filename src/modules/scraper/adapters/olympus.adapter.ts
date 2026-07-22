import { Logger } from '@/lib/logger';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq, and } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ScraperResult } from '../scraper.types';
import {
  isAdultGenreSlug,
  sanitizeGenreNames,
  BaseScraperAdapter,
} from './base.adapter';

// All Olympus requests go through the mango-proxy Cloudflare Worker to hide
// the real server IP. The upstream is split across two hosts:
//   - olympusxyz.com        hosts the /api/new-chapters list endpoint
//                          and /api/series/<slug> (series detail)
//   - panel.olympusxyz.com  hosts /api/series/<slug>/chapters (chapter
//                          list) and /api/capitulo/... (chapter data)
//
// The proxy maps id -> upstream origin. We send each request through
// the id whose origin serves it, so:
//   - /olympus/  (forwards to olympusxyz.com)        for new-chapters + series detail
//   - /panel/    (forwards to panel.olympusxyz.com)  for chapter list + chapter data
const OLYMPUS_SITE = 'https://mango-proxy.platformoctopus.workers.dev/olympus';
const OLYMPUS_PANEL = 'https://mango-proxy.platformoctopus.workers.dev/panel';
const OLYMPUS_PANEL_API = `${OLYMPUS_PANEL}/api`;
const OLYMPUS_ORIGIN = 'https://olympusxyz.com';

// Bot detection: the Olympus SSR replaces chapter pages with 9 placeholder
// images (/cp/cp-N.jpg) when the User-Agent matches a bot regex. The chapter
// API endpoint (/api/capitulo) is not affected by bot detection, but we keep
// a realistic Chrome UA for all requests as a safety measure.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// After this many consecutive chapters that already exist in DB with the same
// page count, we stop forward-scanning. This balances completeness (detecting
// chapters integrated in the middle) with efficiency (not re-scanning 138
// chapters every hour when nothing changed).
const CONSECUTIVE_UNCHANGED_THRESHOLD = 5;

// Olympus moved its image CDN off dashboard.olympusxyz.com/storage/ to a
// dedicated media host. Rewrite any URL pointing at the old storage path so
// we never persist the dead origin in the DB. Both the old olympusbiblioteca
// and olympusxyz dashboard hosts are covered for safety.
const OLYMPUS_IMAGE_HOST_RE = /^https:\/\/dashboard\.olympus(xyz|biblioteca)\.com\/storage\//g;

function rewriteOlympusImageOrigin(url: string | undefined | null): string {
  if (!url) return url as string;
  return url.replace(OLYMPUS_IMAGE_HOST_RE, 'https://media.imagesolymp.xyz/');
}

interface OlympusApiResponse {
  data: any;
  links?: { next?: string };
  meta?: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
}

interface ChapterRef {
  id: string;
  name: string;
  published_at?: string;
}

interface ComicInfo {
  url: string;
  olympusId: string;
  slug: string;
  lastChapters: ChapterRef[];
  // The raw new-chapters entry. Used as a fallback for the series detail
  // when the dedicated /api/series/<slug> endpoint returns 500 (e.g. for
  // slugs the upstream has rotated but still lists in new-chapters).
  newChaptersItem: any;
}

export class OlympusAdapter extends BaseScraperAdapter {
  private readonly logger = new Logger(OlympusAdapter.name);
  private scanGroupId: number | null = null;

  constructor(
    protected db: NodePgDatabase<typeof schema>,
    protected delayMs: number = 100,
  ) {
    super(db, delayMs);
  }

  getName() { return 'Olympus'; }

  async scrape(startPage = 1, endPage = 5): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(`Starting Olympus scrape: pages ${startPage}-${endPage}`);

    try {
      // Ensure scan group exists
      await this.ensureScanGroup();
      this.logger.log(`Scan group ensured: ID ${this.scanGroupId}`);

      const startTime = Date.now();
      const comicInfos = await this.getRecentComicUrls(startPage, endPage);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.log(`Found ${comicInfos.length} comics to scrape (took ${duration}s)`);

      if (comicInfos.length === 0) {
        this.logger.warn(`No comics found! Check if the API is working: ${OLYMPUS_SITE}/api/new-chapters`);
        result.errors.push(`No comics found from Olympus API`);
      }

      for (const info of comicInfos) {
        try {
          await this.scrapeComic(info, result);
          await this.delay();
        } catch (error) {
          const msg = `Failed to scrape comic ${info.url} (ID: ${info.olympusId}): ${error}`;
          this.logger.error(msg);
          result.errors.push(msg);
        }
      }
    } catch (error) {
      const msg = `Olympus scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    this.logger.log(`Olympus scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`);
    return result;
  }

  private async ensureScanGroup(): Promise<void> {
    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'olympus'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db.insert(scanGroups).values({
      name: 'Olympus Scans',
      slug: 'olympus',
      website: 'https://olympusxyz.com',
    }).returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(startPage: number, endPage: number): Promise<ComicInfo[]> {
    const comics: ComicInfo[] = [];
    const seenIds = new Set<string>();

    for (let page = startPage; page <= endPage; page++) {
      try {
        const apiUrl = `${OLYMPUS_SITE}/api/new-chapters?type=comic&direction=asc&page=${page}`;
        this.logger.debug(`Fetching Olympus page ${page}: ${apiUrl}`);

        const response = await this.fetchJson<OlympusApiResponse>(apiUrl);

        if (!response.data || !Array.isArray(response.data)) {
          this.logger.warn(`Page ${page}: No data or invalid response`);
          break;
        }

        this.logger.debug(`Page ${page}: got ${response.data.length} items`);

        let foundOnPage = 0;
        for (const item of response.data) {
          if (item.type?.toLowerCase() === 'novel') continue;

          const olympusId = String(item.id);
          const slug = item.slug;

          if (olympusId && slug && !seenIds.has(olympusId)) {
            seenIds.add(olympusId);
            const lastChapters: ChapterRef[] = Array.isArray(item.last_chapters)
              ? item.last_chapters.map((ch: any) => ({
                  id: String(ch.id),
                  name: String(ch.name),
                  published_at: ch.published_at,
                }))
              : [];
            comics.push({
              url: `${OLYMPUS_SITE}/api/series/${slug}`,
              olympusId,
              slug,
              lastChapters,
              newChaptersItem: item,
            });
            foundOnPage++;
          }
        }

        this.logger.debug(`Page ${page}: found ${foundOnPage} new comics`);
        await this.delay(200);
      } catch (error) {
        this.logger.error(`Failed to fetch page ${page}: ${error}`);
        break;
      }
    }

    return comics;
  }

  private async scrapeComic(info: ComicInfo, result: ScraperResult): Promise<void> {
    // Olympus rotates SEO slugs (…-YYYYMMDD-HHMMSS). new-chapters can still
    // list an older slug while panel /series/<slug>/chapters already 404s.
    // Refresh before any chapter work.
    await this.ensureFreshSlug(info);

    // Try the full series detail first (gives us summary, author,
    // genres, status, type, team). If it 500s (typical for slugs the
    // upstream has rotated but still lists in new-chapters), fall back
    // to the basic data from the new-chapters entry.
    let data: any;
    try {
      const apiUrl = `${OLYMPUS_SITE}/api/series/${info.slug}`;
      const response = await this.fetchJson<OlympusApiResponse>(apiUrl);
      data = response.data;
    } catch (err: any) {
      this.logger.warn(
        `series detail failed for ${info.slug} (${err.message}); falling back to new-chapters data`,
      );
      data = info.newChaptersItem;
    }

    if (!data?.name || !data?.cover) {
      throw new Error('Incomplete comic data');
    }

    const actualOlympusId = String(data.id);
    if (actualOlympusId !== info.olympusId) {
      this.logger.warn(`Olympus ID mismatch: expected ${info.olympusId}, got ${actualOlympusId}`);
    }

    const comic = this.parseComic(data);
    // Prefer the slug that panel accepts right now.
    comic.slug = info.slug;
    this.logger.log(`Scraping comic: ${comic.title} (Olympus ID: ${actualOlympusId})`);

    const { comicId, comicScanId } = await this.upsertComic(comic);
    result.comics++;

    // Load existing chapters including releaseDate so we can detect Olympus
    // re-uploads that keep the same page count but bump published_at / CDN URLs.
    const existingChapters = await this.db.query.chapters.findMany({
      where: eq(chapters.comicScanId, comicScanId),
      columns: {
        id: true,
        chapterNumber: true,
        urlPages: true,
        releaseDate: true,
        slug: true,
      },
    });
    const existingByNumber = new Map(
      existingChapters.map(ch => [ch.chapterNumber, ch]),
    );
    this.logger.log(`Comic has ${existingByNumber.size} chapters in DB`);

    // Paginate the FULL chapter list. Page 1 alone only has ~40 newest
    // chapters — Olympus often re-uploads early chapters (new published_at
    // + CDN URLs) which never appear on page 1 for long series.
    let upstreamChapters: any[] = [];
    try {
      upstreamChapters = await this.fetchAllChapterListItems(info.slug);
    } catch (err: any) {
      this.logger.warn(
        `Chapter list failed for ${info.slug} (${err.message}); trying slug refresh + walk fallback`,
      );
      await this.ensureFreshSlug(info, true);
      try {
        upstreamChapters = await this.fetchAllChapterListItems(info.slug);
      } catch (err2: any) {
        upstreamChapters = await this.walkChapterListFromLatest(
          info.slug,
          info.lastChapters,
        );
        this.logger.warn(
          `Using capitulo walk-back for ${comic.title}: ${upstreamChapters.length} chapters (${err2.message})`,
        );
      }
    }
    this.logger.log(
      `Upstream chapter list for ${comic.title}: ${upstreamChapters.length} items`,
    );
    if (upstreamChapters.length === 0) {
      throw new Error(`HTTP 404: Not Found (no chapter list for slug ${info.slug})`);
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of upstreamChapters) {
      const chapterNum = this.parseChapterNumber(String(item.name || '0'));
      if (!chapterNum) continue;

      const existing = existingByNumber.get(chapterNum);
      const remotePublished = item.published_at ? new Date(item.published_at) : undefined;
      const remotePublishedMs =
        remotePublished && !Number.isNaN(remotePublished.getTime())
          ? remotePublished.getTime()
          : null;
      const existingReleaseMs = (() => {
        if (!existing?.releaseDate) return null;
        const d =
          existing.releaseDate instanceof Date
            ? existing.releaseDate
            : new Date(existing.releaseDate as string);
        return Number.isNaN(d.getTime()) ? null : d.getTime();
      })();
      const dateMoved =
        remotePublishedMs != null &&
        (existingReleaseMs == null || remotePublishedMs > existingReleaseMs + 999);
      const datesMatch =
        remotePublishedMs != null &&
        existingReleaseMs != null &&
        Math.abs(remotePublishedMs - existingReleaseMs) < 1000;
      const staleStoredUrls = this.looksStaleOlympusPages(existing?.urlPages);

      // Cheap skip: same published_at, pages present, URLs not obviously stale.
      if (
        existing &&
        datesMatch &&
        (existing.urlPages?.length ?? 0) > 0 &&
        !staleStoredUrls
      ) {
        skipped++;
        continue;
      }

      let chapterData;
      try {
        chapterData = await this.fetchChapterPages(info.slug, String(item.id));
      } catch (err: any) {
        this.logger.warn(`Failed to scrape chapter ${item.name} (${item.id}): ${err}`);
        continue;
      }

      const pageCount = chapterData.pages.length;
      const publishedAt =
        chapterData.publishedAt && !Number.isNaN(chapterData.publishedAt.getTime())
          ? chapterData.publishedAt
          : remotePublished;

      if (pageCount === 0) {
        this.logger.warn(`Chapter ${chapterNum} has no pages, skipping`);
        continue;
      }

      if (!existing) {
        await this.db.insert(chapters).values({
          comicScanId,
          chapterNumber: chapterNum,
          title: String(item.name || ''),
          slug: String(item.id),
          releaseDate: publishedAt,
          urlPages: chapterData.pages,
        }).onConflictDoNothing();
        result.chapters++;
        inserted++;
        this.logger.log(`Added chapter ${chapterNum} for ${comic.title}`);
      } else if (
        dateMoved ||
        staleStoredUrls ||
        this.olympusPagesNeedRefresh(existing.urlPages, chapterData.pages)
      ) {
        const chapterPatch: {
          urlPages: string[];
          releaseDate?: Date;
          slug: string;
          title?: string;
          updatedAt: Date;
        } = {
          urlPages: chapterData.pages,
          releaseDate: publishedAt ?? (existing.releaseDate as Date | undefined) ?? undefined,
          slug: String(item.id),
          updatedAt: new Date(),
        };
        if (item.name) chapterPatch.title = String(item.name);

        await this.db
          .update(chapters)
          .set(chapterPatch)
          .where(eq(chapters.id, existing.id));
        updated++;
        this.logger.log(
          `Updated chapter ${chapterNum} for ${comic.title}` +
            (dateMoved ? ' (published_at changed)' : '') +
            ` (${existing.urlPages?.length ?? 0} → ${pageCount} pages)`,
        );
      } else {
        skipped++;
      }

      await this.delay(80);
    }

    if (inserted === 0 && updated === 0) {
      this.logger.log(`No new or updated chapters for ${comic.title} (skipped ${skipped} already in DB)`);
    } else {
      this.logger.log(`Comic ${comic.title}: ${inserted} new, ${updated} updated, ${skipped} unchanged`);
    }
  }

  /** Old Olympus CDN paths that usually mean pages were re-hosted. */
  private looksStaleOlympusPages(pages?: string[] | null): boolean {
    if (!pages?.length) return true;
    const sample = pages[0] || '';
    return /dashboard\.|\/storage\//i.test(sample);
  }

  private olympusPagesNeedRefresh(
    existingPages: string[] | null | undefined,
    remotePages: string[],
  ): boolean {
    if (!existingPages?.length) return true;
    if (existingPages.length !== remotePages.length) return true;
    return (
      existingPages[0] !== remotePages[0] ||
      existingPages[existingPages.length - 1] !== remotePages[remotePages.length - 1]
    );
  }

  /**
   * Walk every page of /series/<slug>/chapters so early chapters with a
   * newer published_at are not missed (page 1 is only the newest ~40).
   */
  private async fetchAllChapterListItems(slug: string): Promise<any[]> {
    const all: any[] = [];
    let page = 1;
    let lastPage = 1;
    const maxPages = 80; // hard cap (~3200 chapters)

    while (page <= lastPage && page <= maxPages) {
      const url =
        `${OLYMPUS_PANEL_API}/series/${slug}/chapters` +
        `?page=${page}&direction=desc&type=comic`;
      const res = await this.fetchJson<OlympusApiResponse>(url);
      const batch = Array.isArray(res.data) ? res.data : [];
      all.push(...batch);

      const metaLast = res.meta?.last_page;
      if (typeof metaLast === 'number' && metaLast > 0) {
        lastPage = metaLast;
      } else if (batch.length === 0) {
        break;
      } else {
        // No meta: keep going until an empty page.
        lastPage = batch.length > 0 ? page + 1 : page;
      }

      if (batch.length === 0) break;
      page += 1;
      await this.delay(40);
    }

    return all;
  }

  private async fetchChapterPages(slug: string, chapterId: string): Promise<{
    pages: string[];
    nextChapterId: string | null;
    nextChapterName: string | null;
    prevChapterId: string | null;
    publishedAt: Date | undefined;
  }> {
    // NOTE: the chapter data endpoint is served by the main site
    // (olympusxyz.com), NOT the panel host. panel.olympusxyz.com
    // 404s on /api/capitulo/... even though the chapter LIST works
    // there. The proxy maps /olympus/ -> olympusxyz.com.
    const url = `${OLYMPUS_SITE}/api/capitulo/${slug}/${chapterId}?type=comic`;
    const response = await this.fetchJson<any>(url);

    const ch = response.chapter;
    if (!ch) throw new Error('Chapter not found in API response');

    const pages: string[] = Array.isArray(ch.pages)
      ? ch.pages.filter((p: string) => typeof p === 'string' && p.startsWith('http'))
      : [];

    // Defensive: strip any wrapping double-quotes that might slip through
    // (the old HTML scraper introduced them; the API shouldn't, but be safe).
    const cleanPages = pages.map((p) => p.replace(/^"+|"+$/g, ''));

    // Rewrite any old image hosts to the new CDN
    const rewrittenPages = cleanPages.map((p) => rewriteOlympusImageOrigin(p));

    const prev = response.prev_chapter;
    const next = response.next_chapter;

    return {
      pages: rewrittenPages,
      nextChapterId: next ? String(next.id) : null,
      nextChapterName: next ? String(next.name) : null,
      prevChapterId: prev ? String(prev.id) : null,
      publishedAt: ch.published_at ? new Date(ch.published_at) : undefined,
    };
  }

  private parseComic(data: any): ScrapedComic {
    const statusMap: Record<string, ScrapedComic['status']> = {
      'en curso': 'ongoing',
      'activo': 'ongoing',
      'ongoing': 'ongoing',
      'completo': 'completed',
      'completed': 'completed',
      'finalizado': 'completed',
      'pausado': 'hiatus',
      'hiatus': 'hiatus',
      'cancelado': 'cancelled',
      'cancelled': 'cancelled',
    };

    const typeMap: Record<string, ScrapedComic['type']> = {
      'manga': 'manga',
      'manhwa': 'manhwa',
      'manhua': 'manhua',
    };

    const rawStatus = (data.status?.name || '').toLowerCase();
    const rawType = (data.type || '').toLowerCase();

    return {
      id: String(data.id),
      slug: data.slug,
      title: (data.name || '').replace(/\.$/, ''),
      titleAlternative: data.alternativeName,
      description: data.summary,
      author: data.author,
      coverImage: rewriteOlympusImageOrigin(data.cover),
      type: typeMap[rawType] || 'comic',
      status: statusMap[rawStatus] || 'ongoing',
      genres: (data.genres || []).map((g: any) => g.name?.toUpperCase()).filter(Boolean),
      groupScan: data.team ? {
        name: data.team.name,
        id: String(data.team.id),
        cover: rewriteOlympusImageOrigin(data.team.cover),
      } : undefined,
    };
  }

  private async upsertComic(comic: ScrapedComic): Promise<{ comicId: number; comicScanId: number }> {
    const externalUrl = `${OLYMPUS_ORIGIN}/series/${comic.slug}`;

    // First, check if we already have this comic via externalId (Olympus ID) in comicScans
    let existingComicScan = null;
    if (comic.id) {
      existingComicScan = await this.db.query.comicScans.findFirst({
        where: and(
          eq(comicScans.externalId, comic.id),
          eq(comicScans.scanGroupId, this.scanGroupId!),
        ),
        with: { comic: true },
      });
    }

    let comicId: number;
    let comicScanId: number;

    if (existingComicScan?.comic) {
      // Comic already exists via externalId (Olympus ID) - don't overwrite metadata to preserve info, just update timestamp
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

      // Update externalUrl in case slug changed
      await this.db.update(comicScans).set({
        externalUrl,
      }).where(eq(comicScans.id, existingComicScan.id));

      comicId = existingComicScan.comic.id;
      comicScanId = existingComicScan.id;

      this.logger.debug(`Found existing comic by Olympus ID: ${comic.id} -> Comic #${comicId}`);
    } else {
      // No match by Olympus ID - check by title as fallback (to merge possible duplicates)
      const existingByTitle = await this.db.query.comics.findFirst({
        where: eq(comics.title, comic.title),
      });

      if (existingByTitle) {
        // Shared comic found by title - conditional description/cover update
        const updates: any = { updatedAt: new Date() };

        if (comic.description && comic.description.length > (existingByTitle.description?.length || 0)) {
          updates.description = comic.description;
        }
        if (comic.coverImage && existingByTitle.coverImage && comic.coverImage !== existingByTitle.coverImage) {
          const isFailing = await this.checkImageFailing(existingByTitle.coverImage);
          if (isFailing) {
            updates.coverImage = comic.coverImage;
            this.logger.debug(`Replaced failing cover image for ${comic.title}`);
          }
        } else if (comic.coverImage && !existingByTitle.coverImage) {
          updates.coverImage = comic.coverImage;
        }

        await this.db.update(comics).set(updates).where(eq(comics.id, existingByTitle.id));
        comicId = existingByTitle.id;
        this.logger.debug(`Found existing comic by title: "${comic.title}" -> Comic #${comicId}`);
      } else {
        // Create new comic
        const [created] = await this.db.insert(comics).values({
          title: comic.title,
          slug: comic.slug,
          titleAlternative: comic.titleAlternative,
          description: comic.description,
          author: comic.author,
          coverImage: comic.coverImage,
          type: comic.type === 'comic' ? 'manga' : comic.type,
          status: comic.status,
        }).returning();
        comicId = created.id;
        this.logger.log(`Created new comic: "${comic.title}" -> Comic #${comicId}`);
      }

      // Ensure comic scan exists for this scan group (with Olympus ID)
      comicScanId = await this.ensureComicScan(comicId, comic);
    }

    // Sync genres
    await this.syncGenres(comicId, comic.genres);

    return { comicId, comicScanId };
  }

  private async ensureComicScan(comicId: number, comic: ScrapedComic): Promise<number> {
    // Check for existing comic scan for this specific scan group
    const existing = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (existing) {
      // Update externalId and externalUrl if needed
      await this.db.update(comicScans).set({
        externalId: comic.id,
        externalUrl: `${OLYMPUS_ORIGIN}/series/${comic.slug}`,
      }).where(eq(comicScans.id, existing.id));
      return existing.id;
    }

    const [created] = await this.db.insert(comicScans).values({
      comicId,
      scanGroupId: this.scanGroupId!,
      externalId: comic.id,
      externalUrl: `${OLYMPUS_ORIGIN}/series/${comic.slug}`,
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

  /**
   * Probe panel chapter list; if the slug 404s, look up the current slug for
   * this Olympus ID in new-chapters (slugs rotate with …-YYYYMMDD-HHMMSS).
   */
  private async ensureFreshSlug(info: ComicInfo, force = false): Promise<void> {
    if (!force) {
      try {
        const probe =
          `${OLYMPUS_PANEL_API}/series/${info.slug}/chapters` +
          `?page=1&direction=desc&type=comic`;
        await this.fetchJson<OlympusApiResponse>(probe);
        return;
      } catch (err: any) {
        if (!String(err?.message || '').includes('404')) {
          // Non-404: keep going; list fetch may still work later.
          return;
        }
      }
    }

    const fresh = await this.lookupSlugInNewChapters(info.olympusId);
    if (fresh && fresh !== info.slug) {
      this.logger.warn(
        `Olympus slug rotated for ID ${info.olympusId}: ${info.slug} → ${fresh}`,
      );
      info.slug = fresh;
      info.url = `${OLYMPUS_SITE}/api/series/${fresh}`;
      if (info.newChaptersItem) {
        info.newChaptersItem.slug = fresh;
      }
    }
  }

  private async lookupSlugInNewChapters(olympusId: string): Promise<string | null> {
    for (let page = 1; page <= 20; page++) {
      try {
        const apiUrl =
          `${OLYMPUS_SITE}/api/new-chapters?type=comic&direction=asc&page=${page}`;
        const response = await this.fetchJson<OlympusApiResponse>(apiUrl);
        const rows = Array.isArray(response.data) ? response.data : [];
        if (rows.length === 0) break;
        const hit = rows.find((item: any) => String(item.id) === String(olympusId));
        if (hit?.slug) return String(hit.slug);
        await this.delay(40);
      } catch {
        break;
      }
    }
    return null;
  }

  /**
   * When /chapters list 404s, walk prev_chapter from the latest tip chapters
   * via /api/capitulo (that endpoint accepts the decorated slug).
   */
  private async walkChapterListFromLatest(
    slug: string,
    tips: ChapterRef[],
  ): Promise<any[]> {
    const startId = tips?.[0]?.id;
    if (!startId) return [];

    const collected: any[] = [];
    const seen = new Set<string>();
    let chapterId: string | null = String(startId);
    let steps = 0;
    const maxSteps = 500;

    while (chapterId && steps < maxSteps) {
      if (seen.has(chapterId)) break;
      seen.add(chapterId);
      steps += 1;

      try {
        const capituloUrl =
          `${OLYMPUS_SITE}/api/capitulo/${slug}/${chapterId}?type=comic` as string;
        type CapituloPayload = {
          chapter?: { id?: number | string; name?: string; published_at?: string };
          prev_chapter?: { id?: number | string };
        };
        const payload: CapituloPayload = await this.fetchJson<CapituloPayload>(capituloUrl);
        const ch = payload.chapter;
        if (!ch?.id) break;
        collected.push({
          id: ch.id,
          name: ch.name,
          published_at: ch.published_at,
        });
        const prevId = payload.prev_chapter?.id;
        chapterId = prevId != null ? String(prevId) : null;
      } catch {
        break;
      }
      await this.delay(40);
    }

    return collected;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA,
        'Origin': OLYMPUS_ORIGIN,
        'Referer': OLYMPUS_ORIGIN,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }
}
