import type { Source } from "./types";
import type { Article, ArticlePair, RefreshResult } from "./types";
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
};

type SnapshotIndex = {
  updatedAt?: string;
  comparisonKey?: string;
  dates?: string[];
};

export async function readSnapshot(date?: string, options: SnapshotReadOptions = {}) {
  const languageSelection = resolveCompareLanguages(options);
  const key = comparisonKey(languageSelection.sourceLanguage, languageSelection.targetLanguage);
  const normalizedDate = normalizeArchiveDate(date);
  if (normalizedDate) return readDatedSnapshot(normalizedDate, key);

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

  const latestDate = (await listArchiveDates(key))[0];
  if (latestDate) return readDatedSnapshot(latestDate, key);

  const legacy = key === DEFAULT_COMPARISON_KEY ? await store.readLegacyJson?.<RefreshResult>() : undefined;
  if (legacy) {
    globalThis.__PEOPLEDIFF_CACHE__ = stripArchiveMetadata(legacy);
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__);
  }

  return withArchiveDates(
    {
      ...emptySnapshot(),
      baseLanguage: languageSelection.sourceLanguage,
      targetLanguage: languageSelection.targetLanguage
    },
    undefined,
    key
  );
}

export async function writeSnapshot(snapshot: RefreshResult) {
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
  await store.writeJson(latestFileName(key), storedSnapshot);
  await writeIndex(store, key, [...dailySnapshots.keys()]);

  rememberSnapshot(storedSnapshot, key);
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
    baseLanguage,
    targetLanguage,
    dateScope: [date]
  };
  return withArchiveDates(empty, date, key);
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
      stats: calculateStats(
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

function articleDate(article?: Article) {
  return article?.urlDate || article?.publishedDate;
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
  return comparisonKey(snapshot.baseLanguage ?? "CN", snapshot.targetLanguage ?? "JP");
}

function comparisonKey(sourceLanguage: Source, targetLanguage: Source) {
  return `${sourceLanguage}-${targetLanguage}`;
}

function languagesFromKey(key: string): [Source, Source] {
  const [source = "CN", target = "JP"] = key.split("-");
  return [source as Source, target as Source];
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
