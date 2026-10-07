import type { Article, ArticlePair, RefreshResult, RefreshStats } from "./types";
import type { PeopleLanguage } from "./languages";
import {
  getAvailableLanguageSummaries,
  getPeopleLanguageConfig,
  resolveCompareLanguages
} from "./languages";
import {
  adjudicateSameTopicMatch,
  analyzeDifference,
  activeModelLabel,
  canUseOpenAI,
  enrichArticle
} from "./openai";
import {
  applyAnalysisStatus,
  hasHardTopicMismatch,
  matchArticles,
  pairArticlesFromMatches,
  rankMatchCandidates,
  targetOnlyStatus,
  titleLineageScore,
  type ArticleMatch
} from "./matcher";
import { scrapePeopleDetailed, searchPeopleChineseArticlesForTargets } from "./scraper";
import {
  buildRefreshRunMetadata,
  createRefreshTelemetryState,
  getOpenAiWarnings,
  logRefreshRun,
  withRefreshTelemetry
} from "./telemetry";
import { stableId } from "./text";

type RefreshOptions = {
  limit?: number;
  dates?: string[];
  sourceDates?: string[];
  targetDates?: string[];
  dateFrom?: string;
  dateTo?: string;
  sourceDateFrom?: string;
  sourceDateTo?: string;
  targetDateFrom?: string;
  targetDateTo?: string;
  sourceLookbackDays?: number;
  maxPages?: number;
  maxArticles?: number;
  aiArticleLimit?: number;
  useAi?: boolean;
  sourceLanguage?: unknown;
  targetLanguage?: unknown;
  source?: unknown;
  target?: unknown;
};

export async function refreshSnapshot(options: RefreshOptions = {}): Promise<RefreshResult> {
  const telemetry = createRefreshTelemetryState();
  return withRefreshTelemetry(telemetry, () => refreshSnapshotWithTelemetry(options, telemetry));
}

