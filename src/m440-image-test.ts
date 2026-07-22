/**
 * Internal test: fetch 2 chapters from 2 Peerless/m440 mangas and download
 * their images locally into ./image-test/<manga>/<chapter>/.
 *
 * Pure fetch + download — no DB, no upload. Validates that images are
 * accessible and downloadable through the m440 proxy + image CDN.
 *
 * Usage:
 *   bun run src/m440-image-test.ts
 *
 * Env vars:
 *   SCRAPER_M440_URL   — override proxy (default: mango-proxy CF Worker)
 *   M440_TEST_MANGAS   — number of mangas to test (default: 2)
 *   M440_TEST_CHAPTERS — chapters per manga to download (default: 2)
 *   M440_TEST_PAGES    — max pages per chapter, 0=all (default: 5)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import * as cheerio from 'cheerio';
import * as vm from 'node:vm';
import * as CryptoJS from 'crypto-js';

const M440_PROXY = 'https://mango-proxy.platformoctopus.workers.dev/m440';
const M440_ORIGIN = 'https://m440.in';
const M440_IMAGE_CDN = 'https://s2.m440.in';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE_URL = process.env.SCRAPER_M440_URL || M440_PROXY;
const TEST_DIR = join(process.cwd(), 'image-test');
const TEST_MANGAS = parseInt(process.env.M440_TEST_MANGAS || '2', 10);
const TEST_CHAPTERS = parseInt(process.env.M440_TEST_CHAPTERS || '2', 10);
const TEST_PAGES = parseInt(process.env.M440_TEST_PAGES || '5', 10);

interface ListingItem {
  manga_name: string;
  manga_slug: string;
  manga_chapters: number;
  categories: string[];
  chapters: {
    chapter_name: string;
    chapter_number: string;
    chapter_slug: string;
  }[];
}

interface ListingResponse {
  data: ListingItem[];
  totalPages: number;
}

interface DecryptedChapter {
  slug: string;
  name: string;
  number: string;
}

// ── CryptoJS AES (replica del sitio, misma que m440.adapter.ts) ──

const CryptoJSAesJson = {
  stringify(cipherParams: any): string {
    const j: any = { ct: cipherParams.ciphertext.toString(CryptoJS.enc.Base64) };
    if (cipherParams.iv) j.iv = cipherParams.iv.toString();
    if (cipherParams.salt) j.s = cipherParams.salt.toString();
    return JSON.stringify(j);
  },
  parse(jsonStr: string): any {
    const j = JSON.parse(jsonStr);
    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(j.ct),
    });
    if (j.iv) cipherParams.iv = CryptoJS.enc.Hex.parse(j.iv);
    if (j.s) cipherParams.salt = CryptoJS.enc.Hex.parse(j.s);
    return cipherParams;
  },
};

function extractDecryptionKey(obfuscatedScript: string | null): string {
  const fallbackKey = 'X^Ib1O*HLVh%3W2t';
  if (!obfuscatedScript) return fallbackKey;

  try {
    const cutoff = obfuscatedScript.indexOf('let jschaptertemp');
    const safeScript = cutoff > 0 ? obfuscatedScript.substring(0, cutoff) : obfuscatedScript;

    const sandbox = {
      CryptoJS: { AES: { decrypt: () => ({ toString: () => '{}' }) }, enc: { Hex: { parse: () => ({}) }, Base64: { parse: () => ({}) }, Utf8: {} }, lib: { CipherParams: { create: () => ({}) } } },
      UsaPoncho: '{}',
      console: { log: () => {}, warn: () => {}, error: () => {} },
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(safeScript, ctx, { timeout: 5000 });
    const extracted = vm.runInContext('ReturnStrg()', ctx, { timeout: 5000 });

    if (typeof extracted === 'string' && extracted.length > 0) return extracted;
  } catch { /* ignore */ }

  return fallbackKey;
}

function decryptChapters(encrypted: string, key: string): any[] | null {
  try {
    const decrypted = CryptoJS.AES.decrypt(encrypted, key, { format: CryptoJSAesJson });
    const str = decrypted.toString(CryptoJS.enc.Utf8);
    if (!str) return null;

    try {
      return JSON.parse(JSON.parse(str));
    } catch {
      return JSON.parse(str);
    }
  } catch {
    return null;
  }
}

