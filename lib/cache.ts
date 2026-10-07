import type { Source } from "./types";
import type {
  AnchoredArticlePair,
  Article,
  ArticlePair,
  RefreshResult,
  RefreshRunMetadata,
  ScrapeCoverage
} from "./types";
import { calculateStats, emptySnapshot } from "./compare";
import { getAvailableLanguageSummaries, resolveCompareLanguages } from "./languages";
import { createSnapshotStore, snapshotStorageBackend, usesDurableSnapshotStore } from "./snapshot-store";
import { assertUsableCollection, snapshotHealth } from "./health";

const LATEST_FILE = "latest.json";
const INDEX_FILE = "index.json";
const DEFAULT_COMPARISON_KEY = "CN-JP";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_CACHE__: RefreshResult | undefined;
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_CACHE_BY_KEY__: Record<string, RefreshResult> | undefined;
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_CACHE_BY_DATE__: Record<string, RefreshResult> | undefined;
}

type SnapshotReadOptions = {
  sourceLanguage?: unknown;
  targetLanguage?: unknown;
  source?: unknown;
  target?: unknown;
  mode?: unknown;
  collectionMode?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  windowDays?: unknown;
};

type SnapshotWriteOptions = {
  updateLatest?: boolean;
};

type SnapshotIndex = {
  updatedAt?: string;
  comparisonKey?: string;
  dates?: string[];
};

export async function readSnapshot(date?: string, options: SnapshotReadOptions = {}) {
  const languageSelection = resolveCompareLanguages(options);
  const key = comparisonKey(
    languageSelection.sourceLanguage,
    languageSelection.targetLanguage,
    snapshotCollectionMode(options)
  );
  const normalizedDate = normalizeArchiveDate(date);
  if (normalizedDate) return readDatedSnapshot(normalizedDate, key);

  const archiveDates = await listArchiveDates(key);
  const windowDates = readWindowDates(archiveDates, options);
  if (windowDates.length) {
    const aggregate = await readAggregatedSnapshot(windowDates, key, Boolean(options.dateFrom || options.dateTo));
    if (aggregate) return aggregate;
    if (options.dateFrom || options.dateTo) {
      return withArchiveDates({
        ...emptySnapshot(),
        collectionMode: collectionModeFromKey(key),
        baseLanguage: languageSelection.sourceLanguage,
        targetLanguage: languageSelection.targetLanguage
      }, undefined, key, windowDates, true);
    }
  }

  const useMemoryCache = !usesDurableSnapshotStore();
  const cachedByKey = useMemoryCache ? globalThis.__PEOPLEDIFF_CACHE_BY_KEY__?.[key] : undefined;
  if (cachedByKey) return withArchiveDates(cachedByKey, undefined, key, windowDates);

  if (useMemoryCache && key === DEFAULT_COMPARISON_KEY && globalThis.__PEOPLEDIFF_CACHE__) {
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__, undefined, key, windowDates);
  }

  const store = createSnapshotStore();
  const latest = await store.readJson<RefreshResult>(latestFileName(key));
  if (latest) {
    const cleanSnapshot = stripArchiveMetadata(latest);
    rememberSnapshot(cleanSnapshot, key);
    return withArchiveDates(cleanSnapshot, undefined, key, windowDates);
  }

  const latestDate = archiveDates[0];
  if (latestDate) {
    return withArchiveDates(await readDatedSnapshot(latestDate, key), undefined, key, windowDates);
  }

  const legacy = key === DEFAULT_COMPARISON_KEY ? await store.readLegacyJson?.<RefreshResult>() : undefined;
  if (legacy) {
    globalThis.__PEOPLEDIFF_CACHE__ = stripArchiveMetadata(legacy);
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__, undefined, key, windowDates);
  }

  return withArchiveDates(
    {
      ...emptySnapshot(),
      collectionMode: collectionModeFromKey(key),
      baseLanguage: languageSelection.sourceLanguage,
      targetLanguage: languageSelection.targetLanguage
    },
    undefined,
    key,
    windowDates
  );
}

