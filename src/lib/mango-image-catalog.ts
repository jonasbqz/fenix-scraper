// Client for mango-image /catalog/* API (auth required).

import type { EnvConfig } from "./config";
import {
  MANGO_IMAGE_API_KEY_ENV,
  MANGO_IMAGE_URL_ENV,
} from "./mango-image";

export interface CatalogSummary {
  total_images: number;
  total_bytes: number;
  total_covers: number;
  total_chapter_pages: number;
  total_manga: number;
  total_chapters: number;
}

export interface CatalogCover {
  key: string;
  manga_slug: string | null;
  page_name: string | null;
  byte_size: number;
  content_type: string;
  updated_at: number;
}

export interface CatalogChapterSummary {
  chapter_slug: string;
  page_count: number;
  total_bytes: number;
  last_updated: number;
}

export interface CatalogManga {
  manga_slug: string;
  cover_count: number;
  covers: Array<{
    key: string;
    page_name: string | null;
    byte_size: number;
    updated_at: number;
  }>;
  chapter_count: number;
  chapters: CatalogChapterSummary[];
}

export interface CatalogChapterPages {
  manga_slug: string;
  chapter_slug: string;
  page_count: number;
  pages: Array<{
    key: string;
    page_name: string | null;
    byte_size: number;
    content_type: string;
    updated_at: number;
  }>;
}

function catalogBase(config: EnvConfig): { base: string; apiKey: string } | null {
  const base = config.get(MANGO_IMAGE_URL_ENV);
  const apiKey = config.get(MANGO_IMAGE_API_KEY_ENV);
  if (!base || !apiKey) return null;
  return { base: base.replace(/\/+$/, ""), apiKey };
}

async function catalogFetch<T>(
  config: EnvConfig,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const creds = catalogBase(config);
  if (!creds) {
    return { ok: false, status: 0, error: "mango-image catalog not configured" };
  }

  let res: Response;
  try {
    res = await fetch(`${creds.base}${path}`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }

  const data = (await res.json()) as T;
  return { ok: true, data };
}

export async function fetchCatalogSummary(config: EnvConfig) {
  return catalogFetch<CatalogSummary>(config, "/catalog/summary");
}

export async function fetchCatalogManga(config: EnvConfig, mangaSlug: string) {
  return catalogFetch<CatalogManga>(
    config,
    `/catalog/manga/${encodeURIComponent(mangaSlug)}`,
  );
}

export async function fetchCatalogChapterPages(
  config: EnvConfig,
  mangaSlug: string,
  chapterSlug: string,
) {
  return catalogFetch<CatalogChapterPages>(
    config,
    `/catalog/manga/${encodeURIComponent(mangaSlug)}/chapters/${encodeURIComponent(chapterSlug)}`,
  );
}

/** Set of canonical keys already stored in mango-image for a chapter. */
export function catalogKeysSet(pages: CatalogChapterPages["pages"]): Set<string> {
  return new Set(pages.map((p) => p.key));
}

/** Set of canonical cover keys for a manga. */
export function catalogCoverKeys(manga: CatalogManga): Set<string> {
  return new Set(manga.covers.map((c) => c.key));
}