// ── Fetch helpers ──

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': BASE_URL,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ── Listing ──

async function fetchListing(): Promise<ListingItem[]> {
  const url = `${BASE_URL}/lasted?p=1`;
  console.log(`[listing] GET ${url}`);

  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);

  const json: ListingResponse = await res.json();
  const items = json.data.filter(i => i.manga_chapters > 0);
  console.log(`[listing] ${items.length} mangas with chapters (of ${json.data.length})`);
  return items;
}

// ── Comic page → decrypt chapters ──

function parseComicPage(html: string): { slug: string; title: string } {
  const $ = cheerio.load(html);
  let jsmangas: any = null;

  $('script').each((_, el) => {
    const content = $(el).html() || '';
    const match = content.match(/const jsmangas\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
      try { jsmangas = JSON.parse(match[1]); } catch { /* */ }
    }
  });

  const slug = (jsmangas?.slug as string) || 'unknown';
  const title = (jsmangas?.name as string) || slug;
  return { slug, title };
}

function parseChapterList(html: string): DecryptedChapter[] {
  const $ = cheerio.load(html);
  let usaPonchoRaw: string | null = null;
  let obfuscatedScript: string | null = null;

  $('script').each((_, el) => {
    const content = $(el).html() || '';

    if (content.includes('const UsaPoncho =')) {
      const match = content.match(/const UsaPoncho = "(.*?)";/s);
      if (match) {
        try {
          usaPonchoRaw = JSON.parse(`"${match[1]}"`);
        } catch {
          usaPonchoRaw = match[1]?.replace(/\\"/g, '"').replace(/\\\\/g, '\\') || null;
        }
      }
    }

    if (content.includes('ReturnStrg') && content.includes('CryptoJSAesJson')) {
      obfuscatedScript = content;
    }
  });

  if (!usaPonchoRaw) return [];

  const key = extractDecryptionKey(obfuscatedScript);
  const data = decryptChapters(usaPonchoRaw, key);
  if (!data || !Array.isArray(data)) return [];

  return data.map((ch: any) => ({
    slug: ch.slug,
    name: ch.name,
    number: String(ch.number),
  }));
}

// ── Chapter page → parse page URLs ──

function parseChapterPages(html: string, mangaSlug: string, chapterSlug: string): string[] {
  const $ = cheerio.load(html);
  const pages: string[] = [];

  $('script').each((_, el) => {
    const content = $(el).html() || '';
    const match = content.match(/var\s+pages\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return;

    try {
      const pagesData: { page_image: string; page_slug: string; external: string }[] =
        JSON.parse(match[1]);

      for (const p of pagesData) {
        if (p.external === '1') {
          try {
            let b64 = p.page_image;
            if (b64.startsWith('https://') || b64.startsWith('http://')) {
              b64 = b64.replace(/^https?:\/\//, '');
            }
            pages.push(decodeURIComponent(atob(b64)));
          } catch {
            pages.push(p.page_image);
          }
        } else {
          pages.push(`${M440_IMAGE_CDN}/uploads/manga/${mangaSlug}/chapters/${chapterSlug}/${p.page_image}`);
        }
      }
    } catch { /* */ }
  });

  return pages;
}

// ── Image download ──

function inferExtFromContentType(ct: string, url: string): string {
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('png')) return '.png';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';

  const urlExt = extname(new URL(url).pathname).split('?')[0].toLowerCase();
  if (['.webp', '.png', '.gif', '.jpg', '.jpeg'].includes(urlExt)) return urlExt;

  return '.jpg';
}

async function downloadImage(
  imageUrl: string,
  destPath: string,
  referer: string,
): Promise<boolean> {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': referer,
        'Accept': 'image/*,*/*',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.error(`  HTTP ${res.status}: ${imageUrl}`);
      return false;
    }

    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) {
      console.error(`  Not an image (${ct}): ${imageUrl}`);
      return false;
    }

    const ext = inferFromContentType(ct, imageUrl);
    const finalPath = destPath + ext;

    const buf = await res.arrayBuffer();
    writeFileSync(finalPath, Buffer.from(buf));

    const sizeKb = (buf.byteLength / 1024).toFixed(1);
    console.log(`  + ${finalPath.split('/image-test/')[1]} (${sizeKb} KB)`);
    return true;
  } catch (err: any) {
    console.error(`  Download error: ${err.message}`);
    return false;
  }
}

