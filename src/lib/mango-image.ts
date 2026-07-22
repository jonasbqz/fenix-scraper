// mango-image upload helper for the scraper → mango-image integration.
//
// Reads MANGO_IMAGE_URL and MANGO_IMAGE_API_KEY from the environment
// (via EnvConfig) and POSTs the image bytes to mango-image's /upload
// endpoint with the Authorization: Bearer header.
//
// This is the FOUNDATION. The wiring (when to call this — on-scrape,
// cron, backfill) is a separate change gated on product rules. See the
// README/mango-image spec for the contract:
//
//   POST {MANGO_IMAGE_URL}/upload?key=<canonical-url>&replace=true
//   Headers: Authorization: Bearer <MANGO_IMAGE_API_KEY>
//   Body: raw image bytes
//   Content-Type: image/<ext>
//
// mango-image returns 200 + the image record on success, 401 on bad key,
// 4xx on bad input (invalid key, too large, wrong content type), 5xx on
// internal. This helper surfaces all of that via UploadToMangoImageResult.

import type { EnvConfig } from "./config.ts";

/** Env var name for the mango-image base URL (e.g. https://cloud.otakux.wiki). */
export const MANGO_IMAGE_URL_ENV = "MANGO_IMAGE_URL";

/** Env var name for the shared API key (must match mango-image's MANGO_IMAGE_API_KEY). */
export const MANGO_IMAGE_API_KEY_ENV = "MANGO_IMAGE_API_KEY";

export interface UploadToMangoImageInput {
  /** The full canonical URL key (e.g. "https://m440.in/uploads/manga/x/cover/cover_250x350.jpg"). mango-image strips "https://" internally. */
  canonicalKey: string;
  /** Raw image bytes. */
  body: Uint8Array;
  /** MIME content type. Defaults to "application/octet-stream" if unknown. */
  contentType?: string;
  /** Whether to replace if the key already exists in mango-image. Defaults to true (idempotent re-runs). */
  replace?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface UploadToMangoImageResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body from mango-image (the image record on 200, or null). */
  body: unknown;
  /** Error message if the call couldn't be made (config missing, network). */
  error?: string;
}

/**
 * Upload an image to mango-image. The caller decides WHEN to call this
 * (on-scrape, cron, backfill). This helper is the transport.
 *
 * Returns a result; never throws on HTTP errors (check `ok` / `status`).
 * Throws only on unexpected programmer errors.
 */
export async function uploadImageToMangoImage(
  config: EnvConfig,
  input: UploadToMangoImageInput,
): Promise<UploadToMangoImageResult> {
  const base = config.get(MANGO_IMAGE_URL_ENV);
  const apiKey = config.get(MANGO_IMAGE_API_KEY_ENV);
  if (!base) {
    return { ok: false, status: 0, body: null, error: `Missing env ${MANGO_IMAGE_URL_ENV}` };
  }
  if (!apiKey) {
    return { ok: false, status: 0, body: null, error: `Missing env ${MANGO_IMAGE_API_KEY_ENV}` };
  }

  const url = new URL("/upload", base);
  url.searchParams.set("key", input.canonicalKey);
  if (input.replace ?? true) url.searchParams.set("replace", "true");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": input.contentType ?? "application/octet-stream",
      },
      // Uint8Array is a BufferSource; cast to BodyInit for the TS DOM lib.
      body: input.body as BodyInit,
      signal: input.signal,
    });
  } catch (e) {
    return { ok: false, status: 0, body: null, error: (e as Error).message };
  }

  let bodyJson: unknown = null;
  try {
    bodyJson = await res.json();
  } catch {
    bodyJson = null;
  }
  return { ok: res.ok, status: res.status, body: bodyJson };
}