async function refreshSnapshotWithTelemetry(
  options: RefreshOptions,
  telemetry: ReturnType<typeof createRefreshTelemetryState>
): Promise<RefreshResult> {
  const limit = clampLimit(options.limit ?? 8);
  const targetDateScope = resolveTargetDateScope(options);
  const dateScope = targetDateScope;
  const explicitSourceDateScope = resolveSourceDateScope(options);
  const sourceLookbackDays = resolveSourceLookbackDays(options.sourceLookbackDays);
  const sourceDateScope =
    explicitSourceDateScope ??
    sourceLookbackDateScope(targetDateScope, sourceLookbackDays);
  const languageSelection = resolveCompareLanguages(options);
  const sourceConfig = getPeopleLanguageConfig(languageSelection.sourceLanguage);
  const targetConfig = getPeopleLanguageConfig(languageSelection.targetLanguage);
  const warnings: string[] = [...languageSelection.warnings];
  if (!process.env.OPENAI_API_KEY && languageSelection.targetLanguage !== "JP") {
    warnings.push(
      `${targetConfig.warningLabel}はOpenAI翻訳なしでは照合精度が落ちます。OPENAI_API_KEY設定時は対象言語タイトルも日本語化して照合します。`
    );
  }
  const [sourceSettled, targetSettled] = await Promise.allSettled([
    scrapePeopleDetailed(languageSelection.sourceLanguage, {
      limit,
      dates: sourceDateScope,
      maxPages: options.maxPages,
      maxArticles: sourceMaxArticles(options.maxArticles, dateScope, sourceDateScope)
    }),
    scrapePeopleDetailed(languageSelection.targetLanguage, {
      limit,
      dates: dateScope,
      maxPages: options.maxPages,
      maxArticles: options.maxArticles
    })
  ]);

  let sourceArticles: Article[] = [];
  let targetArticles: Article[] = [];

  if (sourceSettled.status === "fulfilled") {
    sourceArticles = sourceSettled.value.articles;
    warnings.push(...sourceSettled.value.warnings);
  } else {
    throw new Error(`${sourceConfig.warningLabel}の取得に失敗したため更新を中止しました。保存済みデータを維持します。`, { cause: sourceSettled.reason });
  }

  if (targetSettled.status === "fulfilled") {
    targetArticles = targetSettled.value.articles;
    warnings.push(...targetSettled.value.warnings);
  } else {
    throw new Error(`${targetConfig.warningLabel}の取得に失敗したため更新を中止しました。保存済みデータを維持します。`, { cause: targetSettled.reason });
  }

  const aiArticleLimit = resolveAiArticleLimit(options.aiArticleLimit, limit, dateScope.length > 0);
  const useAi = options.useAi !== false && aiArticleLimit > 0;
  if (!useAi) telemetry.openaiConfigured = false;
  const enrichedTarget = await mapWithConcurrency(targetArticles, aiConcurrency(), (article, index) =>
    enrichArticleForLanguage(article, languageSelection.targetLanguage, useAi && index < aiArticleLimit)
  );
  if (languageSelection.sourceLanguage === "CN" && dateScope.length > 0) {
    const searched = await searchPeopleChineseArticlesForTargets(
      enrichedTarget.slice(0, aiArticleLimit || 32),
      {
        dates: sourceDateScope,
        maxQueries: 32,
        maxResultsPerQuery: 5,
        maxArticles: 80
      }
    );
    sourceArticles = mergeArticles(sourceArticles, searched.articles);
    warnings.push(...searched.warnings);
  }
  const enrichedSource = await mapWithConcurrency(sourceArticles, aiConcurrency(), (article) =>
    enrichArticleForLanguage(article, languageSelection.sourceLanguage, false)
  );

  const basePairs = await matchArticlePairs(enrichedSource, enrichedTarget, aiArticleLimit, useAi && canUseOpenAI() ? adjudicateSameTopicMatch : null);
  const analyzedPairs = filterPairsByDateScope(
    await enrichPairs(basePairs, useAi ? aiArticleLimit : 0),
    targetDateScope,
    explicitSourceDateScope
  );
  const visibleSourceArticles = collectSourceArticles(
    analyzedPairs,
    languageSelection.sourceLanguage
  );
  const visibleTargetArticles = collectSourceArticles(
    analyzedPairs,
    languageSelection.targetLanguage
  );
  warnings.push(...getOpenAiWarnings(telemetry));

  const result: RefreshResult = {
    generatedAt: new Date().toISOString(),
    mode: "live",
    model: useAi ? activeModelLabel() : "local-heuristic",
    run: buildRefreshRunMetadata(telemetry, warnings.length),
    schemaVersion: 2,
    refreshSignature: refreshOptionsSignature(options),
    baseLanguage: languageSelection.sourceLanguage,
    targetLanguage: languageSelection.targetLanguage,
    availableLanguages: getAvailableLanguageSummaries(),
    dateScope,
    sourceDateScope,
    targetDateScope,
    sourceLookbackDays,
    collection: {
      ...(sourceSettled.status === "fulfilled" && {
        [languageSelection.sourceLanguage]: sourceSettled.value.collection
      }),
      ...(targetSettled.status === "fulfilled" && {
        [languageSelection.targetLanguage]: targetSettled.value.collection
      })
    },
    baseArticles: visibleSourceArticles,
    targetArticles: visibleTargetArticles,
    cnArticles: visibleSourceArticles,
    jpArticles: languageSelection.targetLanguage === "JP" ? visibleTargetArticles : [],
    pairs: analyzedPairs,
    stats: calculateStats(
      analyzedPairs,
      visibleSourceArticles.length,
      visibleTargetArticles.length,
      languageSelection.sourceLanguage,
      languageSelection.targetLanguage
    ),
    warnings
  };
  logRefreshRun(result);
  return result;
}

export function refreshOptionsSignature(options: RefreshOptions = {}) {
  const targetDateScope = resolveTargetDateScope(options);
  const explicitSourceDateScope = resolveSourceDateScope(options);
  const sourceLookbackDays = resolveSourceLookbackDays(options.sourceLookbackDays);
  const sourceDateScope =
    explicitSourceDateScope ??
    sourceLookbackDateScope(targetDateScope, sourceLookbackDays);
  const languageSelection = resolveCompareLanguages(options);

  return JSON.stringify({
    schemaVersion: 2,
    sourceLanguage: languageSelection.sourceLanguage,
    targetLanguage: languageSelection.targetLanguage,
    dateScope: targetDateScope,
    sourceDateScope,
    targetDateScope,
    sourceLookbackDays,
    limit: normalizedNumber(options.limit),
    maxPages: normalizedNumber(options.maxPages),
    maxArticles: normalizedNumber(options.maxArticles),
    aiArticleLimit: normalizedNumber(options.aiArticleLimit),
    useAi: options.useAi !== false,
    analysisDisplayLanguage: "ja-evidence-v2",
    cnSourceSet: "core-2026-10-07-event-evidence-and-jp-coverage-v3"
  });
}