export async function writeSnapshot(snapshot: RefreshResult, options: SnapshotWriteOptions = {}) {
  assertUsableCollection(snapshot);
  const updateLatest = options.updateLatest ?? true;
  const cleanSnapshot = stripArchiveMetadata(snapshot);
  const storedSnapshot: RefreshResult = cleanSnapshot.run
    ? {
        ...cleanSnapshot,
        run: { ...cleanSnapshot.run, storageBackend: snapshotStorageBackend() }
      }
    : cleanSnapshot;
  const store = createSnapshotStore();
  const dailySnapshots = splitSnapshotByDate(storedSnapshot);
  const key = comparisonKeyFromSnapshot(storedSnapshot);

  // Validate every day before making the first write. A weekly scrape can have
  // articles overall while failing to reach an older day, and a source lookback
  // can contain articles even when the requested day itself could not be read.
  await Promise.all([...dailySnapshots].map(async ([date, dailySnapshot]) => {
    const previous = await store.readJson<RefreshResult>(datedFileName(date, key));
    assertSafeDailyReplacement(dailySnapshot, previous, date);
  }));

  await Promise.all(
    [...dailySnapshots].map(([date, dailySnapshot]) =>
      store.writeJson(datedFileName(date, key), dailySnapshot)
    )
  );
  if (updateLatest) {
    await store.writeJson(latestFileName(key), storedSnapshot);
  }
  await writeIndex(store, key, [...dailySnapshots.keys()]);

  if (updateLatest) {
    rememberSnapshot(storedSnapshot, key);
  }
  globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ = {
    ...(globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ ?? {}),
    ...Object.fromEntries([...dailySnapshots].map(([date, daily]) => [datedCacheKey(date, key), daily]))
  };

  return withArchiveDates(storedSnapshot, undefined, key);
}

async function readDatedSnapshot(date: string, key = DEFAULT_COMPARISON_KEY) {
  const cached = !usesDurableSnapshotStore()
    ? globalThis.__PEOPLEDIFF_CACHE_BY_DATE__?.[datedCacheKey(date, key)]
    : undefined;
  if (cached) return withArchiveDates(cached, date, key);

  const archived = await createSnapshotStore().readJson<RefreshResult>(datedFileName(date, key));
  if (archived) {
    const cleanSnapshot = stripArchiveMetadata(archived);
    globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ = {
      ...(globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ ?? {}),
      [datedCacheKey(date, key)]: cleanSnapshot
    };
    return withArchiveDates(cleanSnapshot, date, key);
  }

  const [baseLanguage, targetLanguage] = languagesFromKey(key);
  const empty = {
    ...emptySnapshot(),
    collectionMode: collectionModeFromKey(key),
    baseLanguage,
    targetLanguage,
    dateScope: []
  };
  return withArchiveDates(empty, date, key, [date], true);
}

async function readAggregatedSnapshot(dates: string[], key = DEFAULT_COMPARISON_KEY, historical = false) {
  const store = createSnapshotStore();
  const snapshots = (
    await Promise.all(
      dates.map(async (date) => {
        const archived = await store.readJson<RefreshResult>(datedFileName(date, key));
        return archived ? stripArchiveMetadata(archived) : undefined;
      })
    )
  ).filter((snapshot): snapshot is RefreshResult => Boolean(snapshot));

  if (!snapshots.length) return undefined;

  return withArchiveDates(aggregateSnapshots(snapshots, key), undefined, key, dates, historical);
}

async function withArchiveDates(
  snapshot: RefreshResult,
  activeDate?: string,
  key = comparisonKeyFromSnapshot(snapshot),
  expectedDates?: string[],
  historical = false
): Promise<RefreshResult> {
  const baseLanguage = snapshot.baseLanguage ?? "CN";
  const targetLanguage = snapshot.targetLanguage ?? "JP";
  const baseArticles = snapshot.baseArticles ?? snapshot.cnArticles ?? [];
  const targetArticles = snapshot.targetArticles ?? snapshot.jpArticles ?? [];
  const dateScope = snapshot.dateScope ?? snapshot.targetDateScope ?? [];

  return {
    ...snapshot,
    schemaVersion: snapshot.schemaVersion ?? 1,
    collectionMode: snapshot.collectionMode ?? collectionModeFromKey(key),
    baseLanguage,
    targetLanguage,
    availableLanguages: snapshot.availableLanguages ?? getAvailableLanguageSummaries(),
    dateScope,
    sourceDateScope: snapshot.sourceDateScope ?? dateScope,
    targetDateScope: snapshot.targetDateScope ?? dateScope,
    sourceLookbackDays: snapshot.sourceLookbackDays ?? 3,
    baseArticles,
    targetArticles,
    cnArticles: snapshot.cnArticles ?? baseArticles,
    jpArticles: targetLanguage === "JP" ? (snapshot.jpArticles ?? targetArticles) : [],
    activeDate,
    dailyUpdates: snapshot.dailyUpdates ?? Object.fromEntries(dateScope.map((date) => [date, snapshot.generatedAt])),
    health: snapshotHealth(snapshot, { expectedDates, historical: Boolean(activeDate) || historical }),
    archiveDates: await listArchiveDates(key)
  };
}

