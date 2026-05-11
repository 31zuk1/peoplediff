import type {
  AnchoredMatchCandidate,
  AnchoredArticlePair,
  Article,
  ArticlePair,
  RefreshResult,
  RefreshStats
} from "./types";
import {
  analyzeDifference,
  activeModelLabel,
  enrichArticle,
  enrichJapaneseArticle
} from "./openai";
import { getAvailableLanguageSummaries } from "./languages";
import { findChineseMatchForJapaneseArticle } from "./jp-major-matcher";
import { JP_MAJOR_NEWS_URL, scrapeJapaneseMajorNews } from "./jp-major-scraper";
import {
  buildRefreshRunMetadata,
  createRefreshTelemetryState,
  logRefreshRun,
  withRefreshTelemetry
} from "./telemetry";
import { extractKeywords, stableId } from "./text";

type JpMajorRefreshOptions = {
  dates?: string[];
  dateFrom?: string;
  dateTo?: string;
  maxPages?: number;
  maxArticles?: number;
  aiArticleLimit?: number;
  maxQueries?: number;
  candidatesPerQuery?: number;
  useAi?: boolean;
};

export async function refreshJapaneseMajorSnapshot(options: JpMajorRefreshOptions = {}) {
  const telemetry = createRefreshTelemetryState();
  return withRefreshTelemetry(telemetry, () =>
    refreshJapaneseMajorSnapshotWithTelemetry(options, telemetry)
  );
}

export function jpMajorRefreshSignature(options: JpMajorRefreshOptions = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    collectionMode: "jp-major",
    sourceLanguage: "CN",
    targetLanguage: "JP",
    dateScope: resolveDateScope(options),
    maxPages: normalizedNumber(options.maxPages),
    maxArticles: normalizedNumber(options.maxArticles),
    aiArticleLimit: normalizedNumber(options.aiArticleLimit),
    maxQueries: normalizedNumber(options.maxQueries),
    candidatesPerQuery: normalizedNumber(options.candidatesPerQuery),
    useAi: options.useAi !== false,
    anchorSourceUrl: JP_MAJOR_NEWS_URL
  });
}

async function refreshJapaneseMajorSnapshotWithTelemetry(
  options: JpMajorRefreshOptions,
  telemetry: ReturnType<typeof createRefreshTelemetryState>
): Promise<RefreshResult> {
  const dateScope = resolveDateScope(options);
  const maxPages = options.maxPages ?? numberFromEnv("PEOPLEDIFF_JP_MAJOR_MAX_PAGES") ?? 3;
  const maxArticles = options.maxArticles ?? numberFromEnv("PEOPLEDIFF_JP_MAJOR_MAX_ARTICLES") ?? 80;
  const aiArticleLimit =
    options.aiArticleLimit ??
    numberFromEnv("PEOPLEDIFF_AI_ARTICLE_LIMIT", { allowZero: true }) ??
    80;
  const maxQueries = options.maxQueries ?? numberFromEnv("PEOPLEDIFF_JP_MAJOR_SEARCH_QUERIES") ?? 5;
  const candidatesPerQuery =
    options.candidatesPerQuery ??
    numberFromEnv("PEOPLEDIFF_JP_MAJOR_CANDIDATES_PER_QUERY") ??
    8;
  const scraped = await scrapeJapaneseMajorNews({
    dates: dateScope,
    maxPages,
    maxArticles
  });
  const warnings = [...scraped.warnings];
  const enrichedJp = await mapWithConcurrency(scraped.articles, 6, (article, index) =>
    enrichJapaneseArticle(article, { useAi: index < aiArticleLimit })
  );

  const anchoredPairs = await mapWithConcurrency(enrichedJp, 3, async (jpArticle, index) => {
    const useAiForArticle = options.useAi !== false && index < aiArticleLimit;
    const match = await findChineseMatchForJapaneseArticle(jpArticle, {
      dates: dateScope,
      maxQueries,
      maxResultsPerQuery: candidatesPerQuery,
      candidateLimit: 24,
      useAi: useAiForArticle
    });
    const cnArticle = match.cn ? await enrichArticle(match.cn, { useAi: false }) : undefined;
    const analysis = cnArticle && useAiForArticle ? await analyzeDifference(cnArticle, jpArticle) : undefined;
    warnings.push(...match.warnings);
    return anchoredPairFromMatch(jpArticle, cnArticle, match, analysis);
  });
  const pairs = anchoredPairs.map(articlePairFromAnchoredPair);
  const cnArticles = uniqueArticles(anchoredPairs.map((pair) => pair.cn).filter(isArticle));
  const jpArticles = uniqueArticles(anchoredPairs.map((pair) => pair.jp));
  const result: RefreshResult = {
    generatedAt: new Date().toISOString(),
    mode: "live",
    collectionMode: "jp-major",
    model: activeModelLabel(),
    run: buildRefreshRunMetadata(telemetry, warnings.length),
    schemaVersion: 2,
    refreshSignature: jpMajorRefreshSignature(options),
    baseLanguage: "CN",
    targetLanguage: "JP",
    availableLanguages: getAvailableLanguageSummaries(),
    anchorSourceUrl: JP_MAJOR_NEWS_URL,
    dateScope: collectDateScope(jpArticles),
    sourceDateScope: collectDateScope(cnArticles),
    targetDateScope: collectDateScope(jpArticles),
    sourceLookbackDays: 0,
    baseArticles: cnArticles,
    targetArticles: jpArticles,
    cnArticles,
    jpArticles,
    pairs,
    anchoredPairs,
    stats: calculateAnchoredStats(anchoredPairs),
    warnings
  };
  logRefreshRun(result);
  return result;
}

