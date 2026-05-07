import type { Article, ArticlePair, RefreshResult, RefreshStats } from "./types";
import { analyzeDifference, activeModelLabel, enrichChineseArticle, enrichJapaneseArticle } from "./openai";
import { applyAnalysisStatus, matchArticles } from "./matcher";
import { scrapePeople } from "./scraper";

type RefreshOptions = {
  limit?: number;
  dates?: string[];
  maxPages?: number;
  maxArticles?: number;
};

export async function refreshSnapshot(options: RefreshOptions = {}): Promise<RefreshResult> {
  const limit = clampLimit(options.limit ?? 8);
  const dateScope = normalizeDateScope(options.dates);
  const warnings: string[] = [];
  const [cnSettled, jpSettled] = await Promise.allSettled([
    scrapePeople("CN", {
      limit,
      dates: dateScope,
      maxPages: options.maxPages,
      maxArticles: options.maxArticles
    }),
    scrapePeople("JP", {
      limit,
      dates: dateScope,
      maxPages: options.maxPages,
      maxArticles: options.maxArticles
    })
  ]);

  let cnArticles: Article[] = [];
  let jpArticles: Article[] = [];

  if (cnSettled.status === "fulfilled") {
    cnArticles = cnSettled.value;
  } else {
    warnings.push(`中国語版の取得に失敗: ${cnSettled.reason}`);
  }

  if (jpSettled.status === "fulfilled") {
    jpArticles = jpSettled.value;
  } else {
    warnings.push(`日本語版の取得に失敗: ${jpSettled.reason}`);
  }

  const aiArticleLimit = dateScope.length ? 24 : 999;
  const [enrichedCn, enrichedJp] = await Promise.all([
    mapWithConcurrency(cnArticles, 3, (article, index) =>
      enrichChineseArticle(article, { useAi: index < aiArticleLimit })
    ),
    mapWithConcurrency(jpArticles, 3, (article, index) =>
      enrichJapaneseArticle(article, { useAi: index < aiArticleLimit })
    )
  ]);

  const basePairs = matchArticles(enrichedCn, enrichedJp);
  const analyzedPairs = await enrichPairs(basePairs);

  return {
    generatedAt: new Date().toISOString(),
    mode: "live",
    model: activeModelLabel(),
    dateScope,
    cnArticles: enrichedCn,
    jpArticles: enrichedJp,
    pairs: analyzedPairs,
    stats: calculateStats(analyzedPairs, enrichedCn.length, enrichedJp.length),
    warnings
  };
}

export function emptySnapshot(): RefreshResult {
  return {
    generatedAt: new Date().toISOString(),
    mode: "empty",
    model: activeModelLabel(),
    dateScope: [],
    cnArticles: [],
    jpArticles: [],
    pairs: [],
    stats: calculateStats([], 0, 0),
    warnings: []
  };
}

async function enrichPairs(pairs: ArticlePair[]) {
  const matched = pairs
    .filter((pair) => pair.cn && pair.jp)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 6);
  const analysisById = new Map<string, ArticlePair>();

  const analyzed = await mapWithConcurrency(matched, 2, async (pair) => {
    const analysis = await analyzeDifference(pair.cn!, pair.jp!);
    return applyAnalysisStatus({ ...pair, analysis });
  });

  analyzed.forEach((pair) => analysisById.set(pair.id, pair));
  return pairs.map((pair) => analysisById.get(pair.id) ?? pair);
}

export function calculateStats(
  pairs: ArticlePair[],
  cnCount: number,
  jpCount: number
): RefreshStats {
  const matched = pairs.filter((pair) => pair.cn && pair.jp).length;
  const cnOnly = pairs.filter((pair) => pair.status === "CN ONLY").length;
  const jpOnly = pairs.filter((pair) => pair.status === "JP ONLY").length;
  const framingShift = pairs.filter(hasFramingShift).length;
  const bodyDifference = pairs.filter(hasBodyDifference).length;
  const coverageRatio = cnCount ? Math.round((matched / cnCount) * 100) : 0;
  const allArticles = pairs.flatMap((pair) => [pair.cn, pair.jp]).filter(Boolean) as Article[];

  return {
    cnCount,
    jpCount,
    cnDateCounts: countByDate(allArticles.filter((article) => article.source === "CN")),
    jpDateCounts: countByDate(allArticles.filter((article) => article.source === "JP")),
    dateMismatches: allArticles.filter((article) => article.dateMismatch).length,
    matched,
    cnOnly,
    jpOnly,
    framingShift,
    bodyDifference,
    coverageRatio
  };
}

function hasBodyDifference(pair: ArticlePair) {
  if (!pair.cn || !pair.jp) return false;
  const analysis = pair.analysis;
  const bodyScore = analysis?.bodyDifferenceScore ?? 0;
  const hasPointDiff = Boolean(
    analysis && (analysis.missingPoints.length > 0 || analysis.emphasizedPoints.length > 0)
  );

  return (
    pair.status === "BODY DIFFERENCE" ||
    bodyScore >= 35 ||
    hasPointDiff ||
    Math.abs(pair.cn.body.length - pair.jp.body.length) > 1800
  );
}

function hasFramingShift(pair: ArticlePair) {
  if (!pair.cn || !pair.jp) return false;
  const analysis = pair.analysis;
  const framingScore = analysis?.framingShiftScore ?? 0;

  return pair.status === "FRAMING SHIFT" || framingScore >= 55;
}

function clampLimit(limit: number) {
  if (!Number.isFinite(limit)) return 8;
  return Math.min(40, Math.max(3, Math.round(limit)));
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

function normalizeDateInput(input: string | undefined) {
  const match = input?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
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