function splitSnapshotByDate(snapshot: RefreshResult) {
  const dates = collectSnapshotDates(snapshot);
  const dailySnapshots = new Map<string, RefreshResult>();
  const baseSource = snapshot.baseArticles ?? snapshot.cnArticles;
  const targetSource = snapshot.targetArticles ?? snapshot.jpArticles;

  for (const date of dates) {
    const pairs = snapshot.pairs.filter((pair) => pairTouchesDate(pair, date));
    const anchoredPairs = snapshot.anchoredPairs?.filter((pair) => anchoredPairTouchesDate(pair, date)) ?? [];
    const baseArticles = collectArticlesForDate(baseSource, pairs, "base", date);
    const targetArticles = collectArticlesForDate(targetSource, pairs, "target", date);

    dailySnapshots.set(date, {
      ...snapshot,
      activeDate: undefined,
      archiveDates: undefined,
      health: undefined,
      dailyUpdates: { [date]: snapshot.generatedAt },
      dateScope: [date],
      sourceDateScope: collectArticleDateScope(baseArticles),
      targetDateScope: collectArticleDateScope(targetArticles),
      sourceLookbackDays: snapshot.sourceLookbackDays,
      baseArticles,
      targetArticles,
      cnArticles: baseArticles,
      jpArticles: snapshot.targetLanguage === "JP" ? targetArticles : [],
      pairs,
      anchoredPairs: anchoredPairs.length ? anchoredPairs : undefined,
      stats:
        snapshot.collectionMode === "jp-major" && anchoredPairs.length
          ? calculateAnchoredAggregateStats(anchoredPairs)
          : calculateStats(
              pairs,
              baseArticles.length,
              targetArticles.length,
              snapshot.baseLanguage ?? "CN",
              snapshot.targetLanguage ?? "JP"
            )
    });
  }

  return dailySnapshots;
}

function collectionIsIncomplete(coverage: ScrapeCoverage) {
  return coverage.failedPages > 0 || coverage.listingParseFailureCount > 0 ||
    coverage.bodyFailureCount > 0 || coverage.pageLimitReached || coverage.articleLimitReached;
}

function articlesForSource(snapshot: RefreshResult | undefined, source: string) {
  if (!snapshot) return [];
  return source === (snapshot.baseLanguage ?? "CN")
    ? snapshot.baseArticles ?? snapshot.cnArticles ?? []
    : snapshot.targetArticles ?? snapshot.jpArticles ?? [];
}

function assertSafeDailyReplacement(
  snapshot: RefreshResult,
  previous: RefreshResult | undefined,
  date: string
) {
  // A stale upstream listing can return HTTP 200 and look like a valid empty
  // day. Previously observed articles remain evidence even when that later
  // listing no longer exposes them. New, verified empty days are still allowed.
  for (const source of new Set([snapshot.baseLanguage ?? "CN", snapshot.targetLanguage ?? "JP"])) {
    if (!articlesForSource(snapshot, source).length && articlesForSource(previous, source).length) {
      throw new Error(`${date} ${source}は保存済みの記事があるため、0件の結果でアーカイブを上書きしませんでした。`);
    }
  }
  for (const [source, coverage] of Object.entries(snapshot.collection ?? {})) {
    if (!collectionIsIncomplete(coverage)) continue;
    const nextArticles = articlesForSource(snapshot, source);
    const previousArticles = articlesForSource(previous, source);
    const byId = new Map(nextArticles.map((article) => [article.id, article]));
    const wouldLoseArticles = previousArticles.some((article) => !byId.has(article.id));
    const wouldLoseBody = previousArticles.some((article) =>
      article.body && byId.has(article.id) && !byId.get(article.id)?.body
    );
    const allBodiesFailed = coverage.bodyFailureCount > 0 && nextArticles.every((article) => !article.body);
    if (!nextArticles.length || wouldLoseArticles || wouldLoseBody || allBodiesFailed) {
      throw new Error(
        `${date} ${source}の収集が不完全なため、空の結果や欠落した記事・本文でアーカイブを上書きしませんでした。`
      );
    }
  }
}