function anchoredPairFromMatch(
  jpArticle: Article,
  cnArticle: Article | undefined,
  match: Awaited<ReturnType<typeof findChineseMatchForJapaneseArticle>>,
  analysis: AnchoredArticlePair["analysis"]
): AnchoredArticlePair {
  const status = cnArticle ? "matched" : "unmatched";
  return {
    id: stableId(`${jpArticle.url}:${cnArticle?.url ?? "unmatched"}`),
    status,
    jp: jpArticle,
    cn: cnArticle,
    match_score: cnArticle ? match.match_score : 0,
    match_reason: match.match_reason,
    candidate_count: match.candidate_count,
    search_queries: match.search_queries,
    candidates: mapAnchoredCandidates(match.candidates),
    analysis,
    highlights: extractKeywords(
      [jpArticle.title, jpArticle.summary, cnArticle?.title, cnArticle?.summary]
        .filter(Boolean)
        .join(" "),
      5
    )
  };
}

function mapAnchoredCandidates(
  candidates: Awaited<ReturnType<typeof findChineseMatchForJapaneseArticle>>["candidates"]
): AnchoredMatchCandidate[] {
  return candidates.map((candidate) => ({
    article: candidate.article,
    score: candidate.match_score,
    reason: candidate.match_reason,
    searchQuery: candidate.searchQuery ?? candidate.search.queries[0],
    searchRank: candidate.searchRank ?? candidate.search.bestRank
  }));
}

function articlePairFromAnchoredPair(pair: AnchoredArticlePair): ArticlePair {
  const isMatched = pair.status === "matched" && pair.cn;
  return {
    id: pair.id,
    status: isMatched ? "MATCHED" : "JP ONLY",
    visibilityStatus: isMatched ? "MATCHED" : "TARGET_ONLY",
    base: pair.cn,
    target: pair.jp,
    cn: pair.cn,
    jp: pair.jp,
    sourceLanguage: "CN",
    targetLanguage: "JP",
    articlesBySource: isMatched ? { CN: pair.cn, JP: pair.jp } : { JP: pair.jp },
    onlySource: isMatched ? undefined : "JP",
    matchScore: pair.match_score / 100,
    analysis: pair.analysis,
    highlights: pair.highlights
  };
}

function calculateAnchoredStats(pairs: AnchoredArticlePair[]): RefreshStats {
  const matched = pairs.filter((pair) => pair.status === "matched" && pair.cn).length;
  const cnArticles = uniqueArticles(pairs.map((pair) => pair.cn).filter(isArticle));
  const jpArticles = uniqueArticles(pairs.map((pair) => pair.jp));
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
    cnDateCounts: countByDate(cnArticles),
    jpDateCounts: countByDate(jpArticles),
    dateCountsBySource: {
      CN: countByDate(cnArticles),
      JP: countByDate(jpArticles)
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

function resolveDateScope(options: JpMajorRefreshOptions) {
  const explicit = normalizeDateScope(options.dates);
  if (explicit.length) return explicit;
  return dateRangeScope(options.dateFrom, options.dateTo);
}

function dateRangeScope(fromInput: string | undefined, toInput: string | undefined) {
  const from = normalizeDate(fromInput);
  const to = normalizeDate(toInput);
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

function normalizeDateScope(input: string[] | undefined) {
  return [...new Set((input ?? []).map(normalizeDate).filter(isDate))]
    .sort((a, b) => b.localeCompare(a));
}

function normalizeDate(input: string | undefined) {
  if (!input) return undefined;
  return input.match(/\d{4}-\d{2}-\d{2}/)?.[0];
}

function collectDateScope(articles: Article[]) {
  return [
    ...new Set(
      articles
        .map((article) => article.publishedDate ?? article.urlDate)
        .filter(isDate)
    )
  ].sort((a, b) => b.localeCompare(a));
}

function countByDate(articles: Article[]) {
  return articles.reduce<Record<string, number>>((counts, article) => {
    const date = article.publishedDate ?? article.urlDate;
    if (date) counts[date] = (counts[date] ?? 0) + 1;
    return counts;
  }, {});
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  iteratee: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await iteratee(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function uniqueArticles(articles: Article[]) {
  return [...new Map(articles.map((article) => [article.id, article])).values()];
}

function isArticle(article: Article | undefined): article is Article {
  return Boolean(article);
}

function isDate(input: string | undefined): input is string {
  return Boolean(input && /^\d{4}-\d{2}-\d{2}$/.test(input));
}

function addDays(date: string, offset: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function normalizedNumber(input: number | undefined) {
  return typeof input === "number" && Number.isFinite(input) ? Math.round(input) : undefined;
}

function numberFromEnv(name: string, options: { allowZero?: boolean } = {}) {
  const value = Number(process.env[name]);
  const minimum = options.allowZero ? 0 : 1;
  return Number.isFinite(value) && value >= minimum ? Math.round(value) : undefined;
}
