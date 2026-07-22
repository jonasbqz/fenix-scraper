/**
 * HTTP fetch via rotating proxies using curl + Bun.spawn.
 *
 * Bun's native fetch() does NOT support HTTP proxies. We shell out to curl
 * which handles proxy auth natively. Same pattern as m440-cookie-session.ts
 * (Bun.spawn + Python) but lighter — no Python dependency.
 *
 * Each call spawns one curl process. For high-throughput scenarios, run
 * multiple fetchViaProxy calls in parallel (Promise.all) — each one uses
 * a different proxy, distributing load across IPs.
 */

import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { Logger } from "./logger";

// ── Types ──

export interface ProxyConfig {
  ip: string;
  port: number;
  user: string;
  pass: string;
}

export interface FetchViaProxyOptions {
  method?: string;
  headers?: Record<string, string>;
  proxy: ProxyConfig;
  timeoutMs?: number;
  /** Max retries on transient failures (connection reset, timeout). */
  retries?: number;
}

export interface FetchViaProxyResult {
  ok: boolean;
  status: number;
  body: Uint8Array;
  contentType: string;
  contentLength: number;
  error?: string;
}

// ── Proxy parsing ──

/**
 * Parse "ip:port:user:pass" into a ProxyConfig.
 * Throws on invalid format.
 */
export function parseProxy(raw: string): ProxyConfig {
  const parts = raw.trim().split(":");
  if (parts.length < 4) {
    throw new Error(`Invalid proxy format "${raw}" — expected ip:port:user:pass`);
  }
  const pass = parts.pop()!;
  const user = parts.pop()!;
  const portStr = parts.pop()!;
  const ip = parts.join(":");
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid proxy port "${portStr}" in "${raw}"`);
  }
  return { ip, port, user, pass };
}

/**
 * Parse M440_PROXIES env var (comma or newline separated).
 * Returns an array of ProxyConfig. Empty if env var is unset.
 */
export function parseProxiesFromEnv(raw: string | undefined): ProxyConfig[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseProxy);
}

/**
 * Build the proxy URL for curl: http://user:pass@ip:port
 */
function proxyUrl(p: ProxyConfig): string {
  return `http://${p.user}:${p.pass}@${p.ip}:${p.port}`;
}

// ── Fetch via proxy ──

/**
 * Fetch a URL through an HTTP proxy using curl.
 *
 * Spawns a curl process with:
 *   --proxy http://user:pass@ip:port
 *   --proxy-user user:pass
 *   -H headers...
 *   -s silent mode
 *   -o <tmpfile> to capture body
 *   -w "%{http_code}|%{content_type}|%{size_download}" for metadata
 *
 * The body is written to a temp file and read back. This avoids pipe
 * buffering issues with large binary responses (images).
 */