export function emptySnapshot(): RefreshResult {
  return {
    generatedAt: new Date().toISOString(),
    mode: "empty",
    model: activeModelLabel(),
    run: buildRefreshRunMetadata(createRefreshTelemetryState(), 0),
    schemaVersion: 2,
    baseLanguage: "CN",
    targetLanguage: "JP",
    availableLanguages: getAvailableLanguageSummaries(),
    dateScope: [],
    sourceDateScope: [],
    targetDateScope: [],
    sourceLookbackDays: 3,
    baseArticles: [],
    targetArticles: [],
    cnArticles: [],
    jpArticles: [],
    pairs: [],
    stats: calculateStats([], 0, 0),
    warnings: []
  };
}

export async function enrichPairs(pairs: ArticlePair[], aiArticleLimit: number, analyze = analyzeDifference) {
  const matched = pairs
    .filter((pair) => pairBase(pair) && pairTarget(pair))
    .sort((a, b) => b.matchScore - a.matchScore);
  const replacementsById = new Map<string, ArticlePair[]>();

  const analyzed = await mapWithConcurrency(matched, aiConcurrency(), async (pair, index) => {
    const base = pairBase(pair)!;
    const target = pairTarget(pair)!;
    const analysis = await analyze(base, target, { useAi: index < aiArticleLimit });
    const analyzedPair = { ...pair, analysis };
    const replacement = isRejectedMatch(analyzedPair)
      ? splitRejectedPair(analyzedPair)
      : [applyAnalysisStatus(analyzedPair)];
    return { originalId: pair.id, replacement };
  });

  analyzed.forEach(({ originalId, replacement }) => replacementsById.set(originalId, replacement));
  return pairs.flatMap((pair) => replacementsById.get(pair.id) ?? [pair]);
}

async function enrichArticleForLanguage(
  article: Article,
  language: PeopleLanguage,
  useAi: boolean
) {
  return enrichArticle({ ...article, source: language }, { useAi: useAi && language !== "JP" });
}

export async function matchArticlePairs(
  sourceArticles: Article[],
  targetArticles: Article[],
  aiArticleLimit: number,
  adjudicate: typeof adjudicateSameTopicMatch | null | undefined = canUseOpenAI() ? adjudicateSameTopicMatch : undefined
) {
  if (!adjudicate) return matchArticles(sourceArticles, targetArticles);

  const adjudicationLimit = Math.min(targetArticles.length, Math.max(0, aiArticleLimit));
  const targetsForAdjudication = targetArticles.slice(0, adjudicationLimit);
  const adjudicated = await mapWithConcurrency(targetsForAdjudication, aiConcurrency(), async (target) => {
    const candidates = rankMatchCandidates(sourceArticles, target, {
      limit: 7,
      minScore: 0.08
    });
    if (!candidates.length) return { fallbackTarget: target };

    const decision = await adjudicate(
      target,
      candidates.map((candidate) => ({
        baseId: candidate.base.id,
        score: candidate.score,
        article: candidate.base
      }))
    );
    if (!decision) return { fallbackTarget: target };
    if (!decision?.sameTopic || !decision.baseId || decision.matchConfidence < 55) {
      return undefined;
    }

    let selected = candidates.find((candidate) => candidate.base.id === decision.baseId);
    if (!selected) return { fallbackTarget: target };
    const directTitleCandidate = bestDirectTitleCandidate(candidates, target);
    if (
      directTitleCandidate &&
      titleLineageScore(directTitleCandidate.base, target) >=
        titleLineageScore(selected.base, target) + 0.25
    ) {
      selected = directTitleCandidate;
    }
    if (hasHardTopicMismatch(selected.base, target)) return { fallbackTarget: target };

    return {
      base: selected.base,
      target,
      score: Number(Math.max(selected.score, decision.matchConfidence / 100).toFixed(3)),
      confidence: decision.matchConfidence
    };
  });

  const aiMatches = resolveAdjudicatedMatches(
    adjudicated.filter(isAdjudicatedMatch),
    targetArticles
  );
  const usedBase = new Set(aiMatches.map((match) => match.base.id));
  const usedTarget = new Set(aiMatches.map((match) => match.target.id));
  const fallbackTargets = [
    ...adjudicated
      .map((outcome) => outcome && "fallbackTarget" in outcome ? outcome.fallbackTarget : undefined)
      .filter((target): target is Article => Boolean(target)),
    // A duplicate source chosen by AI can lose conflict resolution. Try its
    // remaining conservative candidates rather than silently dropping it.
    ...adjudicated.filter(isAdjudicatedMatch).map((match) => match.target),
    ...targetArticles.slice(adjudicationLimit)
  ]
    .filter((target, index, all) => all.findIndex((item) => item.id === target.id) === index)
    .filter((target) => !usedTarget.has(target.id));
  const fallbackBase = sourceArticles.filter((source) => !usedBase.has(source.id));
  const fallbackMatches = matchArticles(fallbackBase, fallbackTargets)
    .filter((pair) => pairBase(pair) && pairTarget(pair))
    .map((pair) => ({
      base: pairBase(pair)!,
      target: pairTarget(pair)!,
      score: pair.matchScore
    }));

  return pairArticlesFromMatches(sourceArticles, targetArticles, [...aiMatches, ...fallbackMatches]);
}

