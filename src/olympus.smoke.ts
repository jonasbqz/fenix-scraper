/**
 * Smoke test for the Olympus scraper against the deployed `mango-proxy`.
 *
 * Replays the exact HTTP flow the real `OlympusAdapter` performs (same
 * endpoints, same headers), but bounded to 1 comic + 1 chapter so the
 * test runs in seconds. No database is touched — only the proxy is hit.
 *
 * Run with:
 *   bun run src/olympus.smoke.ts
 *
 * What this validates:
 *   1. /olympus/api/new-chapters?page=1  -> 200, JSON, has data[]
 *   2. /olympus/api/series/<slug>        -> 200, JSON, has full comic
 *   3. /olympus-dashboard/api/series/<slug>/chapters?page=1
 *                                       -> 200, JSON, has chapters + meta
 *   4. /olympus/capitulo/<id>/comic-<slug> -> 200, HTML, has __NUXT_DATA__
 *   5. Image URLs in pages[] point at the dashboard origin
 *      (https://dashboard.olympusxyz.com/...)
 *
 * If all five pass, the proxy + upstream + JSON shape are confirmed
 * end-to-end and the real scraper is safe to run against the DB.
 */

const PROXY = "https://mango-proxy.platformoctopus.workers.dev";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const ORIGIN = "https://olympusxyz.com";

const headers = {
  Accept: "application/json",
  "User-Agent": UA,
  Origin: ORIGIN,
  Referer: ORIGIN,
};

