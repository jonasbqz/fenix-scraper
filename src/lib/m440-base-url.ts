import type { EnvConfig } from "./config";
import { isM440ScraplingCookiesEnabled } from "./m440-cookie-session";

export const M440_ORIGIN = "https://m440.in";
export const M440_PROXY = "https://mango-proxy.platformoctopus.workers.dev/m440";

/** Env var for a pre-built Cookie header (manual cf_clearance + laravel_session). */
export const M440_COOKIE_HEADER_ENV = "M440_COOKIE_HEADER";

/**
 * Base URL for HTML/API scrape requests.
 *
 * Scrapling cookies are issued for m440.in — they do NOT bypass 403 when sent
 * to mango-proxy (the worker does not forward client cookies). When cookies are
 * enabled and no explicit URL is set, default to direct origin.
 */
export function resolveM440BaseUrl(config: EnvConfig): string {
  const explicit =
    config.get("SCRAPER_M440_URL") || config.get("SCRAPER_PEERLESS_URL");
  if (explicit) return explicit;

  if (isM440ScraplingCookiesEnabled(config) || config.get(M440_COOKIE_HEADER_ENV)) {
    return M440_ORIGIN;
  }

  return M440_PROXY;
}

export function isM440ProxyUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host !== "m440.in" && host !== "s1.m440.in" && host !== "s2.m440.in";
  } catch {
    return false;
  }
}