function isAdjudicatedMatch(
  outcome: (ArticleMatch & { confidence: number }) | { fallbackTarget: Article } | undefined
): outcome is ArticleMatch & { confidence: number } {
  return Boolean(outcome && "base" in outcome && "target" in outcome);
}

function resolveAdjudicatedMatches(
  matches: Array<ArticleMatch & { confidence: number }>,
  targetArticles: Article[]
) {
  const targetOrder = new Map(targetArticles.map((article, index) => [article.id, index]));
  const usedBase = new Set<string>();
  const usedTarget = new Set<string>();
  const selected: ArticleMatch[] = [];

  matches
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score)
    .forEach((match) => {
      if (usedBase.has(match.base.id) || usedTarget.has(match.target.id)) return;
      usedBase.add(match.base.id);
      usedTarget.add(match.target.id);
      selected.push({ base: match.base, target: match.target, score: match.score });
    });

  return selected.sort(
    (a, b) => (targetOrder.get(a.target.id) ?? 0) - (targetOrder.get(b.target.id) ?? 0)
  );
}

function bestDirectTitleCandidate(candidates: ArticleMatch[], target: Article) {
  return candidates
    .filter((candidate) => !hasHardTopicMismatch(candidate.base, target))
    .map((candidate) => ({
      candidate,
      lineageScore: titleLineageScore(candidate.base, target)
    }))
    .filter((entry) => entry.lineageScore >= 0.72)
    .sort((a, b) => b.lineageScore - a.lineageScore || b.candidate.score - a.candidate.score)
    .at(0)?.candidate;
}

function mergeArticles(primary: Article[], extra: Article[]) {
  const merged = new Map<string, Article>();
  for (const article of [...primary, ...extra]) {
    if (!merged.has(article.url)) {
      merged.set(article.url, article);
    }
  }
  return dedupeSameTitleArticles([...merged.values()]);
}

function dedupeSameTitleArticles(articles: Article[]) {
  const byTitle = new Map<string, Article>();
  for (const article of articles) {
    const key = `${article.source}:${normalizeComparableTitle(article.title)}`;
    const current = byTitle.get(key);
    if (!current || article.body.length > current.body.length) {
      byTitle.set(key, article);
    }
  }
  return [...byTitle.values()];
}

function normalizeComparableTitle(input: string) {
  return input
    .normalize("NFKC")
    .replace(/--.*$/, "")
    .replace(/\s+/g, "")
    .trim();
}

function isRejectedMatch(pair: ArticlePair) {
  const base = pairBase(pair);
  const target = pairTarget(pair);
  return Boolean(
    base &&
      target &&
      pair.analysis &&
      (pair.analysis.sameTopic === false || (pair.analysis.matchConfidence ?? 100) < 45)
  );
}

function splitRejectedPair(pair: ArticlePair): ArticlePair[] {
  const source = pairBase(pair)!;
  const target = pairTarget(pair)!;
  return [
    {
      id: stableId(`${source.id}:rejected-source:${pair.id}`),
      status: "CN ONLY",
      visibilityStatus: "BASE_ONLY",
      base: source,
      cn: source,
      sourceLanguage: source.source,
      targetLanguage: target.source,
      articlesBySource: { [source.source]: source },
      onlySource: source.source,
      matchScore: 0,
      highlights: source.keywords.slice(0, 5)
    },
    {
      id: stableId(`${target.id}:rejected-target:${pair.id}`),
      status: targetOnlyStatus(target),
      visibilityStatus: "TARGET_ONLY",
      target,
      jp: target,
      sourceLanguage: source.source,
      targetLanguage: target.source,
      articlesBySource: { [target.source]: target },
      onlySource: target.source,
      matchScore: 0,
      highlights: target.keywords.slice(0, 5)
    }
  ];
}