function aggregateSnapshots(snapshots: RefreshResult[], key: string): RefreshResult {
  const [fallbackBaseLanguage, fallbackTargetLanguage] = languagesFromKey(key);
  const baseLanguage = snapshots[0].baseLanguage ?? fallbackBaseLanguage;
  const targetLanguage = snapshots[0].targetLanguage ?? fallbackTargetLanguage;
  const collectionMode = snapshots[0].collectionMode ?? collectionModeFromKey(key);
  const oldestFirst = [...snapshots].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  const baseArticles = uniqueArticles(
    oldestFirst.flatMap((snapshot) => snapshot.baseArticles ?? snapshot.cnArticles ?? [])
  );
  const targetArticles = uniqueArticles(
    oldestFirst.flatMap((snapshot) => snapshot.targetArticles ?? snapshot.jpArticles ?? [])
  );
  const pairs = uniquePairs(snapshots);
  const anchoredPairs = uniqueAnchoredPairs(
    snapshots.flatMap((snapshot) => snapshot.anchoredPairs ?? [])
  );
  const dateScope = uniqueDates(snapshots.flatMap((snapshot) => snapshot.dateScope ?? []));
  const sourceDateScope = uniqueDates(snapshots.flatMap((snapshot) => snapshot.sourceDateScope ?? []));
  const targetDateScope = uniqueDates(snapshots.flatMap((snapshot) => snapshot.targetDateScope ?? []));
  const warnings = [...new Set(snapshots.flatMap((snapshot) => snapshot.warnings ?? []))];

  return {
    ...snapshots[0],
    generatedAt: latestGeneratedAt(snapshots),
    collectionMode,
    activeDate: undefined,
    archiveDates: undefined,
    dateScope,
    sourceDateScope: sourceDateScope.length ? sourceDateScope : dateScope,
    targetDateScope: targetDateScope.length ? targetDateScope : dateScope,
    baseArticles,
    targetArticles,
    cnArticles: baseArticles,
    jpArticles: targetLanguage === "JP" ? targetArticles : [],
    pairs,
    anchoredPairs: anchoredPairs.length ? anchoredPairs : undefined,
    stats:
      collectionMode === "jp-major" && anchoredPairs.length
        ? calculateAnchoredAggregateStats(anchoredPairs)
        : calculateStats(pairs, baseArticles.length, targetArticles.length, baseLanguage, targetLanguage),
    warnings,
    run: aggregateRunMetadata(snapshots),
    refreshSignature: undefined,
    dailyUpdates: Object.assign({}, ...snapshots.map((snapshot) => snapshot.dailyUpdates ??
      Object.fromEntries((snapshot.dateScope ?? []).map((date) => [date, snapshot.generatedAt])))),
    collection: aggregateCollection(snapshots)
  };
}

function collectSnapshotDates(snapshot: RefreshResult) {
  const values = new Set<string>();

  const scopedDates = snapshot.targetDateScope?.length
    ? snapshot.targetDateScope
    : snapshot.dateScope;

  scopedDates?.forEach((date) => {
    const normalized = normalizeArchiveDate(date);
    if (normalized) values.add(normalized);
  });

  if (values.size) return [...values].sort((a, b) => b.localeCompare(a));

  [
    ...(snapshot.baseArticles ?? snapshot.cnArticles),
    ...(snapshot.targetArticles ?? snapshot.jpArticles)
  ].forEach((article) => {
    const normalized = normalizeArchiveDate(articleDate(article));
    if (normalized) values.add(normalized);
  });

  return [...values].sort((a, b) => b.localeCompare(a));
}

