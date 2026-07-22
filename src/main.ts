import { createScraperRuntime } from "@/lib/runtime";
import { getScraperMode, getScrapersForMode, type ScraperName } from "@/lib/scraper-mode";

interface CliOptions {
  name: ScraperName | "all";
  startPage?: number;
  endPage?: number;
  postsPerPage?: number;
}

function printUsage(): never {
  console.error(`
Usage:
  bun run scrape <ikigai|olympus|peerless|m440|nobledicion|taurus|all> [--start=1] [--end=3] [--posts-per-page=18]

Examples:
  bun run scrape ikigai --start=1 --end=3
  bun run scrape nobledicion --start=0 --end=1 --posts-per-page=6
  bun run scrape taurus --start=0 --end=1 --posts-per-page=6
  SCRAPER_MODE=m440_only bun run scrape m440 --start=1 --end=1
  SCRAPER_MODE=all bun run scrape all --start=1 --end=1
  bun run scrape all --start=1 --end=1
`);
  process.exit(1);
}

function parseNumberFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flag}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const [nameArg, ...rest] = argv;
  if (!nameArg) printUsage();

  const valid = new Set([
    "ikigai",
    "olympus",
    "peerless",
    "m440",
    "nobledicion",
    "taurus",
    "all",
  ]);
  if (!valid.has(nameArg)) printUsage();

  const flags = new Map<string, string>();
  for (const arg of rest) {
    if (!arg.startsWith("--")) continue;
    const [key, value = ""] = arg.slice(2).split("=", 2);
    flags.set(key, value);
  }

  return {
    name: nameArg as CliOptions["name"],
    startPage: parseNumberFlag(flags.get("start"), "--start"),
    endPage: parseNumberFlag(flags.get("end"), "--end"),
    postsPerPage: parseNumberFlag(flags.get("posts-per-page"), "--posts-per-page"),
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const { service, config, close } = await createScraperRuntime();
  const scraperMode = getScraperMode(config);

  try {
    const names: ScraperName[] =
      options.name === "all"
        ? getScrapersForMode(scraperMode)
        : [options.name];

    const results = [];
    for (const name of names) {
      console.log(`[mango-scraper] Starting ${name}`);
      const result = await service.triggerScraper(name, {
        startPage: options.startPage,
        endPage: options.endPage,
        postsPerPage: options.postsPerPage,
      });
      results.push({ name, result });
      console.log(
        `[mango-scraper] Finished ${name}: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );
    }

    console.log(JSON.stringify({ ok: true, results }, null, 2));
  } finally {
    await close();
  }
}

run().catch((error) => {
  console.error("[mango-scraper] Failed:", error);
  process.exit(1);
});
