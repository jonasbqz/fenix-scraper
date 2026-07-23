import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import type { ScraperResult } from '../scraper.types';

// Adult genre slugs - used to automatically mark comics as NSFW
// Note: ecchi and smut are NOT considered adult content
export const ADULT_GENRE_SLUGS = [
  '18',           // +18
  'adulto',       // Adulto
  'maduro',       // Maduro
  'boys-love',    // Boys Love
  'girls-love',   // Girls Love
  'hentai',       // Hentai
  'yaoi',         // Yaoi
  'yuri',         // Yuri
  'erotico',      // Erótico
  'gore',         // Gore (mature content)
];

export function isAdultGenreSlug(slug: string): boolean {
  return ADULT_GENRE_SLUGS.includes(slug.toLowerCase());
}

// List of DMCA / Copyrighted Manga Slugs and Keywords that must NEVER be scraped or imported
export const DMCA_BLOCKED_SLUGS = [
  'one-piece',
  'jujutsu-kaisen',
  'my-hero-academia',
  'boku-no-hero',
  'boruto',
  'naruto',
  'bleach',
  'dragon-ball',
  'dragonball',
  'kimetsu-no-yaiba',
  'demon-slayer',
  'chainsaw-man',
  'shingeki-no-kyojin',
  'attack-on-titan',
  'solo-leveling',
  'spy-x-family',
  'tokyo-ghoul',
  'black-clover',
  'hunter-x-hunter',
  'detective-conan',
  'one-punch-man',
  'death-note',
  'fullmetal-alchemist',
  'fairy-tail',
  'berserk',
  'vinland-saga',
  'jojo',
];

export function isDmcaBlocked(title: string, slug: string): boolean {
  const normSlug = (slug || '').toLowerCase().trim();
  const normTitle = (title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  // Explicit title checks for famous DMCA titles
  if (/\bone\s*piece\b/i.test(title) || /\bone\s*piece\b/i.test(normTitle) || /\bone-piece\b/i.test(normSlug)) {
    return true;
  }
  if (/\bjujutsu\s*kaisen\b/i.test(normTitle)) return true;
  if (/\bmy\s*hero\s*academia\b/i.test(normTitle) || /\bboku\s*no\s*hero\b/i.test(normTitle)) return true;
  if (/\bboruto\b/i.test(normTitle) || /\bnaruto\b/i.test(normTitle)) return true;
  if (/\bbleach\b/i.test(normTitle)) return true;
  if (/\bdragon\s*ball\b/i.test(normTitle)) return true;
  if (/\bkimetsu\s*no\s*yaiba\b/i.test(normTitle) || /\bdemon\s*slayer\b/i.test(normTitle)) return true;
  if (/\bchainsaw\s*man\b/i.test(normTitle)) return true;

  for (const blocked of DMCA_BLOCKED_SLUGS) {
    const slugRegex = new RegExp(`(?:^|-)${blocked.replace(/-/g, '[-_]')}(?:$|-)`, 'i');
    const titleRegex = new RegExp(`\\b${blocked.replace(/-/g, '[\\s-_]+')}\\b`, 'i');
    if (slugRegex.test(normSlug) || titleRegex.test(normTitle)) {
      return true;
    }
  }

  return false;
}

/**
 * Reject scraped "genres" that are actually comic titles, view counts, etc.
 * Ikigai's old broad selector polluted `genres` with strings like:
 * "La obsesión del tirano…comic44,5 mil vistas"
 */
export function isPlausibleGenreName(name: string): boolean {
  const raw = name.trim();
  if (!raw) return false;

  // Keep "+18"; drop other bare "+N" chapter-ish chips.
  if (/^\+\d+$/.test(raw)) {
    return raw === '+18';
  }

  if (raw.length > 40) return false;

  const compact = raw.replace(/\s+/g, '').toLowerCase();
  const lower = raw.toLowerCase();

  if (lower.includes('vistas')) return false;
  if (/comic\d/.test(compact) || /novel\d/.test(compact)) return false;
  if (/,\d/.test(raw)) return false; // "24,3 mil"
  if (/\d{2,}/.test(raw) && !/^\+?\d{1,2}$/.test(raw)) return false;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;

  if (!/[a-záéíóúüñ]/i.test(raw)) return false;

  return true;
}

export function sanitizeGenreNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!isPlausibleGenreName(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export interface ScrapedComic {
  title: string;
  slug: string;
  titleAlternative?: string;
  description?: string;
  coverImage?: string;
  author?: string;
  artist?: string;
  type?: 'manga' | 'manhwa' | 'manhua';
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  genres?: string[];
  isNsfw?: boolean;
}

export interface ScrapedChapter {
  chapterNumber: number;
  title?: string;
  slug: string;
  releaseDate?: Date;
  pages?: string[];
}

export abstract class BaseScraperAdapter {
  protected delayMs: number;

  constructor(
    protected db: NodePgDatabase<typeof schema>,
    delayMs = 100,
  ) {
    this.delayMs = delayMs;
  }

  /**
   * Main scraping method to be implemented by each adapter
   */
  abstract scrape(...args: any[]): Promise<ScraperResult>;

  /**
   * Get the name of this scraper
   */
  abstract getName(): string;

  /**
   * Delay between requests to avoid rate limiting
   */
  protected delay(ms?: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms || this.delayMs));
  }

  /**
   * Generate a URL-friendly slug from a string
   */
  protected slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Parse chapter number from string (handles formats like "1", "1.5", "Chapter 1")
   */
  protected parseChapterNumber(input: string): number {
    const match = input.match(/[\d.]+/);
    return match ? parseFloat(match[0]) : 0;
  }

  /**
   * Clean HTML and extract text
   */
  protected cleanText(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Check if an image URL is failing (e.g. 404, 403)
   */
  protected async checkImageFailing(url: string): Promise<boolean> {
    if (!url) return true;
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (response.status === 405) {
        // Some servers reject HEAD requests, fallback to GET
        const getRes = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
        return !getRes.ok;
      }
      return !response.ok;
    } catch {
      return true;
    }
  }
}