function inferFromContentType(ct: string, url: string): string {
  return inferExtFromContentType(ct, url);
}

// ── Main ──

async function main() {
  console.log('=== M440 Image Download Test ===\n');
  console.log(`Proxy:       ${BASE_URL}`);
  console.log(`Output:      ${TEST_DIR}`);
  console.log(`Mangas:      ${TEST_MANGAS}`);
  console.log(`Chapters:    ${TEST_CHAPTERS} per manga`);
  console.log(`Max pages:   ${TEST_PAGES === 0 ? 'all' : TEST_PAGES} per chapter`);
  console.log('');

  mkdirSync(TEST_DIR, { recursive: true });

  const listing = await fetchListing();
  const mangasToTest = listing.slice(0, TEST_MANGAS);

  let totalImages = 0;
  let totalOk = 0;
  let totalFail = 0;
  let mangasProcessed = 0;

  for (const item of mangasToTest) {
    console.log(`\n--- Manga: ${item.manga_name} (${item.manga_slug}) ---`);

    const mangaUrl = `${BASE_URL}/manga/${item.manga_slug}`;

    let html: string;
    try {
      html = await fetchText(mangaUrl);
    } catch (err: any) {
      console.error(`[error] Failed to fetch manga page: ${err.message}`);
      continue;
    }

    const { slug, title } = parseComicPage(html);
    console.log(`  Title: ${title}  Slug: ${slug}`);

    const chapters = parseChapterList(html);
    if (chapters.length === 0) {
      console.warn(`  [warn] 0 chapters — decryption may have failed. Skipping.`);
      continue;
    }

    console.log(`  Chapters: ${chapters.length} total`);

    const chaptersToTest = chapters.slice(0, TEST_CHAPTERS);

    for (const ch of chaptersToTest) {
      console.log(`\n  Chapter ${ch.number} — ${ch.name} [${ch.slug}]`);

      const chapterUrl = `${BASE_URL}/manga/${item.manga_slug}/${ch.slug}`;

      let chapterHtml: string;
      try {
        chapterHtml = await fetchText(chapterUrl);
      } catch (err: any) {
        console.error(`  [error] Failed to fetch chapter: ${err.message}`);
        continue;
      }

      const pages = parseChapterPages(chapterHtml, item.manga_slug, ch.slug);

      // Antibot guard
      if (pages.length > 0) {
        const unique = new Set(pages.map(p => p.split('/').pop()));
        if (unique.size === 1) {
          console.error(`  [antibot] All ${pages.length} pages are the same image — skipping.`);
          continue;
        }
      }

      if (pages.length === 0) {
        console.warn(`  [warn] 0 pages parsed. Skipping.`);
        continue;
      }

      const pageSubset = TEST_PAGES > 0 ? pages.slice(0, TEST_PAGES) : pages;
      console.log(`  Pages: ${pages.length} total, downloading ${pageSubset.length}`);

      const destDir = join(TEST_DIR, item.manga_slug, ch.slug);
      mkdirSync(destDir, { recursive: true });

      for (let i = 0; i < pageSubset.length; i++) {
        const pageUrl = pageSubset[i];
        const destPath = join(destDir, `page_${String(i + 1).padStart(3, '0')}`);
        const referer = `${M440_ORIGIN}/`;

        totalImages++;
        const ok = await downloadImage(pageUrl, destPath, referer);
        if (ok) totalOk++;
        else totalFail++;

        await delay(300);
      }
    }

    mangasProcessed++;
  }

  console.log('\n=== Test Summary ===');
  console.log(`Mangas processed: ${mangasProcessed} / ${mangasToTest.length}`);
  console.log(`Images attempted:  ${totalImages}`);
  console.log(`Downloaded OK:     ${totalOk}`);
  console.log(`Failed:            ${totalFail}`);
  console.log(`Output folder:     ${TEST_DIR}`);

  if (totalImages > 0) {
    const pct = ((totalOk / totalImages) * 100).toFixed(1);
    console.log(`Success rate:      ${pct}%`);
  }

  process.exit(totalOk > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[m440-image-test] Fatal:', err);
  process.exit(1);
});
