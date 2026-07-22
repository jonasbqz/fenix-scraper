/**
 * Verification: query the real DB and confirm that the just-finished
 * scrape actually wrote the data correctly.
 *
 * Checks:
 *   1. Total chapters for the Olympus scan group
 *   2. How many of those have non-empty urlPages (the bug we just fixed)
 *   3. Page URL origins (should all be media.imagesolymp.xyz)
 *   4. comicScans.externalUrl (should point to olympusxyz.com, not proxy)
 *
 * Run with:
 *   bun run src/olympus.verify.ts
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  chapters,
  comicScans,
  comics,
  scanGroups,
} from "@/database/schema";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required (set it in .env or env vars)");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  const tag = ok ? "✅" : "❌";
  console.log(`  ${tag} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== DB Verification — Olympus scrape results ===\n");

  // 1. Find the Olympus scan group
  const sg = await db
    .select()
    .from(scanGroups)
    .where(eq(scanGroups.slug, "olympus"))
    .limit(1);
  if (sg.length === 0) {
    console.log("❌ No Olympus scan group in DB. Aborting.");
    process.exit(1);
  }
  const scanGroupId = sg[0].id;
  console.log(
    `Scan group: id=${scanGroupId} name="${sg[0].name}" website="${sg[0].website}"\n`,
  );
  check(
    "scan group website is olympusxyz.com",
    sg[0].website === "https://olympusxyz.com",
    `got "${sg[0].website}"`,
  );

  // 2. Get all comicScans for Olympus
  const scans = await db
    .select({
      comicScanId: comicScans.id,
      comicId: comicScans.comicId,
      externalId: comicScans.externalId,
      externalUrl: comicScans.externalUrl,
      title: comics.title,
      coverImage: comics.coverImage,
    })
    .from(comicScans)
    .innerJoin(comics, eq(comics.id, comicScans.comicId))
    .where(eq(comicScans.scanGroupId, scanGroupId));

  console.log(`Comics linked to Olympus: ${scans.length}`);

  if (scans.length === 0) {
    console.log("❌ No comics linked to Olympus. Aborting.");
    process.exit(1);
  }

  // 3. Verify externalUrl pattern
  const proxyLeaks = scans.filter((s) =>
    s.externalUrl?.includes("mango-proxy"),
  );
  check(
    "no externalUrl points to mango-proxy",
    proxyLeaks.length === 0,
    `leaks=${proxyLeaks.length}`,
  );
  const wrongOrigin = scans.filter(
    (s) =>
      s.externalUrl &&
      !s.externalUrl.startsWith("https://olympusxyz.com/series/"),
  );
  check(
    "all externalUrls point to olympusxyz.com/series/...",
    wrongOrigin.length === 0,
    `wrong=${wrongOrigin.length}`,
  );

  // 4. Check cover image origin
  const proxyCoverLeaks = scans.filter(
    (s) => s.coverImage?.includes("mango-proxy"),
  );
  check(
    "no cover image points to mango-proxy",
    proxyCoverLeaks.length === 0,
    `leaks=${proxyCoverLeaks.length}`,
  );
  const wrongCoverOrigin = scans.filter(
    (s) =>
      s.coverImage &&
      !s.coverImage.startsWith("https://media.imagesolymp.xyz/"),
  );
  check(
    "all cover images point to media.imagesolymp.xyz",
    wrongCoverOrigin.length === 0,
    `wrong=${wrongCoverOrigin.length} sample=${
      scans.find((s) => s.coverImage && !s.coverImage.startsWith("https://media.imagesolymp.xyz/"))?.coverImage ?? "none"
    }`,
  );

  // 5. Get all chapters for these scans
  const scanIds = scans.map((s) => s.comicScanId);
  const ch = await db
    .select({
      id: chapters.id,
      chapterNumber: chapters.chapterNumber,
      title: chapters.title,
      urlPages: chapters.urlPages,
      comicScanId: chapters.comicScanId,
      createdAt: chapters.createdAt,
    })
    .from(chapters)
    .where(
      sql`${chapters.comicScanId} = ANY(${sql.raw(`ARRAY[${scanIds.join(",")}]::int[]`)})`,
    );

  const totalChapters = ch.length;
  const withPages = ch.filter((c) => c.urlPages && c.urlPages.length > 0);
  const emptyPages = ch.filter((c) => !c.urlPages || c.urlPages.length === 0);

  console.log(`\nTotal chapters: ${totalChapters}`);
  console.log(`  with non-empty urlPages: ${withPages.length}`);
  console.log(`  with empty urlPages:    ${emptyPages.length}`);

  check(
    "at least one chapter has non-empty urlPages",
    withPages.length > 0,
    `count=${withPages.length}`,
  );

  // 6. Check page URL origins
  const allPageUrls = withPages.flatMap((c) => c.urlPages ?? []);
  const origins = new Set<string>();
  for (const u of allPageUrls) {
    try {
      origins.add(new URL(u).origin);
    } catch {}
  }
  console.log(`\nPage URL origins (${origins.size}):`);
  for (const o of origins) console.log(`  ${o}`);

  check(
    "all page URLs are https",
    allPageUrls.every((u) => u.startsWith("https://")),
    `total=${allPageUrls.length}`,
  );
  check(
    "all page URLs come from a single CDN origin",
    origins.size === 1,
    `origins=${[...origins].join(", ")}`,
  );
  check(
    "that CDN is media.imagesolymp.xyz",
    origins.has("https://media.imagesolymp.xyz"),
    `origins=${[...origins].join(", ")}`,
  );
  check(
    "no page URL points to mango-proxy",
    !allPageUrls.some((u) => u.includes("mango-proxy")),
    `total=${allPageUrls.length}`,
  );

  // 7. Sample a recent chapter and show its urlPages
  if (withPages.length > 0) {
    const recent = withPages
      .sort((a, b) => +b.createdAt! - +a.createdAt!)[0];
    const scan = scans.find((s) => s.comicScanId === recent.comicScanId);
    console.log(
      `\nSample chapter (most recent):`,
    );
    console.log(`  comic:     ${scan?.title}`);
    console.log(`  chapter #: ${recent.chapterNumber}`);
    console.log(`  title:     ${recent.title}`);
    console.log(`  pages:     ${recent.urlPages?.length ?? 0}`);
    console.log(`  first 3 page URLs:`);
    for (const p of (recent.urlPages ?? []).slice(0, 3)) {
      console.log(`    ${p}`);
    }
  }

  // 8. Recent additions (last 5 min) — proves the scrape just ran
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentAdditions = ch.filter(
    (c) => c.createdAt && c.createdAt > fiveMinAgo,
  );
  console.log(
    `\nChapters added in the last 5 min: ${recentAdditions.length}`,
  );
  check(
    "scrape just wrote at least one chapter",
    recentAdditions.length > 0,
    `count=${recentAdditions.length}`,
  );

  // ── Summary ────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  console.log(
    `\n=== Summary ===\n` +
      `Checks: ${passed}/${checks.length} passed, ${failed} failed\n`,
  );
  if (failed > 0) {
    process.exit(1);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("\n[verify] crashed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
