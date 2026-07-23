import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/database/schema";
import { Logger } from "@/lib/logger";
import { EnvConfig } from "@/lib/config";
import { ScraperQueue } from "./scraper.queue";
import { OlympusAdapter } from "./adapters/olympus.adapter";
import { IkigaiAdapter } from "./adapters/ikigai.adapter";
import { PeerlessAdapter } from "./adapters/m440.adapter";
import { NobledicionAdapter } from "./adapters/nobledicion.adapter";
import { TaurusAdapter } from "./adapters/taurus.adapter";
import { LeerCapituloAdapter } from "./adapters/leercapitulo.adapter";
import type { ScraperResult } from "./scraper.types";
import type { RetryQueue } from "@/lib/retry-queue";
import { resolveM440BaseUrl } from "@/lib/m440-base-url";

type ScraperMode = "m440_disabled" | "m440_only" | "all";

export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly delayMs: number;
  private readonly scraperMode: ScraperMode;

  constructor(
    private db: NodePgDatabase<typeof schema>,
    private config: EnvConfig,
    private queue: ScraperQueue,
    private retryQueue?: RetryQueue,
  ) {
    this.delayMs = this.config.getNumber("SCRAPER_DELAY_MS", 2000);
    this.scraperMode = this.getScraperMode();
  }

  getStatus() {
    return this.queue.getStatus();
  }

  /**
   * Force reset the scraper queue when it gets stuck
   */
  forceReset() {
    return this.queue.forceReset();
  }

  async triggerScraper(
    scraperName: string,
    options?: { startPage?: number; endPage?: number; postsPerPage?: number },
  ) {
    this.assertScraperEnabled(scraperName);

    if (this.queue.isRunning(scraperName)) {
      throw new Error(`Scraper "${scraperName}" is already running.`);
    }

    switch (scraperName) {
      case "olympus":
        return this.scrapeOlympus(options?.startPage, options?.endPage);
      case "ikigai":
        return this.scrapeIkigai(options?.startPage, options?.endPage);
      case "peerless":
      case "m440":
        return this.scrapePeerless(options?.startPage, options?.endPage);
      case "nobledicion":
        return this.scrapeNobledicion(
          options?.startPage,
          options?.endPage,
          options?.postsPerPage,
        );
      case "taurus":
        return this.scrapeTaurus(
          options?.startPage,
          options?.endPage,
          options?.postsPerPage,
        );
      case "leercapitulo":
        return this.scrapeLeerCapitulo(
          options?.startPage,
          options?.endPage,
          options?.postsPerPage,
        );
      default:
        throw new Error(`Unknown scraper: ${scraperName}`);
    }
  }

  private async scrapeOlympus(
    startPage = 1,
    endPage = 5,
  ): Promise<ScraperResult> {
    return this.queue.enqueue("olympus", async () => {
      this.logger.log(`Scraping Olympus pages ${startPage}-${endPage}...`);

      const adapter = new OlympusAdapter(this.db, this.delayMs);
      const result = await adapter.scrape(startPage, endPage);

      this.logger.log(
        `Olympus scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapeIkigai(
    startPage = 1,
    endPage = 10,
  ): Promise<ScraperResult> {
    return this.queue.enqueue("ikigai", async () => {
      this.logger.log(`Scraping Ikigai pages ${startPage}-${endPage}...`);

      const baseUrl = this.config.get<string>("SCRAPER_IKIGAI_URL");
      const adapter = new IkigaiAdapter(this.db, this.delayMs, baseUrl);
      const result = await adapter.scrape(startPage, endPage);

      this.logger.log(
        `Ikigai scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapePeerless(
    startPage = 1,
    endPage = 10,
  ): Promise<ScraperResult> {
    return this.queue.enqueue("peerless", async () => {
      this.logger.log(`Scraping Peerless pages ${startPage}-${endPage}...`);

      const baseUrl = resolveM440BaseUrl(this.config);
      // Pass config + scraperMode + scraperName so the adapter can run the
      // Rule #1 gate (mango-image upload of m440/peerless chapter pages).
      // The adapter is responsible for short-circuiting when the env vars
      // or mode don't permit the upload.
      const adapter = new PeerlessAdapter(
        this.db,
        this.delayMs,
        baseUrl,
        this.config,
        this.scraperMode,
        "peerless",
        this.retryQueue,
      );
      const result = await adapter.scrape(startPage, endPage);

      this.logger.log(
        `Peerless scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapeNobledicion(
    startPage = 0,
    endPage = 3,
    postsPerPage = 18,
  ): Promise<ScraperResult> {
    return this.queue.enqueue("nobledicion", async () => {
      this.logger.log(
        `Scraping Nobledicion pages ${startPage}-${endPage} (${postsPerPage} posts/page)...`,
      );

      const baseUrl = this.config.get<string>("SCRAPER_NOBLEDICION_URL");
      const adapter = new NobledicionAdapter(this.db, this.delayMs, baseUrl);
      const result = await adapter.scrape(startPage, endPage, postsPerPage);

      this.logger.log(
        `Nobledicion scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapeTaurus(
    startPage = 0,
    endPage = 3,
    postsPerPage = 18,
  ): Promise<ScraperResult> {
    return this.queue.enqueue("taurus", async () => {
      this.logger.log(
        `Scraping Taurus pages ${startPage}-${endPage} (${postsPerPage} posts/page)...`,
      );

      const baseUrl = this.config.get<string>("SCRAPER_TAURUS_URL");
      const adapter = new TaurusAdapter(this.db, this.delayMs, baseUrl);
      const result = await adapter.scrape(startPage, endPage, postsPerPage);

      this.logger.log(
        `Taurus scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapeLeerCapitulo(
    startPage = 1,
    endPage = 1,
    postsPerPage = 18,
  ): Promise<ScraperResult> {
    return this.queue.enqueue("leercapitulo", async () => {
      this.logger.log(
        `Scraping LeerCapitulo pages ${startPage}-${endPage}...`,
      );

      const baseUrl = this.config.get<string>("SCRAPER_LEERCAPITULO_URL");
      const adapter = new LeerCapituloAdapter(this.db, this.delayMs, baseUrl);
      const result = await adapter.scrape(startPage, endPage, postsPerPage);

      this.logger.log(
        `LeerCapitulo scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private getScraperMode(): ScraperMode {
    const raw = this.config.get<string>("SCRAPER_MODE") || "m440_disabled";
    const normalized = raw.trim().toLowerCase().replace(/-/g, "_");

    if (normalized === "m440_only" || normalized === "only_m440") {
      return "m440_only";
    }

    if (normalized === "all" || normalized === "all_enabled") {
      return "all";
    }

    if (
      normalized === "m440_disabled"
      || normalized === "no_m440"
      || normalized === "default"
      || normalized === "production"
    ) {
      return "m440_disabled";
    }

    throw new Error(
      `Invalid SCRAPER_MODE="${raw}". Use m440_disabled, m440_only, or all.`,
    );
  }

  private assertScraperEnabled(scraperName: string): void {
    const isM440 = scraperName === "m440" || scraperName === "peerless";

    if (this.scraperMode === "all") {
      return;
    }

    if (this.scraperMode === "m440_only") {
      if (isM440) return;
      throw new Error(
        `Scraper "${scraperName}" is disabled because SCRAPER_MODE=m440_only. Only m440/peerless can run.`,
      );
    }

    if (isM440) {
      throw new Error(
        `m440/peerless scraper is disabled because SCRAPER_MODE=m440_disabled. Use SCRAPER_MODE=m440_only or SCRAPER_MODE=all when you intentionally want to run it.`,
      );
    }
  }
}
