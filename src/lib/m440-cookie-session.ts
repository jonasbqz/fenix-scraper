/**
 * Cached Cloudflare cookies for m440.in requests.
 *
 * When M440_SCRAPLING_COOKIES=true, runs scripts/m440-solve.py (Scrapling
 * StealthyFetcher + solve_cloudflare) once and reuses the session for
 * curl_cffi-backed fetches until TTL expires.
 *
 * cf_clearance is bound to TLS fingerprint — Bun fetch() cannot reuse
 * Scrapling cookies; use scripts/m440-fetch.py (curl_cffi chrome131).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { EnvConfig } from "./config";
import type { Logger } from "./logger";
import { M440_COOKIE_HEADER_ENV } from "./m440-base-url";

const DEFAULT_TTL_MS = 20 * 60 * 1000;

export { M440_COOKIE_HEADER_ENV };

interface CookieCache {
  cookieHeader: string;
  expiresAt: number;
}

let cache: CookieCache | null = null;
let inFlight: Promise<string | null> | null = null;

export function isM440ScraplingCookiesEnabled(config: EnvConfig): boolean {
  return config.getBoolean("M440_SCRAPLING_COOKIES", false);
}

export function hasM440CookieBypass(config: EnvConfig): boolean {
  return Boolean(
    config.get(M440_COOKIE_HEADER_ENV)?.trim()
    || isM440ScraplingCookiesEnabled(config),
  );
}

/** m440.in / s1 / s2 — requests that need curl_cffi when cookies are active. */
export function isM440OriginHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "m440.in" || host === "s1.m440.in" || host === "s2.m440.in";
  } catch {
    return false;
  }
}

/** Prefer project venv python when present (see scripts/setup-scrapling-venv.sh). */
export function resolveM440Python(config: EnvConfig): string {
  const explicit = config.get("M440_PYTHON");
  if (explicit) return explicit;

  const venvPy = join(process.cwd(), ".venv-scrapling/bin/python3");
  if (existsSync(venvPy)) return venvPy;

  return "python3";
}

export function invalidateM440Cookies(): void {
  cache = null;
}

export async function getM440CookieHeader(
  config: EnvConfig,
  log: Logger,
): Promise<string | undefined> {
  const manual = config.get(M440_COOKIE_HEADER_ENV)?.trim();
  if (manual) {
    return manual;
  }

  if (!isM440ScraplingCookiesEnabled(config)) return undefined;

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.cookieHeader;
  }

  if (inFlight) {
    const header = await inFlight;
    return header ?? undefined;
  }

  inFlight = solveCookies(config, log).finally(() => {
    inFlight = null;
  });

  const header = await inFlight;
  return header ?? undefined;
}

interface PythonFetchResult {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
}

async function fetchM440ViaPython(
  url: string,
  init: RequestInit,
  config: EnvConfig,
  log: Logger,
): Promise<Response> {
  const scriptPath =
    config.get("M440_FETCH_SCRIPT") || join(process.cwd(), "scripts/m440-fetch.py");
  const python = resolveM440Python(config);

  // Use a 20s timeout for the Python subprocess. AbortSignal.timeout() doesn't
  // expose the timeout value on the instance, so we use a fixed value that's
  // slightly generous — the caller's signal will abort fetch() separately.
  const timeoutMs = 20_000;

  const reqHeaders: Record<string, string> = {};
  if (init.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => {
      reqHeaders[key] = value;
    });
  }

  const manual = config.get(M440_COOKIE_HEADER_ENV)?.trim();
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (manual) {
    env.M440_COOKIE_HEADER = manual;
  }
  const sessionFile =
    config.get("M440_SESSION_FILE") || join(process.cwd(), "data/m440-scrapling-session.json");
  env.M440_SESSION_FILE = sessionFile;

  const proc = Bun.spawn([python, scriptPath], {
    stdin: new Blob([JSON.stringify({ url, headers: reqHeaders })]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Wrap in a timeout so Python/curl_cffi can't hang forever
  const resultPromise = Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const [exitCode, stdout, stderr] = await new Promise<[number, string, string]>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* already exited */ }
        reject(new Error(`fetchM440ViaPython timeout after ${timeoutMs}ms url=${url}`));
      }, timeoutMs);

      resultPromise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    },
  );

  let parsed: PythonFetchResult;
  try {
    parsed = JSON.parse(stdout.trim()) as PythonFetchResult;
  } catch {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    log.warn(`[m440] curl fetch parse error: ${detail}`);
    return new Response(detail, { status: 502 });
  }

  if (!parsed.status || !parsed.bodyBase64) {
    log.warn(`[m440] curl fetch failed: ${parsed.error ?? stderr.trim() ?? "unknown"}`);
    return new Response(parsed.error ?? "fetch failed", { status: parsed.status ?? 502 });
  }

  const body = Buffer.from(parsed.bodyBase64, "base64");
  return new Response(body, {
    status: parsed.status,
    headers: parsed.headers,
  });
}

/**
 * fetch() against m440 with optional Scrapling session.
 * Direct m440 hosts use curl_cffi (Python) when cookie bypass is enabled.
 */
export async function fetchM440(
  url: string,
  init: RequestInit,
  config: EnvConfig | undefined,
  log: Logger,
): Promise<Response> {
  if (config && hasM440CookieBypass(config) && isM440OriginHost(url)) {
    return fetchM440ViaPython(url, init, config, log);
  }

  const buildHeaders = async (): Promise<Headers> => {
    const headers = new Headers(init.headers);
    if (config) {
      const cookieHeader = await getM440CookieHeader(config, log);
      if (cookieHeader) headers.set("Cookie", cookieHeader);
    }
    return headers;
  };

  const headers = await buildHeaders();
  return fetch(url, { ...init, headers });
}

async function solveCookies(config: EnvConfig, log: Logger): Promise<string | null> {
  const scriptPath =
    config.get("M440_SOLVE_SCRIPT") || join(process.cwd(), "scripts/m440-solve.py");
  const python = resolveM440Python(config);
  const ttlMs = config.getNumber("M440_COOKIE_TTL_MS", DEFAULT_TTL_MS);

  const sessionFile =
    config.get("M440_SESSION_FILE") || join(process.cwd(), "data/m440-scrapling-session.json");

  try {
    const proc = Bun.spawn([python, scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        M440_SESSION_FILE: sessionFile,
        M440_COOKIE_TTL_MS: String(ttlMs),
      },
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
      log.warn(`[m440] scrapling cookie solve failed: ${detail}`);
      return null;
    }

    const parsed = JSON.parse(stdout.trim()) as {
      ok?: boolean;
      cookieHeader?: string;
      error?: string;
    };

    if (!parsed.ok || !parsed.cookieHeader) {
      log.warn(`[m440] scrapling cookie solve: ${parsed.error ?? "no cookies"}`);
      return null;
    }

    cache = {
      cookieHeader: parsed.cookieHeader,
      expiresAt: Date.now() + ttlMs,
    };
    log.log("[m440] scrapling cookies refreshed (Cloudflare bypass active)");
    return parsed.cookieHeader;
  } catch (e) {
    log.warn(`[m440] scrapling cookie solve exception: ${(e as Error).message}`);
    return null;
  }
}