function readWindowDates(_archiveDates: string[], options: SnapshotReadOptions) {
  const explicitRange = dateRange(
    typeof options.dateFrom === "string" ? options.dateFrom : undefined,
    typeof options.dateTo === "string" ? options.dateTo : undefined
  );
  if (explicitRange.length) {
    return explicitRange;
  }

  return Array.from({ length: readWindowDays(options.windowDays) }, (_, i) => addDays(todayInJst(), -1 - i));
}

function todayInJst() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function readWindowDays(input: unknown) {
  const configured =
    typeof input === "number" || typeof input === "string"
      ? Number(input)
      : Number(process.env.PEOPLEDIFF_READ_WINDOW_DAYS);
  if (!Number.isFinite(configured) || configured <= 0) return 7;
  return Math.min(14, Math.max(1, Math.round(configured)));
}

function dateRange(fromInput: string | undefined, toInput: string | undefined) {
  const from = normalizeArchiveDate(fromInput);
  const to = normalizeArchiveDate(toInput);
  if (!from && !to) return [];
  const start = from && to ? (from <= to ? from : to) : (from ?? to);
  const end = from && to ? (from <= to ? to : from) : (from ?? to);
  if (!start || !end) return [];

  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end && dates.length < 31) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates.sort((a, b) => b.localeCompare(a));
}

