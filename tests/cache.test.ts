import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSnapshot, writeSnapshot } from "../lib/cache";
import { calculateStats, emptySnapshot } from "../lib/compare";
import type { Article, ArticlePair, RefreshResult, ScrapeCoverage, Source } from "../lib/types";

let sequence = 0;
function article(id: string, source: Source, date: string): Article {
  return { id, source, title: `Synthetic article ${id}`, url: `https://example.invalid/${id}`,
    urlDate: date, publishedDate: date, body: `Synthetic body for ${id}`, summary: "Synthetic summary", keywords: [] };
}

function pair(base?: Article, target?: Article): ArticlePair {
  return { id: `${base?.id ?? ""}:${target?.id ?? ""}`, base, cn: base, target, jp: target,
    status: base && target ? "MATCHED" : base ? "CN ONLY" : "JP ONLY", matchScore: base && target ? 90 : 0, highlights: [] };
}

function snapshot(dates: string[], pairs: ArticlePair[], generatedAt = new Date().toISOString()): RefreshResult {
  const bases = [...new Map(pairs.filter((p) => p.base).map((p) => [p.base!.id, p.base!])).values()];
  const targets = [...new Map(pairs.filter((p) => p.target).map((p) => [p.target!.id, p.target!])).values()];
  const initial = emptySnapshot();
  return { ...initial, mode: "live", model: "synthetic-model", generatedAt,
    run: { ...initial.run!, runId: `test-run-${++sequence}`, openaiStatus: "ok", openaiCalls: 1 },
    dateScope: dates, sourceDateScope: dates, targetDateScope: dates,
    baseArticles: bases, cnArticles: bases, targetArticles: targets, jpArticles: targets, pairs,
    stats: calculateStats(pairs, bases.length, targets.length) };
}

function coverage(dates: string[], count: number, partial: Partial<ScrapeCoverage> = {}): ScrapeCoverage {
  return { attemptedPages: 1, successfulPages: 1, failedPages: 0, listingParseFailureCount: 0,
    candidateCount: count, selectedCount: count, articleCount: count, bodyFailureCount: 0,
    articleLimitReached: false, pageLimitReached: false, requestedDates: dates,
    datesWithArticles: count ? dates : [], emptyDates: count ? [] : dates, ...partial };
}

function resetCache() {
  globalThis.__PEOPLEDIFF_CACHE__ = undefined;
  globalThis.__PEOPLEDIFF_CACHE_BY_KEY__ = undefined;
  globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ = undefined;
  globalThis.__PEOPLEDIFF_WRITABLE_DIR__ = undefined;
}

async function withArchive(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "peoplediff-cache-test-"));
  const priorDirectory = process.env.PEOPLEDIFF_DATA_DIR;
  const priorStorage = process.env.PEOPLEDIFF_STORAGE;
  process.env.PEOPLEDIFF_DATA_DIR = directory;
  process.env.PEOPLEDIFF_STORAGE = "file";
  resetCache();
  try { await run(directory); }
  finally {
    resetCache();
    if (priorDirectory === undefined) delete process.env.PEOPLEDIFF_DATA_DIR;
    else process.env.PEOPLEDIFF_DATA_DIR = priorDirectory;
    if (priorStorage === undefined) delete process.env.PEOPLEDIFF_STORAGE;
    else process.env.PEOPLEDIFF_STORAGE = priorStorage;
    await rm(directory, { recursive: true, force: true });
  }
}

test("a verified zero-publication day is saved and distinguished from an absent archive", async () => {
  await withArchive(async () => {
    const date = "2099-01-01";
    const empty = snapshot([date], []);
    empty.collection = { JP: coverage([date], 0) };
    await writeSnapshot(empty);
    const saved = await readSnapshot(date);
    assert.equal(saved.mode, "live");
    assert.equal(saved.stats.jpCount, 0);
    assert.deepEqual(saved.health?.missingDates, []);
    const absent = await readSnapshot("2099-01-02");
    assert.equal(absent.mode, "empty");
    assert.deepEqual(absent.health?.missingDates, ["2099-01-02"]);
    assert.deepEqual(absent.dailyUpdates, {});
  });
});