const headersHtml = {
  Accept: "text/html",
  "User-Agent": UA,
};

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
  console.log(
    "=== Olympus Scraper — Smoke Test (no DB, 1 comic, 1 chapter) ===\n",
  );
  console.log(`Proxy: ${PROXY}`);
  console.log(`Origin header: ${ORIGIN}\n`);

  const t0 = Date.now();

  // ── Step 1: new-chapters list ─────────────────────────────────────
  console.log("Step 1: GET /olympus-dashboard/api/new-chapters?type=comic&direction=asc&page=1");
  const listRes = await fetch(
    `${PROXY}/olympus-dashboard/api/new-chapters?type=comic&direction=asc&page=1`,
    { headers },
  );
  const listBody: any = await listRes.json();
  check(
    "200 OK + JSON",
    Boolean(listRes.ok && listRes.headers.get("content-type")?.includes("json")),
    `status=${listRes.status} ct=${listRes.headers.get("content-type")}`,
  );
  const items: any[] = Array.isArray(listBody?.data) ? listBody.data : [];
  check(
    "has data[] with items",
    items.length > 0,
    `count=${items.length}`,
  );

  // Pick the first non-novel item
  const first = items.find((i: any) => i.type?.toLowerCase() !== "novel") ?? items[0];
  if (!first) {
    console.log("\n❌ No items to test with. Aborting.");
    return;
  }
  const { id: chapterListId, slug, name: listName } = first;
  console.log(
    `  -> first item: id=${chapterListId} slug=${slug} name="${listName}"\n`,
  );

  // ── Step 2: series detail ──────────────────────────────────────────
  console.log("Step 2: GET /olympus-dashboard/api/series/<slug>");
  const seriesRes = await fetch(`${PROXY}/olympus-dashboard/api/series/${slug}`, {
    headers,
  });
  const seriesBody: any = await seriesRes.json();
  const data = seriesBody?.data;
  check(
    "200 OK + JSON",
    Boolean(seriesRes.ok && seriesRes.headers.get("content-type")?.includes("json")),
    `status=${seriesRes.status}`,
  );
  check(
    "has data with name + cover",
    Boolean(data?.name && data?.cover),
    `name="${data?.name}" cover="${data?.cover}"`,
  );
  check(
    "data has expected fields",
    Boolean(data?.id && data?.slug && data?.status && data?.type),
    `id=${data?.id} status=${data?.status?.name} type=${data?.type}`,
  );

  // Check cover image origin. The new upstream serves covers from the
  // media.imagesolymp.xyz CDN (not dashboard.olympusxyz.com as initially
  // expected) — we just confirm the URL is well-formed and uses https.
  if (data?.cover) {
    let coverOrigin = "?";
    let coverOk = false;
    try {
      coverOrigin = new URL(data.cover).origin;
      coverOk = coverOrigin === "https://media.imagesolymp.xyz";
    } catch {
      coverOk = false;
    }
    check(
      "cover image points to media.imagesolymp.xyz CDN",
      coverOk,
      `origin=${coverOrigin}`,
    );
  }

  // ── Step 3: chapters list (dashboard API) ──────────────────────────
  console.log("\nStep 3: GET /olympus-dashboard/api/series/<slug>/chapters?page=1");
  const chaptersRes = await fetch(
    `${PROXY}/olympus-dashboard/api/series/${slug}/chapters?page=1&direction=desc&type=comic`,
    { headers },
  );
  const chaptersBody: any = await chaptersRes.json();
  check(
    "200 OK + JSON",
    Boolean(chaptersRes.ok && chaptersRes.headers.get("content-type")?.includes("json")),
    `status=${chaptersRes.status}`,
  );
  const chapters: any[] = Array.isArray(chaptersBody?.data)
    ? chaptersBody.data
    : [];
  check(
    "chapters list non-empty",
    chapters.length > 0,
    `count=${chapters.length} total=${chaptersBody?.meta?.total ?? "?"}`,
  );

  // Pick a chapter that has both id and name
  const firstChapter = chapters.find((c: any) => c?.id && c?.name) ?? chapters[0];
  if (!firstChapter) {
    console.log("\n❌ No chapter to test. Aborting.");
    return;
  }
  const chapterId = String(firstChapter.id);
  const chapterName = firstChapter.name;
  console.log(
    `  -> first chapter: id=${chapterId} name="${chapterName}"\n`,
  );

  // ── Step 4: chapter HTML (main site) ───────────────────────────────
  console.log("Step 4: GET /olympus/capitulo/<id>/comic-<slug>");
  const htmlRes = await fetch(
    `${PROXY}/olympus/capitulo/${chapterId}/comic-${slug}`,
    { headers: headersHtml },
  );
  const html = await htmlRes.text();
  check(
    "200 OK + HTML",
    htmlRes.ok && (htmlRes.headers.get("content-type") ?? "").includes("text/html"),
    `status=${htmlRes.status} size=${html.length}b`,
  );

  const nuxtMatch = html.match(
    /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  check(
    "HTML contains __NUXT_DATA__ script",
    !!nuxtMatch,
    nuxtMatch ? `payload=${nuxtMatch[1].length}b` : "missing",
  );

  // ── Step 5: parse page image URLs ─────────────────────────────────
  if (nuxtMatch) {
    console.log("\nStep 5: parse __NUXT_DATA__ for image URLs");
    let nuxtArr: any;
    try {
      nuxtArr = JSON.parse(nuxtMatch[1]);
    } catch (e: any) {
      check("__NUXT_DATA__ is valid JSON", false, e.message);
    }
    if (Array.isArray(nuxtArr)) {
      // Mirror the new filter the adapter uses: image URLs from the
      // media.imagesolymp.xyz CDN at /comics/<id>/<id>/<page>_<sub>.webp.
      const pages = nuxtArr.filter(
        (item: any): item is string =>
          typeof item === "string" &&
          (item.includes("media.imagesolymp.xyz/comics/") ||
            item.includes("/storage/comics/")) &&
          /\.(webp|jpg|jpeg|png)$/i.test(item),
      );
      check("found page image URLs", pages.length > 0, `count=${pages.length}`);

      if (pages.length > 0) {
        console.log(`  first 3 pages:`);
        for (const p of pages.slice(0, 3)) {
          console.log(`    ${p}`);
        }
        if (pages.length > 3) {
          console.log(`    ... (${pages.length - 3} more)`);
        }

        // Verify all pages come from the same CDN origin.
        const origins = new Set(pages.map((p: string) => new URL(p).origin));
        console.log(`  page image origins: ${[...origins].join(", ")}`);
        check(
          "all page images come from media.imagesolymp.xyz",
          origins.size === 1 && origins.has("https://media.imagesolymp.xyz"),
          `origins=${origins.size}`,
        );
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  const seconds = ((Date.now() - t0) / 1000).toFixed(2);
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  console.log(
    `\n=== Summary ===\n` +
      `Checks: ${passed}/${checks.length} passed, ${failed} failed\n` +
      `Duration: ${seconds}s\n`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[smoke] crashed:", err);
  process.exit(1);
});
