import type { Source } from "./types";
import type {
  AnchoredArticlePair,
  Article,
  ArticlePair,
  RefreshResult,
  RefreshRunMetadata
} from "./types";
import { calculateStats, emptySnapshot } from "./compare";
import { getAvailableLanguageSummaries, resolveCompareLanguages } from "./languages";
import { createSnapshotStore, snapshotStorageBackend, usesDurableSnapshotStore } from "./snapshot-store";

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
    const aggregate = await readAggregatedSnapshot(windowDates, key);
    if (aggregate) return aggregate;
  }

  const useMemoryCache = !usesDurableSnapshotStore();
  const cachedByKey = useMemoryCache ? globalThis.__PEOPLEDIFF_CACHE_BY_KEY__?.[key] : undefined;
  if (cachedByKey) return withArchiveDates(cachedByKey, undefined, key);

  if (useMemoryCache && key === DEFAULT_COMPARISON_KEY && globalThis.__PEOPLEDIFF_CACHE__) {
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__);
  }

  const store = createSnapshotStore();
  const latest = await store.readJson<RefreshResult>(latestFileName(key));
  if (latest) {
    const cleanSnapshot = stripArchiveMetadata(latest);
    rememberSnapshot(cleanSnapshot, key);
    return withArchiveDates(cleanSnapshot, undefined, key);
  }

  const latestDate = archiveDates[0];
  if (latestDate) return readDatedSnapshot(latestDate, key);

  const legacy = key === DEFAULT_COMPARISON_KEY ? await store.readLegacyJson?.<RefreshResult>() : undefined;
  if (legacy) {
    globalThis.__PEOPLEDIFF_CACHE__ = stripArchiveMetadata(legacy);
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__);
  }

  return withArchiveDates(
    {
      ...emptySnapshot(),
      collectionMode: collectionModeFromKey(key),
      baseLanguage: languageSelection.sourceLanguage,
      targetLanguage: languageSelection.targetLanguage
    },
    undefined,
    key
  );
}

export async function writeSnapshot(snapshot: RefreshResult, options: SnapshotWriteOptions = {}) {
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
    dateScope: [date]
  };
  return withArchiveDates(empty, date, key);
}

async function readAggregatedSnapshot(dates: string[], key = DEFAULT_COMPARISON_KEY) {
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

  return withArchiveDates(aggregateSnapshots(snapshots, key), undefined, key);
}

async function withArchiveDates(
  snapshot: RefreshResult,
  activeDate?: string,
  key = comparisonKeyFromSnapshot(snapshot)
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

function aggregateSnapshots(snapshots: RefreshResult[], key: string): RefreshResult {
  const [fallbackBaseLanguage, fallbackTargetLanguage] = languagesFromKey(key);
  const baseLanguage = snapshots[0].baseLanguage ?? fallbackBaseLanguage;
  const targetLanguage = snapshots[0].targetLanguage ?? fallbackTargetLanguage;
  const collectionMode = snapshots[0].collectionMode ?? collectionModeFromKey(key);
  const baseArticles = uniqueArticles(
    snapshots.flatMap((snapshot) => snapshot.baseArticles ?? snapshot.cnArticles ?? [])
  );
  const targetArticles = uniqueArticles(
    snapshots.flatMap((snapshot) => snapshot.targetArticles ?? snapshot.jpArticles ?? [])
  );
  const pairs = uniquePairs(snapshots.flatMap((snapshot) => snapshot.pairs));
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
    refreshSignature: undefined
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

function readWindowDates(archiveDates: string[], options: SnapshotReadOptions) {
  const explicitRange = dateRange(
    typeof options.dateFrom === "string" ? options.dateFrom : undefined,
    typeof options.dateTo === "string" ? options.dateTo : undefined
  );
  if (explicitRange.length) {
    const available = new Set(archiveDates);
    return explicitRange.filter((date) => available.has(date));
  }

  return archiveDates.slice(0, readWindowDays(options.windowDays));
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

function uniquePairs(pairs: ArticlePair[]) {
  return [...new Map(pairs.map((pair) => [pair.id, pair])).values()];
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
  const runs = snapshots.map((snapshot) => snapshot.run).filter((run): run is RefreshRunMetadata => Boolean(run));
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