test("a partial weekly scrape cannot erase an older empty day and performs no writes", async () => {
  await withArchive(async (directory) => {
    const dates = ["2099-01-01", "2099-01-02"];
    const first = pair(undefined, article("first", "JP", dates[0]));
    const second = pair(undefined, article("second", "JP", dates[1]));
    await writeSnapshot(snapshot(dates, [first, second]));
    const names = ["latest.json", "index.json", ...dates.map((date) => `${date}.json`)];
    const before = await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")));
    const partial = snapshot(dates, [second]);
    partial.collection = { JP: coverage(dates, 1, { pageLimitReached: true, emptyDates: [dates[0]] }) };
    await assert.rejects(writeSnapshot(partial), /2099-01-01 JP.*上書きしません/);
    const after = await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")));
    assert.deepEqual(after, before);
  });
});

test("an apparently complete empty response cannot erase previously observed articles in either language", async () => {
  await withArchive(async (directory) => {
    const date = "2099-01-01";
    const base = article("observed-cn", "CN", date);
    const target = article("observed-jp", "JP", date);
    await writeSnapshot(snapshot([date], [pair(base, target)]));
    const before = await readFile(join(directory, `${date}.json`), "utf8");
    for (const source of ["CN", "JP"] as const) {
      const emptySide = snapshot([date], [source === "CN" ? pair(undefined, target) : pair(base)]);
      emptySide.collection = {
        CN: coverage([date], source === "CN" ? 0 : 1),
        JP: coverage([date], source === "JP" ? 0 : 1)
      };
      await assert.rejects(writeSnapshot(emptySide), new RegExp(`${source}.*保存済み.*0件`));
      assert.equal(await readFile(join(directory, `${date}.json`), "utf8"), before);
    }
    const saved = await readSnapshot(date);
    assert.equal(saved.cnArticles.length, 1);
    assert.equal(saved.jpArticles.length, 1);
  });
});

test("incomplete nonempty results cannot remove archived articles or bodies", async () => {
  await withArchive(async () => {
    const date = "2099-01-01";
    const first = article("first", "JP", date);
    const second = article("second", "JP", date);
    await writeSnapshot(snapshot([date], [pair(undefined, first), pair(undefined, second)]));
    const smaller = snapshot([date], [pair(undefined, first)]);
    smaller.collection = { JP: coverage([date], 1, { pageLimitReached: true }) };
    await assert.rejects(writeSnapshot(smaller), /不完全/);
    const lostBody = snapshot([date], [pair(undefined, first), pair(undefined, { ...second, body: "" })]);
    lostBody.collection = { JP: coverage([date], 2, { bodyFailureCount: 1 }) };
    await assert.rejects(writeSnapshot(lostBody), /不完全/);
    const saved = await readSnapshot(date);
    assert.equal(saved.jpArticles.length, 2);
    assert.equal(saved.jpArticles.find((item) => item.id === second.id)?.body, second.body);
  });
});

test("matches across publication dates suppress obsolete one-sided archive rows", async () => {
  await withArchive(async () => {
    const base = article("base", "CN", "2099-01-01");
    const target = article("target", "JP", "2099-01-02");
    await writeSnapshot(snapshot(["2099-01-01"], [pair(base)], "2099-01-02T00:00:00Z"));
    await writeSnapshot(snapshot(["2099-01-02"], [pair(base, target)], "2099-01-03T00:00:00Z"));
    const combined = await readSnapshot(undefined, { dateFrom: "2099-01-01", dateTo: "2099-01-02" });
    assert.equal(combined.pairs.length, 1);
    assert.equal(combined.stats.matched, 1);
    assert.equal(combined.stats.cnOnly, 0);
    assert.equal(combined.stats.jpOnly, 0);
  });
});

