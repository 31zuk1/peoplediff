import assert from "node:assert/strict";
import test from "node:test";
import { scrapePeopleDetailed } from "../lib/scraper";

const feed = "https://j.people.com.cn/94765/index.html";
const pageUrl = (page: number) => page === 1 ? feed : feed.replace("index.html", `index${page}.html`);
const articleUrl = (date: string, id: number) =>
  `https://j.people.com.cn/n3/${date.slice(0, 4)}/${date.slice(5).replace("-", "")}/c94474-${id}.html`;
const row = (date: string, id: number, heading = "h3") =>
  `<div class="list"><${heading}><a href="${articleUrl(date, id)}">収集検証用の記事 ${id}</a></${heading}><span class="time">${date} 12:00</span></div>`;
const listing = (rows: string, next?: number, sidebar = "") =>
  `<div class="j-d2tuwen"><div class="left">${rows}${next ? `<a href="index${next}.html">次ページ</a>` : ""}</div><aside>${sidebar}</aside></div>`;

async function withWeb(
  pages: Record<string, string | number>,
  run: (requested: string[]) => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.__PEOPLEDIFF_ARTICLE_CACHE__ = new Map();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const value = pages[url];
    if (typeof value === "number") return new Response("Failed", { status: value });
    if (typeof value === "string") return new Response(value);
    if (/\/n3\//.test(url)) {
      return new Response(`<h1>収集検証用の記事 ${url.match(/-(\d+)\.html/)?.[1]}</h1><article><p>これは収集処理を検証するための架空の記事本文です。実際のニュースや保存済みのスナップショットは使用していません。</p></article>`);
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  try {
    await run(requested);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__PEOPLEDIFF_ARTICLE_CACHE__ = undefined;
  }
}

test("a sparse publication week is observed as 16 articles with valid empty dates", async () => {
  const days = Array.from({ length: 7 }, (_, index) => `2026-10-0${index + 1}`);
  const rows = [
    ...Array.from({ length: 8 }, (_, id) => row("2026-10-06", 100 + id)),
    ...Array.from({ length: 8 }, (_, id) => row("2026-10-02", 200 + id)),
    row("2026-09-30", 300)
  ].join("");
  await withWeb({
    [feed]: listing(rows, 2),
    [pageUrl(2)]: listing(row("2026-09-30", 301), 3)
  }, async (requested) => {
    const result = await scrapePeopleDetailed("JP", { dates: days });
    assert.equal(result.articles.length, 16);
    assert.deepEqual(result.collection.emptyDates, ["2026-10-01", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-07"]);
    assert.equal(result.collection.pageLimitReached, false);
    assert.equal(result.collection.listingParseFailureCount, 0);
    assert.equal(result.collection.earliestDiscoveredDate, "2026-09-30");
    assert.deepEqual(result.warnings, []);
    assert.equal(requested.filter((url) => url.includes("/94765/")).length, 2);
  });
});

test("default pagination reaches an older refresh day beyond three pages", async () => {
  const pages: Record<string, string> = {};
  for (let page = 1; page <= 10; page += 1) {
    const date = page < 9 ? "2026-10-02" : page === 9 ? "2026-10-01" : "2026-09-30";
    pages[pageUrl(page)] = listing(row(date, page), page + 1);
  }
  await withWeb(pages, async (requested) => {
    const result = await scrapePeopleDetailed("JP", { dates: ["2026-10-01"] });
    assert.equal(result.articles.length, 1);
    assert.equal(result.collection.pageLimitReached, false);
    assert.equal(requested.filter((url) => url.includes("/94765/")).length, 10);
  });
});

test("pagination limits are explicit rather than a silent empty day", async () => {
  await withWeb({
    [feed]: listing(row("2026-10-06", 1), 2),
    [pageUrl(2)]: listing(row("2026-10-05", 2), 3)
  }, async () => {
    const result = await scrapePeopleDetailed("JP", { dates: ["2026-10-01"], maxPages: 2 });
    assert.equal(result.articles.length, 0);
    assert.equal(result.collection.pageLimitReached, true);
    assert.match(result.warnings.join(" "), /一覧ページ数上限/);
  });
});

test("a linked next page returning 404 is not a verified empty day", async () => {
  await withWeb({
    [feed]: listing(row("2026-10-06", 1), 2),
    [pageUrl(2)]: 404
  }, async () => {
    const result = await scrapePeopleDetailed("JP", { dates: ["2026-10-01"] });
    assert.equal(result.collection.articleCount, 0);
    assert.equal(result.collection.failedPages, 1);
    assert.match(result.warnings.join(" "), /一覧取得失敗/);
  });
});

test("heading changes remain readable while newer sidebar articles stay excluded", async () => {
  await withWeb({
    [feed]: listing(row("2026-10-02", 1, "h2") + row("2026-09-30", 2), 2, row("2026-10-06", 3))
  }, async () => {
    const result = await scrapePeopleDetailed("JP", { dates: ["2026-10-02", "2026-10-06"] });
    assert.equal(result.articles.length, 1);
    assert.equal(result.collection.latestDiscoveredDate, "2026-10-02");
    assert.equal(result.collection.listingParseFailureCount, 0);
  });
});

test("a successful HTTP response with an unreadable listing is a collection failure", async () => {
  await withWeb({ [feed]: "<main><p>Temporarily unavailable</p></main>" }, async (requested) => {
    const result = await scrapePeopleDetailed("JP", { dates: ["2026-10-01"] });
    assert.equal(result.collection.successfulPages, 1);
    assert.equal(result.collection.listingParseFailureCount, 1);
    assert.equal(result.collection.articleCount, 0);
    assert.match(result.warnings.join(" "), /記事リンクを抽出できません/);
    assert.equal(requested.length, 1);
  });
});

test("article caps and body failures retain coverage evidence", async () => {
  await withWeb({
    [feed]: listing(row("2026-10-02", 1) + row("2026-10-02", 2) + row("2026-09-30", 3)),
    [articleUrl("2026-10-02", 1)]: 503,
    [articleUrl("2026-10-02", 2)]: 503
  }, async () => {
    const result = await scrapePeopleDetailed("JP", { dates: ["2026-10-02"], maxArticles: 1 });
    assert.equal(result.articles.length, 1);
    assert.equal(result.collection.candidateCount, 2);
    assert.equal(result.collection.selectedCount, 1);
    assert.equal(result.collection.articleLimitReached, true);
    assert.equal(result.collection.bodyFailureCount, 1);
    assert.equal(result.articles[0].body, "");
  });
});

test("URL date and article publication date remain separate", async () => {
  await withWeb({
    [feed]: listing(row("2026-10-02", 1) + row("2026-09-30", 2)),
    [articleUrl("2026-10-02", 1)]: '<h1>日付差異の検証記事</h1><time datetime="2026-10-03T09:00:00+09:00"></time><article><p>公開日とURLに含まれる日付が異なるケースを再現するための架空の記事本文をここに配置します。</p></article>'
  }, async () => {
    const result = await scrapePeopleDetailed("JP", { dates: ["2026-10-02"] });
    assert.equal(result.articles[0].urlDate, "2026-10-02");
    assert.equal(result.articles[0].publishedDate, "2026-10-03");
    assert.equal(result.articles[0].dateMismatch, true);
  });
});