function addDays(date: string, offset: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function collectArticlesForDate(
  articles: Article[],
  pairs: ArticlePair[],
  side: "base" | "target",
  date: string
) {
  const byId = new Map<string, Article>();

  articles.forEach((article) => {
    if (articleDate(article) === date) byId.set(article.id, article);
  });

  pairs.forEach((pair) => {
    const article = side === "base" ? pair.base ?? pair.cn : pair.target ?? pair.jp;
    if (article) byId.set(article.id, article);
  });

  return [...byId.values()];
}

function collectArticleDateScope(articles: Article[]) {
  return [
    ...new Set(
      articles
        .map((article) => normalizeArchiveDate(articleDate(article)))
        .filter((date): date is string => Boolean(date && isDate(date)))
    )
  ].sort((a, b) => b.localeCompare(a));
}

function pairTouchesDate(pair: ArticlePair, date: string) {
  return (
    articleDate(pair.base ?? pair.cn) === date ||
    articleDate(pair.target ?? pair.jp) === date
  );
}

function anchoredPairTouchesDate(pair: AnchoredArticlePair, date: string) {
  return articleDate(pair.jp) === date;
}

function articleDate(article?: Article) {
  return article?.urlDate || article?.publishedDate;
}

function uniqueDates(dates: string[]) {
  return [...new Set(dates.map(normalizeArchiveDate).filter(isDefinedDate))]
    .sort((a, b) => b.localeCompare(a));
}

function uniqueArticles(articles: Article[]) {
  return [...new Map(articles.map((article) => [article.id, article])).values()];
}

function uniquePairs(snapshots: RefreshResult[]) {
  const candidates = snapshots.flatMap((snapshot) =>
    snapshot.pairs.map((pair) => ({ pair, generatedAt: snapshot.generatedAt }))
  ).sort((a, b) =>
    Number(isMatchedPair(b.pair)) - Number(isMatchedPair(a.pair)) ||
    b.generatedAt.localeCompare(a.generatedAt) || b.pair.matchScore - a.pair.matchScore
  );
  const selected: ArticlePair[] = [];
  const usedBase = new Set<string>();
  const usedTarget = new Set<string>();

  for (const { pair } of candidates) {
    const base = pair.base ?? pair.cn;
    const target = pair.target ?? pair.jp;
    if ((base && usedBase.has(base.id)) || (target && usedTarget.has(target.id))) continue;
    if (base) usedBase.add(base.id);
    if (target) usedTarget.add(target.id);
    selected.push(pair);
  }

  // A conflicting older match may still contain an article that is not used by
  // the preferred match. Preserve that article as one-sided coverage.
  for (const { pair } of candidates) {
    const base = pair.base ?? pair.cn;
    const target = pair.target ?? pair.jp;
    if (base && !usedBase.has(base.id)) {
      usedBase.add(base.id);
      selected.push(singleArticlePair(pair, base, "base"));
    }
    if (target && !usedTarget.has(target.id)) {
      usedTarget.add(target.id);
      selected.push(singleArticlePair(pair, target, "target"));
    }
  }
  return selected;
}

function isMatchedPair(pair: ArticlePair) {
  return Boolean((pair.base ?? pair.cn) && (pair.target ?? pair.jp));
}

function singleArticlePair(pair: ArticlePair, article: Article, side: "base" | "target"): ArticlePair {
  const base = side === "base" ? article : undefined;
  const target = side === "target" ? article : undefined;
  return {
    id: `aggregate:${side}-only:${article.id}`,
    status: base ? "CN ONLY" : article.source === "JP" ? "JP ONLY" : "TARGET ONLY",
    visibilityStatus: base ? "BASE_ONLY" : "TARGET_ONLY",
    base,
    target,
    cn: base,
    jp: target?.source === "JP" ? target : undefined,
    sourceLanguage: pair.sourceLanguage ?? "CN",
    targetLanguage: pair.targetLanguage ?? "JP",
    articlesBySource: { [article.source]: article },
    onlySource: article.source,
    matchScore: 0,
    highlights: []
  };
}

function uniqueAnchoredPairs(pairs: AnchoredArticlePair[]) {
  return [...new Map(pairs.map((pair) => [pair.id, pair])).values()];
}

function calculateAnchoredAggregateStats(pairs: AnchoredArticlePair[]) {
  const cnArticles = uniqueArticles(pairs.map((pair) => pair.cn).filter(isArticle));
  const jpArticles = uniqueArticles(pairs.map((pair) => pair.jp));
  const matched = pairs.filter((pair) => pair.status === "matched" && pair.cn).length;
  const allArticles = [...cnArticles, ...jpArticles];
  const bodyDifference = pairs.filter((pair) => {
    const analysis = pair.analysis;
    return Boolean(
      pair.cn &&
        analysis &&
        ((analysis.bodyDifferenceScore ?? 0) >= 35 ||
          analysis.missingPoints.length > 0 ||
          analysis.emphasizedPoints.length > 0)
    );
  }).length;
  const framingShift = pairs.filter((pair) =>
    Boolean(pair.cn && pair.analysis && (pair.analysis.framingShiftScore ?? 0) >= 55)
  ).length;

  return {
    cnCount: cnArticles.length,
    jpCount: jpArticles.length,
    baseCount: cnArticles.length,
    targetCount: jpArticles.length,
    countsBySource: {
      CN: cnArticles.length,
      JP: jpArticles.length
    },
    cnDateCounts: countArticlesByDate(cnArticles),
    jpDateCounts: countArticlesByDate(jpArticles),
    dateCountsBySource: {
      CN: countArticlesByDate(cnArticles),
      JP: countArticlesByDate(jpArticles)
    },
    dateMismatches: allArticles.filter((article) => article.dateMismatch).length,
    matched,
    cnOnly: 0,
    jpOnly: jpArticles.length - matched,
    baseOnly: 0,
    targetOnly: jpArticles.length - matched,
    framingShift,
    bodyDifference,
    coverageRatio: jpArticles.length ? Math.round((matched / jpArticles.length) * 100) : 0
  };
}

function countArticlesByDate(articles: Article[]) {
  return articles.reduce<Record<string, number>>((counts, article) => {
    const date = articleDate(article);
    if (date) counts[date] = (counts[date] ?? 0) + 1;
    return counts;
  }, {});
}

function isArticle(article: Article | undefined): article is Article {
  return Boolean(article);
}

function latestGeneratedAt(snapshots: RefreshResult[]) {
  return snapshots
    .map((snapshot) => snapshot.generatedAt)
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0] ?? new Date().toISOString();
}