test("conflicting matches prefer the newest run and retain the displaced article", async () => {
  await withArchive(async () => {
    const firstBase = article("base-old", "CN", "2099-01-01");
    const newerBase = article("base-new", "CN", "2099-01-02");
    const target = article("target", "JP", "2099-01-01");
    await writeSnapshot(snapshot(["2099-01-01"], [pair(firstBase, target)], "2099-01-02T00:00:00Z"));
    await writeSnapshot(snapshot(["2099-01-02"], [pair(newerBase, target)], "2099-01-03T00:00:00Z"));
    const combined = await readSnapshot(undefined, { dateFrom: "2099-01-01", dateTo: "2099-01-02" });
    assert.equal(combined.stats.matched, 1);
    assert.equal(combined.stats.cnOnly, 1);
    assert.equal(combined.pairs.find((item) => item.target)?.base?.id, newerBase.id);
    assert.equal(combined.pairs.find((item) => !item.target)?.base?.id, firstBase.id);
    assert.equal(combined.pairs.filter((item) => item.target?.id === target.id).length, 1);
  });
});

test("an explicitly missing range never receives unrelated latest data", async () => {
  await withArchive(async () => {
    await writeSnapshot(snapshot(["2099-01-01"], [pair(article("old", "CN", "2099-01-01"))]));
    const absent = await readSnapshot(undefined, { dateFrom: "2099-02-01", dateTo: "2099-02-02" });
    assert.equal(absent.mode, "empty");
    assert.equal(absent.cnArticles.length, 0);
    assert.deepEqual(absent.health?.missingDates, ["2099-02-02", "2099-02-01"]);
    const partial = await readSnapshot(undefined, { dateFrom: "2099-01-01", dateTo: "2099-01-02" });
    assert.equal(partial.cnArticles.length, 1);
    assert.deepEqual(partial.health?.missingDates, ["2099-01-02"]);
  });
});

test("the default window covers seven calendar days ending yesterday in JST", async (context) => {
  context.mock.method(Date, "now", () => Date.parse("2099-01-08T03:00:00Z"));
  await withArchive(async () => {
    const dates = ["2098-12-31", "2099-01-01", "2099-01-07", "2099-01-08"];
    await writeSnapshot(snapshot(dates, dates.map((date) => pair(article(date, "CN", date)))));
    const recent = await readSnapshot();
    assert.deepEqual(recent.dateScope, ["2099-01-07", "2099-01-01"]);
    assert.deepEqual(recent.health?.missingDates, ["2099-01-06", "2099-01-05", "2099-01-04", "2099-01-03", "2099-01-02"]);
    assert.equal(recent.cnArticles.length, 2);
    assert.equal(recent.run?.openaiCalls, 1, "one refresh split into two dates must not double-count API usage");
  });
});

test("latest fallback preserves evidence that the current calendar window is missing", async (context) => {
  context.mock.method(Date, "now", () => Date.parse("2099-02-08T03:00:00Z"));
  await withArchive(async () => {
    await writeSnapshot(snapshot(["2099-01-01"], [pair(article("archived", "CN", "2099-01-01"))]));
    const fallback = await readSnapshot();
    assert.equal(fallback.cnArticles.length, 1);
    assert.equal(fallback.health?.missingDates.length, 7);
    assert.ok(fallback.health?.issues.some((issue) => issue.code === "missing_dates"));
  });
});

test("intentional historical reads do not warn that the snapshot is stale", async () => {
  await withArchive(async () => {
    const date = "2099-01-01";
    await writeSnapshot(snapshot([date], [pair(article("history", "CN", date))], "2020-01-01T00:00:00Z"));
    for (const historical of [await readSnapshot(date), await readSnapshot(undefined, { dateFrom: date, dateTo: date })]) {
      assert.equal(historical.health?.issues.some((issue) => issue.code === "stale_snapshot"), false);
    }
  });
});