export function calculateStats(
  pairs: ArticlePair[],
  cnCount: number,
  jpCount: number,
  sourceLanguage: PeopleLanguage = "CN",
  targetLanguage: PeopleLanguage = "JP"
): RefreshStats {
  const matched = pairs.filter((pair) => pairBase(pair) && pairTarget(pair)).length;
  const cnOnly = pairs.filter(isBaseOnlyPair).length;
  const jpOnly = pairs.filter(isTargetOnlyPair).length;
  const framingShift = pairs.filter(hasFramingShift).length;
  const bodyDifference = pairs.filter(hasBodyDifference).length;
  const coverageRatio = cnCount ? Math.round((matched / cnCount) * 100) : 0;
  const allArticles = uniqueArticles(
    pairs.flatMap((pair) => [pairBase(pair), pairTarget(pair)]).filter(Boolean) as Article[]
  );

  return {
    cnCount,
    jpCount,
    baseCount: cnCount,
    targetCount: jpCount,
    countsBySource: {
      [sourceLanguage]: cnCount,
      [targetLanguage]: jpCount
    },
    cnDateCounts: countByDate(allArticles.filter((article) => article.source === sourceLanguage)),
    jpDateCounts: countByDate(allArticles.filter((article) => article.source === targetLanguage)),
    dateCountsBySource: {
      [sourceLanguage]: countByDate(
        allArticles.filter((article) => article.source === sourceLanguage)
      ),
      [targetLanguage]: countByDate(
        allArticles.filter((article) => article.source === targetLanguage)
      )
    },
    dateMismatches: allArticles.filter((article) => article.dateMismatch).length,
    matched,
    cnOnly,
    jpOnly,
    baseOnly: cnOnly,
    targetOnly: jpOnly,
    framingShift,
    bodyDifference,
    coverageRatio
  };
}

function hasBodyDifference(pair: ArticlePair) {
  const base = pairBase(pair);
  const target = pairTarget(pair);
  if (!base || !target) return false;
  const analysis = pair.analysis;
  if (analysis?.analysisStatus === "unavailable") return false;
  const bodyScore = analysis?.bodyDifferenceScore ?? 0;
  const hasPointDiff = Boolean(
    analysis && (analysis.missingPoints.length > 0 || analysis.emphasizedPoints.length > 0)
  );

  return (
    pair.status === "BODY DIFFERENCE" ||
    bodyScore >= 35 ||
    hasPointDiff
  );
}

function isBaseOnlyPair(pair: ArticlePair) {
  if (pair.visibilityStatus === "BASE_ONLY") return true;
  if (pair.visibilityStatus) return false;
  return Boolean(pairBase(pair) && !pairTarget(pair));
}

function isTargetOnlyPair(pair: ArticlePair) {
  if (pair.visibilityStatus === "TARGET_ONLY") return true;
  if (pair.visibilityStatus) return false;
  return Boolean(!pairBase(pair) && pairTarget(pair));
}

function hasFramingShift(pair: ArticlePair) {
  if (!pairBase(pair) || !pairTarget(pair)) return false;
  const analysis = pair.analysis;
  if (analysis?.analysisStatus === "unavailable") return false;
  const framingScore = analysis?.framingShiftScore ?? 0;

  return pair.status === "FRAMING SHIFT" || framingScore >= 55;
}

function pairBase(pair: ArticlePair) {
  return pair.base ?? pair.cn;
}

function pairTarget(pair: ArticlePair) {
  return pair.target ?? pair.jp;
}

function filterPairsByDateScope(
  pairs: ArticlePair[],
  targetDateScope: string[],
  explicitSourceDateScope?: string[]
) {
  if (!targetDateScope.length && !explicitSourceDateScope?.length) return pairs;
  const targetDates = new Set(targetDateScope);
  const sourceDates = new Set(explicitSourceDateScope ?? targetDateScope);
  return pairs.filter((pair) => {
    const base = pairBase(pair);
    const target = pairTarget(pair);
    return (
      (target && targetDates.has(articleDate(target))) ||
      (base && sourceDates.has(articleDate(base)))
    );
  });
}

function collectSourceArticles(pairs: ArticlePair[], source: PeopleLanguage) {
  const articles = pairs
    .flatMap((pair) => [pairBase(pair), pairTarget(pair)])
    .filter((article): article is Article => Boolean(article && article.source === source));
  return uniqueArticles(articles);
}