function aggregateRunMetadata(snapshots: RefreshResult[]): RefreshRunMetadata | undefined {
  const runs = [...new Map(snapshots.map((snapshot) => snapshot.run)
    .filter((run): run is RefreshRunMetadata => Boolean(run)).map((run) => [run.runId, run])).values()];
  if (!runs.length) return undefined;

  const modelUsage = new Map<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }>();

  runs.forEach((run) => {
    run.openaiModelUsage?.forEach((usage) => {
      const existing = modelUsage.get(usage.model) ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0
      };
      modelUsage.set(usage.model, {
        calls: existing.calls + usage.calls,
        inputTokens: existing.inputTokens + usage.inputTokens,
        outputTokens: existing.outputTokens + usage.outputTokens,
        estimatedCostUsd: Number((existing.estimatedCostUsd + usage.estimatedCostUsd).toFixed(6))
      });
    });
  });

  return {
    runId: `aggregate:${runs[0].runId}`,
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    warningCount: runs.reduce((sum, run) => sum + run.warningCount, 0),
    openaiCalls: runs.reduce((sum, run) => sum + run.openaiCalls, 0),
    ...aggregateAiDiagnostics(runs),
    openaiInputTokens: runs.reduce((sum, run) => sum + run.openaiInputTokens, 0),
    openaiOutputTokens: runs.reduce((sum, run) => sum + run.openaiOutputTokens, 0),
    openaiModelUsage: [...modelUsage.entries()].map(([model, usage]) => ({
      model,
      calls: usage.calls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: usage.estimatedCostUsd
    })),
    estimatedOpenAiCostUsd: Number(
      runs.reduce((sum, run) => sum + run.estimatedOpenAiCostUsd, 0).toFixed(6)
    ),
    storageBackend: runs[0].storageBackend
  };
}

function aggregateAiDiagnostics(runs: RefreshRunMetadata[]): Partial<RefreshRunMetadata> {
  const diagnosed = runs.filter((run) => run.openaiStatus);
  if (!diagnosed.length) return {};
  const failures = runs.reduce((n, run) => n + (run.openaiFailures ?? 0), 0);
  const successes = runs.reduce((n, run) => n + run.openaiCalls + (run.openaiCacheHits ?? 0), 0);
  const errors = new Map<string, NonNullable<RefreshRunMetadata["openaiErrors"]>[number]>();
  for (const run of runs) for (const error of run.openaiErrors ?? []) {
    const key = `${error.category}:${error.status ?? ""}`;
    errors.set(key, { ...error, count: (errors.get(key)?.count ?? 0) + error.count });
  }
  return {
    openaiAttempts: runs.reduce((n, run) => n + (run.openaiAttempts ?? 0), 0),
    openaiFailures: failures,
    openaiCacheHits: runs.reduce((n, run) => n + (run.openaiCacheHits ?? 0), 0),
    openaiSkipped: runs.reduce((n, run) => n + (run.openaiSkipped ?? 0), 0),
    openaiErrors: [...errors.values()],
    // Mixed old/new archives must not erase a known failure or suggest that all
    // historical runs were diagnosed by the new telemetry.
    openaiStatus: failures ? successes ? "degraded" : "unavailable"
      : diagnosed.length !== runs.length ? "degraded"
      : diagnosed.every((r) => r.openaiStatus === "disabled") ? "disabled"
      : successes ? "ok" : "unused"
  };
}