export async function fetchViaProxy(
  url: string,
  options: FetchViaProxyOptions,
): Promise<FetchViaProxyResult> {
  const {
    method = "GET",
    headers = {},
    proxy,
    timeoutMs = 30_000,
    retries = 2,
  } = options;

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await doFetchViaProxy(url, method, headers, proxy, timeoutMs);
      if (result.ok || (result.status >= 400 && result.status < 500)) {
        return result;
      }
      // Transient server error (5xx) or empty — retry
      lastError = result.error || `HTTP ${result.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }

    if (attempt < retries) {
      // Exponential backoff: 500ms, 1000ms, ...
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  return {
    ok: false,
    status: 0,
    body: new Uint8Array(0),
    contentType: "",
    contentLength: 0,
    error: lastError ?? "unknown error after retries",
  };
}

async function doFetchViaProxy(
  url: string,
  method: string,
  headers: Record<string, string>,
  proxy: ProxyConfig,
  timeoutMs: number,
): Promise<FetchViaProxyResult> {
  // Create temp file for body
  const tmpDir = mkdtempSync(join(tmpdir(), "proxy-fetch-"));
  const bodyPath = join(tmpDir, "body");
  const headerPath = join(tmpDir, "headers");

  try {
    const args: string[] = [
      "--proxy", proxyUrl(proxy),
      "--proxy-user", `${proxy.user}:${proxy.pass}`,
      "-X", method,
      "-s",
      "--show-error",
      "-o", bodyPath,
      "-D", headerPath, // dump response headers to file
      "-w", "%{http_code}|%{content_type}|%{size_download}",
      "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "--connect-timeout", "10",
      // Follow redirects
      "-L",
      // Reject insecure certs
      "--ssl-reqd",
    ];

    // Add headers
    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }

    args.push(url);

    const proc = Bun.spawn(["curl", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0 && !existsSync(bodyPath)) {
      return {
        ok: false,
        status: 0,
        body: new Uint8Array(0),
        contentType: "",
        contentLength: 0,
        error: `curl exit ${exitCode}: ${stderr.trim().slice(0, 200)}`,
      };
    }

    // Parse curl -w output: "status|content_type|size"
    const parts = stdout.trim().split("|");
    const status = parseInt(parts[0] ?? "0", 10);
    const contentType = (parts[1] ?? "").split(";")[0].trim();
    const sizeFromWrite = parseInt(parts[2] ?? "0", 10);

    // Read body
    let body: Uint8Array;
    if (existsSync(bodyPath)) {
      const buf = readFileSync(bodyPath);
      body = new Uint8Array(buf);
    } else {
      body = new Uint8Array(0);
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      body,
      contentType,
      contentLength: body.byteLength || sizeFromWrite,
      ...(status >= 400 && stderr.trim() ? { error: stderr.trim().slice(0, 200) } : {}),
    };
  } finally {
    // Cleanup temp files
    try { if (existsSync(bodyPath)) unlinkSync(bodyPath); } catch { /* ignore */ }
    try { if (existsSync(headerPath)) unlinkSync(headerPath); } catch { /* ignore */ }
    try { if (existsSync(tmpDir)) import("node:fs").then((fs) => fs.rmdirSync(tmpDir)); } catch { /* ignore */ }
  }
}

// ── Proxy Rotator ──

/**
 * Round-robin proxy rotator. Thread-safe (no shared mutable state).
 *
 * Usage:
 *   const rotator = new ProxyRotator(proxies);
 *   const proxy = rotator.next(); // returns proxies[i++ % length]
 */
export class ProxyRotator {
  private readonly proxies: ProxyConfig[];
  private index = 0;

  constructor(proxies: ProxyConfig[]) {
    if (proxies.length === 0) {
      throw new Error("ProxyRotator requires at least one proxy");
    }
    this.proxies = [...proxies];
  }

  /** Get the next proxy in rotation. */
  next(): ProxyConfig {
    const proxy = this.proxies[this.index % this.proxies.length]!;
    this.index++;
    return proxy;
  }

  /** Number of proxies in the pool. */
  get size(): number {
    return this.proxies.length;
  }

  /** Get all proxies (for parallel assignment). */
  all(): ProxyConfig[] {
    return [...this.proxies];
  }

  /** Reset rotation index to 0. */
  reset(): void {
    this.index = 0;
  }
}

// ── Convenience: fetch image via proxy with validation ──

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function isM440Host(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "m440.in" || host === "s1.m440.in" || host === "s2.m440.in";
  } catch {
    return false;
  }
}

function resolvePython(): string {
  const venvPy = join(process.cwd(), ".venv-scrapling/bin/python3");
  if (existsSync(venvPy)) return venvPy;
  return "python3";
}

/**
 * Fetch an m440 image via curl_cffi (Chrome TLS fingerprint) through a proxy.
 * cf_clearance cookies are bound to TLS fingerprint — curl_cffi chrome131
 * matches the Scrapling session fingerprint.
 */
async function fetchM440ImageViaPython(
  url: string,
  proxy: ProxyConfig,
  referer: string,
  cookieHeader: string | undefined,
  log: Logger,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const scriptPath = join(process.cwd(), "scripts/m440-fetch.py");
  if (!existsSync(scriptPath)) {
    log.warn(`[proxy] m440-fetch.py not found at ${scriptPath}`);
    return null;
  }

  const proxyUrl = `http://${proxy.user}:${proxy.pass}@${proxy.ip}:${proxy.port}`;
  const payload = {
    url,
    headers: {
      "Accept": "image/*,*/*",
      "Referer": referer,
      "Origin": "https://m440.in",
    },
    proxy: proxyUrl,
  };

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  // Per-proxy session file: cookies may be bound to the proxy's IP
  const sessionFile = join(process.cwd(), `data/m440-session-${proxy.ip.replace(/:/g, "_")}.json`);
  env.M440_SESSION_FILE = sessionFile;

  const proc = Bun.spawn([resolvePython(), scriptPath], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  interface PythonResult {
    ok?: boolean;
    status?: number;
    headers?: Record<string, string>;
    bodyBase64?: string;
    error?: string;
  }

  let parsed: PythonResult;
  try {
    parsed = JSON.parse(stdout.trim()) as PythonResult;
  } catch {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    log.warn(`[proxy] m440-fetch.py parse error: ${detail}`);
    return null;
  }

  if (!parsed.ok || !parsed.bodyBase64) {
    log.warn(`[proxy] m440-fetch.py failed: ${parsed.error ?? "unknown"}`);
    return null;
  }

  const body = Buffer.from(parsed.bodyBase64, "base64");
  const rawCt = parsed.headers?.["content-type"] || "";
  const ct = rawCt.split(";")[0].trim().toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(ct)) {
    log.warn(`[proxy] m440 bad content-type url=${url} ct=${ct}`);
    return null;
  }

  return { body: new Uint8Array(body), contentType: ct };
}

/**
 * Fetch an image through a proxy, validating content type.
 * Returns null on failure (logged internally).
 *
 * For m440 domains, uses curl_cffi (Python) with chrome131 TLS fingerprint
 * because cf_clearance cookies are bound to the TLS fingerprint.
 */
export async function fetchImageViaProxy(
  url: string,
  proxy: ProxyConfig,
  referer: string,
  timeoutMs = 15_000,
  cookieHeader?: string,
  log?: Logger,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  // m440 domains require curl_cffi (chrome131 TLS) to match Cloudflare fingerprint
  if (isM440Host(url)) {
    const logger = log ?? new Logger("proxy");
    return fetchM440ImageViaPython(url, proxy, referer, cookieHeader, logger);
  }

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": referer,
    "Origin": "https://m440.in",
    "Accept": "image/*,*/*",
  };
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  const result = await fetchViaProxy(url, {
    method: "GET",
    headers,
    proxy,
    timeoutMs,
  });

  if (!result.ok) {
    console.warn(`[proxy] fetch failed url=${url} status=${result.status} error=${result.error ?? "none"}`);
    return null;
  }

  const ct = result.contentType.toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(ct)) {
    console.warn(`[proxy] bad content-type url=${url} ct=${ct}`);
    return null;
  }

  return { body: result.body, contentType: ct };
}