function uniqueArticles(articles: Article[]) {
  return [...new Map(articles.map((article) => [article.id, article])).values()];
}

function articleDate(article: Article) {
  return article.urlDate || article.publishedDate || "";
}

function clampLimit(limit: number) {
  if (!Number.isFinite(limit)) return 8;
  return Math.min(40, Math.max(3, Math.round(limit)));
}

function normalizedNumber(input: number | undefined) {
  return typeof input === "number" && Number.isFinite(input) ? Math.round(input) : undefined;
}

function aiConcurrency() {
  const configured = Number(process.env.PEOPLEDIFF_AI_CONCURRENCY);
  if (!Number.isFinite(configured) || configured <= 0) return 6;
  return Math.min(12, Math.max(2, Math.round(configured)));
}

function resolveAiArticleLimit(
  input: number | undefined,
  articleLimit: number,
  hasDateScope: boolean
) {
  if (input === 0) return 0;
  const configured =
    input && Number.isFinite(input)
      ? input
      : Number(process.env.PEOPLEDIFF_AI_ARTICLE_LIMIT);
  if (!Number.isFinite(configured) || configured <= 0) {
    return hasDateScope ? Math.max(32, articleLimit * 4) : Math.max(16, articleLimit * 2);
  }
  return Math.max(1, Math.round(configured));
}

function countByDate(articles: Article[]) {
  return articles.reduce<Record<string, number>>((counts, article) => {
    const date = article.urlDate || article.publishedDate || "unknown";
    counts[date] = (counts[date] ?? 0) + 1;
    return counts;
  }, {});
}

function normalizeDateScope(dates: string[] | undefined) {
  return [...new Set((dates ?? []).map(normalizeDateInput).filter(Boolean))] as string[];
}

function resolveTargetDateScope(options: RefreshOptions) {
  const explicitTarget = normalizeDateScope(options.targetDates);
  if (explicitTarget.length) return explicitTarget;
  const direct = normalizeDateScope(options.dates);
  if (direct.length) return direct;
  return dateRangeScope(options.targetDateFrom ?? options.dateFrom, options.targetDateTo ?? options.dateTo);
}

function resolveSourceDateScope(options: RefreshOptions) {
  const explicitSource = normalizeDateScope(options.sourceDates);
  if (explicitSource.length) return explicitSource;
  const range = dateRangeScope(options.sourceDateFrom, options.sourceDateTo);
  return range.length ? range : undefined;
}

function sourceLookbackDateScope(dateScope: string[], lookbackDays: number) {
  if (!dateScope.length) return dateScope;
  const dates = new Set(dateScope);
  for (const date of dateScope) {
    for (let offset = 1; offset <= lookbackDays; offset += 1) {
      dates.add(addDays(date, -offset));
    }
  }
  return [...dates].sort((a, b) => b.localeCompare(a));
}

function sourceMaxArticles(
  maxArticles: number | undefined,
  dateScope: string[],
  sourceDateScope: string[]
) {
  if (!dateScope.length) return maxArticles;
  const requested = maxArticles ?? 240;
  const perSourceDateFloor = 120;
  const scaledForDateRange = Math.min(1200, Math.max(requested, sourceDateScope.length * perSourceDateFloor));
  if (sourceDateScope.length === dateScope.length) return scaledForDateRange;
  const extraDays = Math.max(0, sourceDateScope.length - dateScope.length);
  return Math.min(1200, Math.max(scaledForDateRange, requested + extraDays * perSourceDateFloor));
}

function resolveSourceLookbackDays(input: number | undefined) {
  if (typeof input !== "number" || !Number.isFinite(input)) return 3;
  return Math.min(14, Math.max(0, Math.round(input)));
}

function dateRangeScope(fromInput: string | undefined, toInput: string | undefined) {
  const from = normalizeDateInput(fromInput);
  const to = normalizeDateInput(toInput);
  if (!from && !to) return [];

  const start = from ?? to;
  const end = to ?? from;
  if (!start || !end) return [];

  const startDate = start <= end ? start : end;
  const endDate = start <= end ? end : start;
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate && dates.length < 31) {
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

function normalizeDateInput(input: string | undefined) {
  const match = input?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return isRealDate(normalized) ? normalized : undefined;
}

function isRealDate(input: string) {
  const [year, month, day] = input.split("-").map(Number);
  if (!year || !month || !day) return false;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10) === input;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