function aggregateCollection(snapshots: RefreshResult[]): RefreshResult["collection"] {
  const result: Partial<Record<Source, ScrapeCoverage>> = {};
  const seen = new Set<string>();
  for (const snapshot of snapshots) for (const [source, coverage] of Object.entries(snapshot.collection ?? {})) {
    const key = `${source}:${snapshot.run?.runId ?? snapshot.generatedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = result[source as Source];
    if (!previous) {
      result[source as Source] = { ...coverage };
      continue;
    }
    for (const metric of ["attemptedPages", "successfulPages", "failedPages", "listingParseFailureCount", "candidateCount", "selectedCount", "articleCount", "bodyFailureCount"] as const) {
      previous[metric] += coverage[metric];
    }
    previous.articleLimitReached ||= coverage.articleLimitReached;
    previous.pageLimitReached ||= coverage.pageLimitReached;
    for (const field of ["requestedDates", "datesWithArticles", "emptyDates"] as const) {
      previous[field] = uniqueDates([...previous[field], ...coverage[field]]);
    }
    previous.earliestDiscoveredDate = [previous.earliestDiscoveredDate, coverage.earliestDiscoveredDate].filter(isDefinedDate).sort()[0];
    previous.latestDiscoveredDate = [previous.latestDiscoveredDate, coverage.latestDiscoveredDate].filter(isDefinedDate).sort().at(-1);
  }
  return Object.keys(result).length ? result : undefined;
}

function isDefinedDate(date: string | undefined): date is string {
  return Boolean(date);
}

async function listArchiveDates(key = DEFAULT_COMPARISON_KEY) {
  const store = createSnapshotStore();
  const index = await store.readJson<SnapshotIndex>(indexFileName(key)).catch(() => undefined);
  const indexDates = normalizeIndexDates(index, key);
  if (indexDates.length) return indexDates;

  const names = await store.listNames().catch(() => []);
  return [...new Set(names.map((file) => archiveDateFromFile(file, key)).filter(isDate))]
    .sort((a, b) => b.localeCompare(a));
}

async function writeIndex(
  store: ReturnType<typeof createSnapshotStore>,
  key = DEFAULT_COMPARISON_KEY,
  newDates: string[] = []
) {
  const dates = [...new Set([...newDates, ...(await listArchiveDates(key))].filter(isDate))]
    .sort((a, b) => b.localeCompare(a));
  await store.writeJson(indexFileName(key), {
    updatedAt: new Date().toISOString(),
    comparisonKey: key,
    dates
  });
}

function normalizeIndexDates(index: SnapshotIndex | undefined, key: string) {
  if (!index || index.comparisonKey !== key || !Array.isArray(index.dates)) return [];
  return [...new Set(index.dates.filter(isDate))].sort((a, b) => b.localeCompare(a));
}

function stripArchiveMetadata(snapshot: RefreshResult): RefreshResult {
  const { activeDate: _activeDate, archiveDates: _archiveDates, ...rest } = snapshot;
  return rest;
}

function rememberSnapshot(snapshot: RefreshResult, key: string) {
  globalThis.__PEOPLEDIFF_CACHE_BY_KEY__ = {
    ...(globalThis.__PEOPLEDIFF_CACHE_BY_KEY__ ?? {}),
    [key]: snapshot
  };

  if (key === DEFAULT_COMPARISON_KEY) {
    globalThis.__PEOPLEDIFF_CACHE__ = snapshot;
  }
}

function comparisonKeyFromSnapshot(snapshot: RefreshResult) {
  return comparisonKey(
    snapshot.baseLanguage ?? "CN",
    snapshot.targetLanguage ?? "JP",
    snapshot.collectionMode ?? "broad"
  );
}

function comparisonKey(
  sourceLanguage: Source,
  targetLanguage: Source,
  collectionMode: "broad" | "jp-major" = "broad"
) {
  const pairKey = `${sourceLanguage}-${targetLanguage}`;
  return collectionMode === "jp-major" ? `jp-major.${pairKey}` : pairKey;
}

function languagesFromKey(key: string): [Source, Source] {
  const pairKey = key.replace(/^jp-major\./, "");
  const [source = "CN", target = "JP"] = pairKey.split("-");
  return [source as Source, target as Source];
}

function collectionModeFromKey(key: string): "broad" | "jp-major" {
  return key.startsWith("jp-major.") ? "jp-major" : "broad";
}

function snapshotCollectionMode(options: SnapshotReadOptions): "broad" | "jp-major" {
  const value = options.collectionMode ?? options.mode;
  return typeof value === "string" && /^(jp-major|jp_major|anchored|jp-anchored)$/i.test(value)
    ? "jp-major"
    : "broad";
}

function latestFileName(key: string) {
  return key === DEFAULT_COMPARISON_KEY ? LATEST_FILE : `latest.${key}.json`;
}

function datedFileName(date: string, key: string) {
  return key === DEFAULT_COMPARISON_KEY ? `${date}.json` : `${date}.${key}.json`;
}

function indexFileName(key: string) {
  return key === DEFAULT_COMPARISON_KEY ? INDEX_FILE : `index.${key}.json`;
}

function datedCacheKey(date: string, key: string) {
  return `${key}:${date}`;
}

function archiveDateFromFile(file: string, key: string) {
  if (key === DEFAULT_COMPARISON_KEY) {
    const value = file.replace(/\.json$/, "");
    return isDate(value) ? value : "";
  }

  const suffix = `.${key}.json`;
  if (!file.endsWith(suffix)) return "";
  return file.slice(0, -suffix.length);
}

function normalizeArchiveDate(input?: string) {
  const match = input?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return isRealDate(normalized) ? normalized : undefined;
}

function isDate(input: string) {
  return DATE_PATTERN.test(input) && isRealDate(input);
}

function isRealDate(input: string) {
  const [year, month, day] = input.split("-").map(Number);
  if (!year || !month || !day) return false;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10) === input;
}
