import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { PEOPLE_LANGUAGE_CODES, getPeopleLanguageConfig } from "./languages";
import { scorePair } from "./matcher";
import {
  adjudicateSameTopicMatch,
  canUseOpenAI,
  enrichChineseArticle,
  enrichJapaneseArticle
} from "./openai";
import {
  charNgrams,
  cleanText,
  compactSummary,
  extractKeywords,
  jaccard,
  keywordOverlap,
  normalizeForMatch,
  stableId,
  truncate
} from "./text";
import type { Article } from "./types";

const USER_AGENT =
  "PeopleDiff/0.1 (+https://vercel.app; research dashboard; contact: local-poc)";
const PEOPLE_SEARCH_ENDPOINT = "http://search.people.cn/search-platform/front/search";
const ARTICLE_CACHE_LIMIT = 500;
const VERIFIED_SHORT_PEOPLE_SEARCH_QUERIES = new Set([
  "投毒",
  "献祭品",
  "村山谈话",
  "日元贬值",
  "人形机器人"
]);
const VERIFIED_PEOPLE_SEARCH_QUERY_ALIASES: Array<{
  pattern: RegExp;
  query: string;
}> = [
  {
    pattern: /投毒|毒を盛|毒殺|毒物|中毒/u,
    query: "投毒"
  },
  {
    pattern: /再军事化.*野心|再軍事化.*野心|軍事化.*野心/u,
    query: "日本再军事化野心"
  },
  {
    pattern: /村山谈话|村山談話/u,
    query: "村山谈话"
  },
  {
    pattern: /何立峰.*(?:贝森特|ベッセント|财政部长|財務長官|通商代表|格里尔|グリア)/u,
    query: "何立峰与美国财政部长贝森特"
  },
  {
    pattern: /献祭品|供物|生贄|いけにえ|祭祀品|祭祀用品/u,
    query: "献祭品"
  },
  {
    pattern: /高市.*(?:靖国|献祭品|供物|祭祀品)|靖国.*(?:献祭品|供物|祭祀品)/u,
    query: "高市向靖国神社献祭品"
  },
  {
    pattern: /东京审判铁证如山|東京裁判.*(?:鉄証|铁证|証拠|证据)|东京审判.*(?:铁证|証拠|证据)|鉄証如山|铁证如山/u,
    query: "东京审判铁证如山"
  },
  {
    pattern: /放开杀伤性武器出口|殺傷性?武器.*(?:輸出|解禁)|殺傷兵器.*(?:輸出|解禁)|武器輸出.*(?:解禁|緩和)|防衛装備移転|杀伤性武器.*出口/u,
    query: "放开杀伤性武器出口"
  },
  {
    pattern: /日元贬值|円安|日本円安|円の下落|日元貶值|日元.*(?:贬值|下跌)/u,
    query: "日元持续贬值"
  },
  {
    pattern: /人形机器人|人型ロボット|ヒューマノイド|humanoid robot|humanoid robots|人型机器人/u,
    query: "人形机器人"
  }
];

export type JpMajorMatchStatus = "MATCHED" | "CANDIDATE" | "NO_MATCH";

export type JpMajorMatcherOptions = {
  dates?: string[];
  maxQueries?: number;
  maxResultsPerQuery?: number;
  maxCandidates?: number;
  candidateLimit?: number;
  minScore?: number;
  useAi?: boolean;
  includeNoMatch?: boolean;
  fetchConcurrency?: number;
};

export type JpMajorSearchCandidate = {
  title: string;
  url: string;
  urlDate?: string;
  listPublishedAt?: string;
  listDate?: string;
  category?: string;
  queries: string[];
  bestSearchRank: number;
};

export type JpMajorScoredCandidate = {
  article: Article;
  score: number;
  reason: string;
  match_score: number;
  match_reason: string;
  status: JpMajorMatchStatus;
  heuristic_score: number;
  ai_score?: number;
  ai_reason?: string;
  searchQuery?: string;
  searchRank?: number;
  search: {
    queries: string[];
    bestRank: number;
    urlDate?: string;
    listDate?: string;
  };
  signals: string[];
};

export type JpMajorMatcherResult = {
  jp: Article;
  queries: string[];
  candidates: JpMajorScoredCandidate[];
  best?: JpMajorScoredCandidate;
  match_score: number;
  match_reason: string;
  status: JpMajorMatchStatus;
  warnings: string[];
};

export type JpMajorSingleMatchResult = {
  cn?: Article;
  match_score: number;
  match_reason: string;
  status: JpMajorMatchStatus;
  candidate_count: number;
  search_queries: string[];
  candidates: JpMajorScoredCandidate[];
  warnings: string[];
};

type PeopleSearchRecord = {
  title?: string;
  url?: string;
  displayTime?: number;
  inputTime?: number;
  belongsName?: string;
};

type ScoringContext = {
  queries?: string[];
  bestSearchRank?: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_JP_MAJOR_ARTICLE_CACHE__: Map<string, Article> | undefined;
}

export async function findCnCandidatesForJpArticle(
  jpArticle: Article,
  options: JpMajorMatcherOptions = {}
): Promise<JpMajorMatcherResult> {
  const warnings: string[] = [];
  const useAi = options.useAi !== false;
  const jp = await enrichJapaneseArticle(jpArticle, { useAi });
  const queries = buildJpAnchoredPeopleSearchQueries(jp).slice(0, options.maxQueries ?? 10);

  if (jp.source !== "JP") {
    warnings.push(`JPアンカー想定ですが、入力記事のsourceは${jp.source}です。`);
  }

  if (!queries.length) {
    return emptyResult(
      jp,
      queries,
      warnings,
      "JP記事から人民網検索APIに渡せる固有語クエリを作れませんでした。"
    );
  }

  const dateScope = normalizeDateScope(options.dates);
  const searched = await mapWithConcurrency(
    queries,
    Math.min(4, Math.max(1, options.fetchConcurrency ?? 4)),
    async (query) => {
      try {
        return await queryPeopleSearch(query, options.maxResultsPerQuery ?? 8);
      } catch (error) {
        warnings.push(`人民網検索取得失敗: ${query} (${errorMessage(error)})`);
        return [] as JpMajorSearchCandidate[];
      }
    }
  );

  const candidates = mergeSearchCandidates(searched.flat())
    .filter((candidate) => {
      const date = candidate.urlDate || candidate.listDate;
      return !dateScope.length || dateScope.includes(date ?? "");
    })
    .sort((a, b) => searchCandidateRank(a) - searchCandidateRank(b))
    .slice(0, options.maxCandidates ?? options.candidateLimit ?? 24);

  if (!candidates.length) {
    return emptyResult(
      jp,
      queries,
      warnings,
      "人民網検索APIでCN候補が見つかりませんでした。"
    );
  }

  const scraped = await mapWithConcurrency(
    candidates,
    scrapeConcurrency(options.fetchConcurrency),
    async (candidate) => {
      try {
        return {
          candidate,
          article: await scrapeChineseArticleCandidate(candidate)
        };
      } catch (error) {
        warnings.push(`CN候補本文取得失敗: ${candidate.title} (${errorMessage(error)})`);
        return undefined;
      }
    }
  );

  const scrapedArticles = scraped.filter(
    (item): item is { candidate: JpMajorSearchCandidate; article: Article } => Boolean(item)
  );

  if (!scrapedArticles.length) {
    return emptyResult(jp, queries, warnings, "CN候補の本文を取得できませんでした。");
  }

  const enriched = await mapWithConcurrency(
    scrapedArticles,
    Math.min(4, Math.max(1, options.fetchConcurrency ?? 4)),
    async ({ candidate, article }) => ({
      candidate,
      article: await enrichChineseArticle(article, { useAi })
    })
  );

  let scored = enriched
    .map(({ candidate, article }) =>
      scoreCnCandidateForJpArticleSync(jp, article, {
        queries: candidate.queries,
        bestSearchRank: candidate.bestSearchRank
      })
    )
    .sort(compareScoredCandidates);

  if (useAi && canUseOpenAI() && scored.length) {
    const aiPool = scored
      .filter((candidate) => candidate.match_score >= 28)
      .slice(0, 6)
      .map((candidate) => ({
        baseId: candidate.article.id,
        score: candidate.match_score / 100,
        article: candidate.article
      }));
    const decision = await adjudicateSameTopicMatch(jp, aiPool);
    if (decision) {
      scored = applyAiDecision(scored, decision).sort(compareScoredCandidates);
    }
  }

  const minScore = options.minScore ?? (options.includeNoMatch ? 0 : 28);
  const visibleCandidates = scored.filter(
    (candidate) => options.includeNoMatch || candidate.match_score >= minScore
  );
  const candidatesForResult = visibleCandidates.length ? visibleCandidates : scored.slice(0, 1);
  const best =
    candidatesForResult.find((candidate) => candidate.status !== "NO_MATCH") ??
    candidatesForResult[0];

  return {
    jp,
    queries,
    candidates: candidatesForResult,
    best,
    match_score: best?.match_score ?? 0,
    match_reason: best?.match_reason ?? "CN候補がありません。",
    status: best?.status ?? "NO_MATCH",
    warnings: trimWarnings(warnings)
  };
}

export const findChineseCandidatesForJapaneseArticle = findCnCandidatesForJpArticle;

export async function findChineseMatchForJapaneseArticle(
  jpArticle: Article,
  options: JpMajorMatcherOptions = {}
): Promise<JpMajorSingleMatchResult> {
  const result = await findCnCandidatesForJpArticle(jpArticle, options);
  const best = result.best?.status === "MATCHED" ? result.best : undefined;

  return {
    cn: best?.article,
    match_score: result.best?.match_score ?? 0,
    match_reason: result.best?.match_reason ?? result.match_reason,
    status: result.best?.status ?? "NO_MATCH",
    candidate_count: result.candidates.length,
    search_queries: result.queries,
    candidates: result.candidates,
    warnings: result.warnings
  };
}

export async function scoreCnCandidateForJpArticle(
  jpArticle: Article,
  cnArticle: Article,
  options: JpMajorMatcherOptions & ScoringContext = {}
): Promise<JpMajorScoredCandidate> {
  const useAi = options.useAi !== false;
  const jp = await enrichJapaneseArticle(jpArticle, { useAi });
  const cn = await enrichChineseArticle(cnArticle, { useAi });
  const scored = scoreCnCandidateForJpArticleSync(jp, cn, options);

  if (!useAi || !canUseOpenAI()) return scored;

  const decision = await adjudicateSameTopicMatch(jp, [
    {
      baseId: cn.id,
      score: scored.match_score / 100,
      article: cn
    }
  ]);
  return decision ? applyAiDecision([scored], decision)[0] : scored;
}

export const scoreChineseCandidateForJapaneseArticle = scoreCnCandidateForJpArticle;

export function buildJpAnchoredPeopleSearchQueries(article: Article) {
  const rawInputs = [
    article.title,
    article.translatedTitle,
    ...article.keywords,
    article.summary
  ].filter(Boolean) as string[];
  const queries: string[] = [];

  for (const input of rawInputs.slice(0, 12)) {
    const direct = normalizeChineseSearchQuery(input);
    if (isUsefulPeopleSearchQuery(direct)) queries.push(direct);

    for (const verified of verifiedSearchQueries(input)) {
      if (isUsefulPeopleSearchQuery(verified)) queries.push(verified);
    }

    for (const specialized of specializedSearchQueries(input)) {
      if (isUsefulPeopleSearchQuery(specialized)) queries.push(specialized);
    }
  }

  const titleTokens = specificSearchTokens(
    [article.title, article.translatedTitle, article.keywords.join(" ")].filter(Boolean).join(" ")
  );
  for (const query of combineSearchTokens(titleTokens)) {
    if (isUsefulPeopleSearchQuery(query)) queries.push(query);
  }

  return [...new Set(queries)]
    .sort((a, b) => queryQualityScore(b) - queryQualityScore(a))
    .slice(0, 16);
}

export const buildJapaneseAnchoredPeopleSearchQueries = buildJpAnchoredPeopleSearchQueries;

function scoreCnCandidateForJpArticleSync(
  jp: Article,
  cn: Article,
  context: ScoringContext = {}
): JpMajorScoredCandidate {
  const pairScore = scorePair(cn, jp);
  const titleScore = titleSimilarityScore(jp, cn);
  const keywordScore = bilingualKeywordScore(jp, cn);
  const queryScore = searchQueryScore(cn, context.queries ?? []);
  const tokenScore = tokenAnchorScore(jp, cn);
  const bodyScore = leadSimilarityScore(jp, cn);
  const dateBonus = dateProximityBonus(jp, cn);
  const rankBonus = Math.max(0, 5 - Math.min(context.bestSearchRank ?? 5, 5));

  let score =
    pairScore * 38 +
    titleScore * 24 +
    keywordScore * 14 +
    queryScore * 18 +
    tokenScore * 16 +
    bodyScore * 8 +
    dateBonus +
    rankBonus;

  if (
    queryScore >= 0.52 &&
    dateBonus >= 8 &&
    (pairScore >= 0.3 || titleScore >= 0.35 || keywordScore >= 0.35 || tokenScore >= 0.38)
  ) {
    score = Math.max(score, 72);
  }
  if (queryScore >= 0.66 && dateBonus >= 8 && rankBonus >= 4) {
    score = Math.max(score, 70);
  }
  if (
    dateBonus >= 8 &&
    pairScore >= 0.34 &&
    (titleScore >= 0.35 || keywordScore >= 0.35 || tokenScore >= 0.35)
  ) {
    score = Math.max(score, 70);
  }

  const hasStrongAnchor =
    pairScore >= 0.34 ||
    titleScore >= 0.42 ||
    queryScore >= 0.45 ||
    tokenScore >= 0.5 ||
    keywordScore >= 0.35;
  const hasAnyAnchor =
    pairScore >= 0.16 ||
    titleScore >= 0.22 ||
    queryScore >= 0.24 ||
    tokenScore >= 0.25 ||
    keywordScore >= 0.2;

  if (!hasAnyAnchor) score = Math.min(score, 34);
  if (!hasStrongAnchor) score = Math.min(score, 58);
  if (!cn.body || cn.body.length < 80) score = Math.min(score, 52);

  const match_score = clampScore(Math.round(score));
  const status = statusFromScore(match_score);
  const signals = buildSignals({
    pairScore,
    titleScore,
    keywordScore,
    queryScore,
    tokenScore,
    bodyScore,
    dateBonus,
    rankBonus,
    cn
  });
  const match_reason = buildRuleReason(status, signals, match_score);

  return {
    article: cn,
    score: match_score,
    reason: match_reason,
    match_score,
    match_reason,
    status,
    heuristic_score: match_score,
    searchQuery: context.queries?.[0],
    searchRank: context.bestSearchRank,
    search: {
      queries: context.queries ?? [],
      bestRank: context.bestSearchRank ?? 0,
      urlDate: cn.urlDate,
      listDate: cn.publishedDate
    },
    signals
  };
}

function applyAiDecision(
  candidates: JpMajorScoredCandidate[],
  decision: {
    baseId?: string;
    sameTopic: boolean;
    matchConfidence: number;
    reason: string;
  }
) {
  if (!decision.baseId) {
    return candidates.map((candidate) => {
      const matchReason =
        candidate.match_score >= 60
          ? `AI判定では同一話題を選びませんでした。ルール判定: ${candidate.match_reason}`
          : candidate.match_reason;
      return {
        ...candidate,
        reason: matchReason,
        match_reason: matchReason,
        ai_score: decision.matchConfidence,
        ai_reason: decision.reason
      };
    });
  }

  return candidates.map((candidate) => {
    if (candidate.article.id !== decision.baseId) {
      const matchReason = `AI判定は別候補を同一話題として選択。ルール判定: ${candidate.match_reason}`;
      return candidate.status === "MATCHED"
        ? {
            ...candidate,
            status: "CANDIDATE" as const,
            reason: matchReason,
            match_reason: matchReason,
            ai_score: decision.matchConfidence,
            ai_reason: decision.reason
          }
        : candidate;
    }

    const aiScore = clampScore(decision.matchConfidence);
    const match_score = clampScore(Math.max(candidate.match_score, aiScore));
    const status = statusFromScore(match_score, decision.sameTopic);
    return {
      ...candidate,
      score: match_score,
      reason: `AI同一話題判定: ${decision.reason} ルール判定: ${candidate.match_reason}`,
      match_score,
      status,
      ai_score: aiScore,
      ai_reason: decision.reason,
      match_reason: `AI同一話題判定: ${decision.reason} ルール判定: ${candidate.match_reason}`
    };
  });
}

async function queryPeopleSearch(
  query: string,
  limit: number
): Promise<JpMajorSearchCandidate[]> {
  const response = await fetch(PEOPLE_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      origin: "http://search.people.cn",
      referer: "http://search.people.cn/s/"
    },
    body: JSON.stringify({
      key: query,
      page: 1,
      limit
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for People search`);
  }

  const json = (await response.json()) as {
    data?: {
      records?: PeopleSearchRecord[];
    };
  };

  return (json.data?.records ?? [])
    .map((record, index) => candidateFromPeopleSearchRecord(record, query, index + 1))
    .filter((candidate): candidate is JpMajorSearchCandidate => Boolean(candidate));
}

function candidateFromPeopleSearchRecord(
  record: PeopleSearchRecord,
  query: string,
  rank: number
): JpMajorSearchCandidate | undefined {
  const title = cleanTitle(stripInlineHtml(record.title ?? ""));
  if (!record.url || !title || !isLikelyChineseArticleUrl(record.url)) return undefined;
  const listPublishedAt = peopleSearchTime(record.displayTime ?? record.inputTime);

  return {
    title,
    url: record.url,
    urlDate: extractDateFromUrl(record.url),
    listPublishedAt,
    listDate: normalizePublishedDate(listPublishedAt),
    category: record.belongsName || inferCategory(record.url, title),
    queries: [query],
    bestSearchRank: rank
  } satisfies JpMajorSearchCandidate;
}

function mergeSearchCandidates(candidates: JpMajorSearchCandidate[]) {
  const merged = new Map<string, JpMajorSearchCandidate>();

  for (const candidate of candidates) {
    const existing = merged.get(candidate.url);
    if (!existing) {
      merged.set(candidate.url, candidate);
      continue;
    }

    existing.queries = [...new Set([...existing.queries, ...candidate.queries])];
    existing.bestSearchRank = Math.min(existing.bestSearchRank, candidate.bestSearchRank);
    existing.listPublishedAt ??= candidate.listPublishedAt;
    existing.listDate ??= candidate.listDate;
    existing.category ??= candidate.category;
  }

  return [...merged.values()];
}

async function scrapeChineseArticleCandidate(
  candidate: JpMajorSearchCandidate
): Promise<Article> {
  const cached = cachedArticle(candidate.url);
  if (cached) return cached;

  const html = await fetchDecodedHtml(candidate.url);
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg, form, nav, footer").remove();

  const title =
    cleanTitle(
      $("meta[property='og:title']").attr("content") ??
        $("meta[name='twitter:title']").attr("content") ??
        $("h1").first().text() ??
        candidate.title
    ) || candidate.title;
  const body = extractBody($);
  const category = extractCategory($, candidate.url, candidate.category);
  const publishedAt = extractPublishedAt($) || candidate.listPublishedAt;
  const urlDate = candidate.urlDate || extractDateFromUrl(candidate.url);
  const publishedDate = normalizePublishedDate(publishedAt);
  const sourceText = [title, category, body].filter(Boolean).join("\n");

  return rememberArticle({
    id: stableId(candidate.url),
    source: "CN",
    title,
    url: candidate.url,
    urlDate,
    publishedAt,
    publishedDate,
    dateMismatch: Boolean(urlDate && publishedDate && urlDate !== publishedDate),
    discoveredFrom: PEOPLE_SEARCH_ENDPOINT,
    category,
    body: truncate(body, 8000),
    summary: compactSummary(body, getPeopleLanguageConfig("CN").summaryLength),
    keywords: extractKeywords(sourceText)
  });
}

async function fetchDecodedHtml(url: string) {
  const { buffer, contentType } = await fetchHtmlBuffer(url);
  const sniff = buffer.subarray(0, 4096).toString("latin1");
  const charset =
    contentType.match(/charset=([^;]+)/i)?.[1] ??
    sniff.match(/charset=["']?([\w-]+)/i)?.[1] ??
    "utf-8";

  if (/gb2312|gbk|gb18030/i.test(charset)) {
    return iconv.decode(buffer, "gb18030");
  }

  return iconv.decode(buffer, "utf-8");
}

async function fetchHtmlBuffer(url: string) {
  try {
    return await fetchHtmlBufferOnce(url);
  } catch (error) {
    const fallbackUrl = httpFallbackUrl(url, error);
    if (!fallbackUrl) throw error;

    try {
      return await fetchHtmlBufferOnce(fallbackUrl);
    } catch (fallbackError) {
      throw new Error(
        `${errorMessage(error)}; HTTP fallback failed: ${errorMessage(fallbackError)}`
      );
    }
  }
}

async function fetchHtmlBufferOnce(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  return { buffer, contentType };
}

function httpFallbackUrl(url: string, error: unknown) {
  if (!isTlsCertificateError(error)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    if (!parsed.hostname.endsWith("people.com.cn") && !parsed.hostname.endsWith("people.cn")) {
      return undefined;
    }
    parsed.protocol = "http:";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function extractBody($: cheerio.CheerioAPI) {
  const selectors = [
    "article",
    ".rm_txt_con",
    ".artDet",
    ".article_text",
    ".text_con",
    ".p_content",
    ".d2txtCon",
    "#p_content",
    "#articleContent",
    "#rwb_zw",
    ".content",
    ".main"
  ];

  for (const selector of selectors) {
    const container = $(selector).first();
    if (!container.length) continue;
    const paragraphs = container
      .find("p")
      .map((_, p) => cleanText($(p).text()))
      .get()
      .filter(isContentParagraph);
    const body = cleanText(paragraphs.join("\n\n"));
    if (body.length > 40) return body;
  }

  const fallback = $("p")
    .map((_, p) => cleanText($(p).text()))
    .get()
    .filter(isContentParagraph)
    .join("\n\n");

  return cleanText(fallback);
}

function isContentParagraph(line: string) {
  if (line.length < 12) return false;
  return !/人民日报社概况|关于人民网|违法和不良信息|举报邮箱|互联网新闻信息服务许可证|增值电信业务经营许可证|京ICP备|京公网安备|版权所有|Copyright/i.test(
    line
  );
}

function extractCategory($: cheerio.CheerioAPI, url: string, fallback?: string) {
  const urlCategory = inferCategory(url, "");
  if (urlCategory) return urlCategory;

  const breadcrumb = $(
    ".path a, .p2j_con03_left_nav a, .gray a, .breadcrumb a, .crumb a"
  )
    .map((_, element) => cleanText($(element).text()))
    .get()
    .find(
      (text) =>
        text.length >= 2 &&
        text.length <= 12 &&
        !/首页|トップ|ホーム|人民|ニュース|新着|最新/.test(text)
    );

  return breadcrumb || fallback;
}

function extractPublishedAt($: cheerio.CheerioAPI) {
  const datetime = $("time").first().attr("datetime");
  if (datetime) return datetime;

  const pageText = cleanText($("body").text());
  const match =
    pageText.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/) ??
    pageText.match(/\d{4}-\d{1,2}-\d{1,2}\s*\d{1,2}:\d{2}/) ??
    pageText.match(/\d{4}年\d{1,2}月\d{1,2}日/);

  return match?.[0];
}

function isLikelyChineseArticleUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname;
  const path = parsed.pathname;
  if (!path.endsWith(".html")) return false;
  if (!isChineseArticleHost(host)) return false;
  if (/pic|photo|video|tv|fangtan/i.test(host + path)) return false;
  return /\/n\d\/\d{4}\/\d{4}\//.test(path) || /\/GB\/.+\.html$/i.test(path);
}

function isChineseArticleHost(host: string) {
  if (!host.endsWith("people.com.cn") && !host.endsWith("people.cn")) return false;
  const nonChineseHosts = new Set(
    PEOPLE_LANGUAGE_CODES
      .filter((code) => code !== "CN")
      .flatMap((code) => getPeopleLanguageConfig(code).articleHosts)
  );
  return !nonChineseHosts.has(host);
}

function inferCategory(url: string, title: string) {
  const text = `${url} ${title}`.toLowerCase();
  const pairs: Array<[RegExp, string]> = [
    [/politics|cpc|lianghui|领导|党建|时政|政治/, "政治"],
    [/world|国际|外交|global|foreign/, "国際"],
    [/military|army|navy|軍|军事|防衛/, "軍事"],
    [/taiwan|tw|台湾|台海/, "台湾"],
    [/finance|money|economy|经济|経済/, "経済"],
    [/society|社会|教育|health|医療/, "社会"],
    [/culture|文化|tour|観光|旅游/, "文化"],
    [/sports|体育|スポーツ/, "スポーツ"],
    [/tech|science|科学|科技/, "科学技術"]
  ];

  return pairs.find(([pattern]) => pattern.test(text))?.[1];
}

function titleSimilarityScore(jp: Article, cn: Article) {
  const jpTitle = normalizeForChineseSimilarity(jp.translatedTitle || jp.title);
  const rawJpTitle = normalizeForChineseSimilarity(jp.title);
  const cnTitle = normalizeForChineseSimilarity(cn.translatedTitle || cn.title);
  const rawCnTitle = normalizeForChineseSimilarity(cn.title);

  return Math.max(
    jaccard(charNgrams(jpTitle, 2), charNgrams(cnTitle, 2)),
    jaccard(charNgrams(rawJpTitle, 2), charNgrams(rawCnTitle, 2)),
    jaccard(charNgrams(jpTitle, 2), charNgrams(rawCnTitle, 2)),
    containmentScore(jpTitle, rawCnTitle),
    containmentScore(rawJpTitle, rawCnTitle)
  );
}

function bilingualKeywordScore(jp: Article, cn: Article) {
  const jpKeywords = jp.keywords.map(normalizeForChineseSimilarity).filter(Boolean);
  const cnKeywords = cn.keywords.map(normalizeForChineseSimilarity).filter(Boolean);
  return Math.max(
    keywordOverlap(jpKeywords, cnKeywords),
    tokenOverlap(jpKeywords, cnKeywords),
    tokenAnchorScore(jp, cn) * 0.8
  );
}

function searchQueryScore(cn: Article, queries: string[]) {
  if (!queries.length) return 0;
  const title = normalizeForChineseSimilarity(cn.title);
  const bodyLead = normalizeForChineseSimilarity(cn.body.slice(0, 500));
  return Math.max(
    ...queries.map((query) => {
      const normalized = normalizeForChineseSimilarity(query);
      return Math.max(
        jaccard(charNgrams(normalized, 2), charNgrams(title, 2)),
        containmentScore(normalized, title),
        containmentScore(normalized, bodyLead) * 0.75
      );
    })
  );
}

function tokenAnchorScore(jp: Article, cn: Article) {
  const left = topicAnchorTokens(jp);
  const right = topicAnchorTokens(cn);
  return tokenOverlap(left, right);
}

function leadSimilarityScore(jp: Article, cn: Article) {
  const jpLead = normalizeForChineseSimilarity([jp.summary, jp.body.slice(0, 260)].join(" "));
  const cnLead = normalizeForChineseSimilarity([cn.summary, cn.body.slice(0, 260)].join(" "));
  return jaccard(charNgrams(jpLead, 3), charNgrams(cnLead, 3));
}

function topicAnchorTokens(article: Article) {
  const text = [
    article.title,
    article.translatedTitle,
    article.summary,
    article.category,
    article.keywords.join(" ")
  ]
    .filter(Boolean)
    .join(" ");
  return specificSearchTokens(text).map(normalizeForMatch).filter(Boolean);
}

function tokenOverlap(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let hits = 0;
  for (const token of a) {
    if (b.has(token) || [...b].some((rightToken) => tokensTouch(token, rightToken))) hits += 1;
  }
  return hits / Math.max(Math.min(a.size, b.size), 1);
}

function tokensTouch(left: string, right: string) {
  if (left === right) return true;
  if (left.length >= 3 && right.includes(left)) return true;
  if (right.length >= 3 && left.includes(right)) return true;
  return jaccard(charNgrams(left, 2), charNgrams(right, 2)) >= 0.58;
}

function containmentScore(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 6 && longer.includes(shorter)) {
    return Math.min(0.92, shorter.length / Math.max(longer.length, 1) + 0.36);
  }
  return 0;
}

function dateProximityBonus(jp: Article, cn: Article) {
  const jpDate = jp.urlDate || jp.publishedDate;
  const cnDate = cn.urlDate || cn.publishedDate;
  if (!jpDate || !cnDate) return 0;
  const diff = Math.abs(daysBetween(jpDate, cnDate));
  if (diff === 0) return 8;
  if (diff === 1) return 5;
  if (diff <= 3) return 3;
  if (diff <= 7) return 1;
  return 0;
}

function daysBetween(left: string, right: string) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.round((leftTime - rightTime) / 86400000);
}

function buildSignals(input: {
  pairScore: number;
  titleScore: number;
  keywordScore: number;
  queryScore: number;
  tokenScore: number;
  bodyScore: number;
  dateBonus: number;
  rankBonus: number;
  cn: Article;
}) {
  const signals: string[] = [];
  if (input.pairScore >= 0.34) signals.push("既存マッチャーの同一話題スコアが高い");
  if (input.titleScore >= 0.42) signals.push("JP見出し由来語とCN見出しが近い");
  if (input.keywordScore >= 0.35) signals.push("キーワードが重なる");
  if (input.queryScore >= 0.45) signals.push("検索クエリがCN見出しまたはリードに強く当たる");
  if (input.tokenScore >= 0.5) signals.push("固有名詞・制度名アンカーが重なる");
  if (input.bodyScore >= 0.24) signals.push("リード文の語彙が近い");
  if (input.dateBonus >= 8) signals.push("掲載日が一致");
  else if (input.dateBonus >= 3) signals.push("掲載日が近い");
  if (input.rankBonus >= 4) signals.push("人民網検索の上位候補");
  if (!input.cn.body || input.cn.body.length < 80) signals.push("CN本文が短く判定材料が弱い");
  return signals;
}

function buildRuleReason(
  status: JpMajorMatchStatus,
  signals: string[],
  matchScore: number
) {
  const prefix =
    status === "MATCHED"
      ? "ルール判定で同一話題候補です"
      : status === "CANDIDATE"
        ? "ルール判定では要確認候補です"
        : "ルール判定では同一話題の根拠が弱い候補です";
  const detail = signals.length ? signals.slice(0, 4).join("、") : "強い共有アンカーなし";
  return `${prefix}（score=${matchScore}）。根拠: ${detail}。`;
}

function statusFromScore(score: number, aiSameTopic = false): JpMajorMatchStatus {
  if (score >= (aiSameTopic ? 55 : 68)) return "MATCHED";
  if (score >= 42) return "CANDIDATE";
  return "NO_MATCH";
}

function compareScoredCandidates(
  left: JpMajorScoredCandidate,
  right: JpMajorScoredCandidate
) {
  return (
    right.match_score - left.match_score ||
    left.search.bestRank - right.search.bestRank ||
    right.article.body.length - left.article.body.length
  );
}

function searchCandidateRank(candidate: JpMajorSearchCandidate) {
  const dateScore = candidate.urlDate ? -1 : 0;
  return candidate.bestSearchRank + dateScore - Math.min(candidate.queries.length, 4) * 0.2;
}

function specializedSearchQueries(input: string) {
  const text = replaceForChineseSearch(input);
  const queries: string[] = [];
  const foreignMinisterTalk = text.match(
    /(王毅|习近平|李强|赵乐际|韩正|王沪宁).*?([\p{Script=Han}A-Za-z・]+)(外长|总统|总理|首相).*?(会谈|会见)/u
  );
  if (foreignMinisterTalk) {
    queries.push(`${foreignMinisterTalk[1]}同${foreignMinisterTalk[2]}${foreignMinisterTalk[3]}${foreignMinisterTalk[4]}`);
  }

  const visit = text.match(/([\p{Script=Han}A-Za-z・]+)(外长|总统|总理|首相).*?(将访华|访华|访问中国)/u);
  if (visit) queries.push(`${visit[1]}${visit[2]}将访华`);

  const spokesperson = text.match(/(外交部|国台办).*?(回应|评论|答记者问).*?([\p{Script=Han}A-Za-z0-9]{2,18})/u);
  if (spokesperson) queries.push(`${spokesperson[1]}${spokesperson[2]}${spokesperson[3]}`);

  return queries;
}

function verifiedSearchQueries(input: string) {
  const normalized = replaceForChineseSearch(input);
  return VERIFIED_PEOPLE_SEARCH_QUERY_ALIASES
    .filter(({ pattern }) => pattern.test(normalized) || pattern.test(input))
    .map(({ query }) => query);
}

function normalizeChineseSearchQuery(input: string) {
  const tokens = specificSearchTokens(input);
  const compact = normalizeForChineseSimilarity(replaceForChineseSearch(input))
    .replace(/[「」『』“”"'（）()\[\]【】]/g, "")
    .replace(/氏/g, "")
    .replace(/[がのをにはへでと、。・\s　]/g, "")
    .replace(/について|に関する|めぐり|巡り|として/g, "")
    .trim();

  if (compact.length <= 48 && compact.length >= 8) return compact;
  return tokens.slice(0, 5).join("");
}

function normalizeForChineseSimilarity(input: string) {
  return replaceForChineseSearch(input)
    .normalize("NFKC")
    .replace(/人民網|人民网|日本語版|写真|動画|速報|詳報|ニュース/g, "")
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}ー]+/gu, "")
    .trim();
}

function specificSearchTokens(input: string) {
  const normalized = replaceForChineseSearch(input).normalize("NFKC");
  const chunks =
    normalized.match(/[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9ー・]{1,20}/gu) ??
    [];
  const weak = new Set([
    "中国",
    "日本",
    "人民",
    "人民网",
    "人民日報",
    "报道",
    "表示",
    "指出",
    "相关",
    "国际",
    "社会",
    "经济",
    "政治",
    "文化",
    "記事",
    "日文",
    "中国語"
  ]);

  return [...new Set(chunks.map(cleanSearchToken).filter(Boolean))]
    .filter((token) => !weak.has(token))
    .filter((token) => token.length >= 2 && token.length <= 18)
    .slice(0, 12);
}

function cleanSearchToken(input: string) {
  return input
    .replace(/[ー・]+/g, "")
    .replace(/^[0-9]+$/, "")
    .replace(/^(する|した|された|における|について|として|から|まで)/, "")
    .replace(/(する|した|された|について|として|など|めぐり|巡り)$/, "")
    .trim();
}

function combineSearchTokens(tokens: string[]) {
  const queries: string[] = [];
  for (let size = Math.min(4, tokens.length); size >= 2; size -= 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      queries.push(tokens.slice(index, index + size).join(""));
      if (queries.length >= 8) return queries;
    }
  }
  return queries;
}

function isUsefulPeopleSearchQuery(query: string) {
  return (
    (query.length >= 6 || VERIFIED_SHORT_PEOPLE_SEARCH_QUERIES.has(query)) &&
    query.length <= 52 &&
    /[\p{Script=Han}]/u.test(query) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)
  );
}

function queryQualityScore(query: string) {
  let score = Math.min(query.length, 30);
  if (
    VERIFIED_SHORT_PEOPLE_SEARCH_QUERIES.has(query) ||
    VERIFIED_PEOPLE_SEARCH_QUERY_ALIASES.some((alias) => alias.query === query)
  ) {
    score += 12;
  }
  if (/习近平|王毅|李强|赵乐际|外交部|国台办|台湾|美国|伊朗|外长|会谈|访华/.test(query)) {
    score += 8;
  }
  if (query.length < 8 || query.length > 42) score -= 4;
  return score;
}

function replaceForChineseSearch(input: string) {
  const replacements: Array<[RegExp, string]> = [
    [/習近平/g, "习近平"],
    [/李強/g, "李强"],
    [/趙楽際/g, "赵乐际"],
    [/王滬寧/g, "王沪宁"],
    [/韓正/g, "韩正"],
    [/人民日報/g, "人民日报"],
    [/人民網/g, "人民网"],
    [/国務院/g, "国务院"],
    [/外交部|外務省/g, "外交部"],
    [/報道官|スポークスマン/g, "发言人"],
    [/外相|外務大臣/g, "外长"],
    [/首相/g, "总理"],
    [/大統領/g, "总统"],
    [/会談|会見/g, "会谈"],
    [/訪中へ|訪中予定|訪中する|訪中|中国訪問|中国を訪問/g, "将访华"],
    [/台湾/g, "台湾"],
    [/頼清徳/g, "赖清德"],
    [/台独|台湾独立/g, "台独"],
    [/米国|アメリカ/g, "美国"],
    [/キューバ/g, "古巴"],
    [/イラン/g, "伊朗"],
    [/アラグチ/g, "阿拉格齐"],
    [/ホルムズ海峡/g, "霍尔木兹海峡"],
    [/イスラエル/g, "以色列"],
    [/パレスチナ/g, "巴勒斯坦"],
    [/ロシア/g, "俄罗斯"],
    [/ウクライナ/g, "乌克兰"],
    [/フランス/g, "法国"],
    [/ドイツ/g, "德国"],
    [/英国|イギリス/g, "英国"],
    [/韓国/g, "韩国"],
    [/朝鮮/g, "朝鲜"],
    [/ベトナム/g, "越南"],
    [/タイ/g, "泰国"],
    [/インド/g, "印度"],
    [/パキスタン/g, "巴基斯坦"],
    [/ブラジル/g, "巴西"],
    [/南アフリカ/g, "南非"],
    [/国連/g, "联合国"],
    [/制裁/g, "制裁"],
    [/コメント|論評/g, "回应"],
    [/発表/g, "发布"],
    [/強調/g, "强调"],
    [/批判/g, "批评"],
    [/反対/g, "反对"],
    [/支持/g, "支持"],
    [/村山談話/g, "村山谈话"],
    [/歴史を鑑とし|歴史を鑑/g, "以史为镜"],
    [/時代的価値/g, "时代价值"],
    [/右翼勢力/g, "右翼势力"],
    [/再軍事化/g, "再军事化"],
    [/殺傷性武器|殺傷兵器/g, "杀伤性武器"],
    [/武器輸出/g, "武器出口"],
    [/輸出解禁|解禁/g, "放开"],
    [/円安|日本円安|円の下落/g, "日元贬值"],
    [/持続的|持続/g, "持续"],
    [/深層レベル|深層/g, "深层"],
    [/映し出す|反映する|示す/g, "折射"],
    [/苦境/g, "困境"],
    [/人型ロボット|ヒューマノイド/g, "人形机器人"],
    [/東京裁判/g, "东京审判"],
    [/鉄証如山/g, "铁证如山"],
    [/攻撃型ミサイル|導弾/g, "进攻型导弹"],
    [/広州交易会/g, "广交会"],
    [/海外バイヤー/g, "境外采购商"],
    [/労働節/g, "劳动节"],
    [/アリペイ/g, "支付宝"],
    [/科学調査船/g, "科学调查船"],
    [/長江/g, "长江"],
    [/スヌーカー/g, "斯诺克"],
    [/世界選手権/g, "世锦赛"],
    [/優勝/g, "夺冠"]
  ];

  const phraseNormalized = replacements.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    input
  );
  return simplifyCommonJapaneseKanji(phraseNormalized);
}

function simplifyCommonJapaneseKanji(input: string) {
  const map: Record<string, string> = {
    亞: "亚",
    悪: "恶",
    壓: "压",
    圧: "压",
    為: "为",
    醫: "医",
    隱: "隐",
    隠: "隐",
    營: "营",
    営: "营",
    衛: "卫",
    驛: "驿",
    駅: "驿",
    園: "园",
    遠: "远",
    應: "应",
    応: "应",
    櫻: "樱",
    桜: "樱",
    歐: "欧",
    殴: "殴",
    價: "价",
    価: "价",
    會: "会",
    繪: "绘",
    絵: "绘",
    擴: "扩",
    拡: "扩",
    學: "学",
    覺: "觉",
    覚: "觉",
    觀: "观",
    観: "观",
    關: "关",
    関: "关",
    歸: "归",
    氣: "气",
    犧: "牺",
    犠: "牺",
    據: "据",
    拠: "据",
    擧: "举",
    挙: "举",
    峽: "峡",
    狹: "狭",
    狭: "狭",
    區: "区",
    駆: "驱",
    勳: "勋",
    勲: "勋",
    經: "经",
    経: "经",
    繼: "继",
    継: "继",
    輕: "轻",
    軽: "轻",
    藝: "艺",
    芸: "艺",
    撃: "击",
    縣: "县",
    県: "县",
    儉: "俭",
    検: "检",
    權: "权",
    権: "权",
    嚴: "严",
    厳: "严",
    廣: "广",
    広: "广",
    國: "国",
    黑: "黑",
    齋: "斋",
    剤: "剂",
    濟: "济",
    済: "济",
    雜: "杂",
    參: "参",
    産: "产",
    絲: "丝",
    師: "师",
    資: "资",
    兒: "儿",
    実: "实",
    釋: "释",
    釈: "释",
    從: "从",
    従: "从",
    縱: "纵",
    獸: "兽",
    獣: "兽",
    術: "术",
    述: "述",
    將: "将",
    渉: "涉",
    燒: "烧",
    焼: "烧",
    奬: "奖",
    奨: "奖",
    條: "条",
    狀: "状",
    乗: "乘",
    淨: "净",
    準: "准",
    處: "处",
    処: "处",
    觸: "触",
    触: "触",
    寢: "寝",
    愼: "慎",
    眞: "真",
    圖: "图",
    図: "图",
    髓: "髓",
    隨: "随",
    随: "随",
    數: "数",
    樞: "枢",
    瀨: "濑",
    瀬: "濑",
    聲: "声",
    靜: "静",
    稅: "税",
    積: "积",
    績: "绩",
    責: "责",
    戰: "战",
    戦: "战",
    纖: "纤",
    鮮: "鲜",
    騷: "骚",
    增: "增",
    續: "续",
    続: "续",
    對: "对",
    対: "对",
    臺: "台",
    瀧: "泷",
    竜: "龙",
    單: "单",
    単: "单",
    團: "团",
    団: "团",
    彈: "弹",
    弾: "弹",
    遲: "迟",
    達: "达",
    斷: "断",
    断: "断",
    癡: "痴",
    蟲: "虫",
    晝: "昼",
    鑄: "铸",
    廳: "厅",
    聴: "听",
    鎭: "镇",
    轉: "转",
    伝: "传",
    點: "点",
    黨: "党",
    盜: "盗",
    稻: "稻",
    鬪: "斗",
    闘: "斗",
    獨: "独",
    独: "独",
    讀: "读",
    読: "读",
    屆: "届",
    届: "届",
    貳: "贰",
    腦: "脑",
    覇: "霸",
    廢: "废",
    発: "发",
    髮: "发",
    拜: "拜",
    賣: "卖",
    麥: "麦",
    萬: "万",
    滿: "满",
    満: "满",
    譯: "译",
    訳: "译",
    藥: "药",
    薬: "药",
    與: "与",
    豫: "预",
    餘: "余",
    予: "予",
    譽: "誉",
    輿: "舆",
    搖: "摇",
    様: "样",
    樣: "样",
    來: "来",
    頼: "赖",
    覽: "览",
    覧: "览",
    龍: "龙",
    壘: "垒",
    類: "类",
    勞: "劳",
    労: "劳",
    樂: "乐",
    楽: "乐"
  };

  return Array.from(input)
    .map((char) => map[char] ?? char)
    .join("");
}

function cleanTitle(input: string) {
  return cleanText(input)
    .replace(/--.*$/, "")
    .replace(/（.*?）/g, "")
    .replace(/\s+-\s+人民网.*$/, "")
    .replace(/\s+-\s+人民網.*$/, "")
    .replace(/^\[.*?\]/, "")
    .trim();
}

function stripInlineHtml(input: string) {
  return input.replace(/<[^>]*>/g, "");
}

function peopleSearchTime(input: number | undefined) {
  if (!input || !Number.isFinite(input)) return undefined;
  return new Date(input).toISOString().slice(0, 10);
}

function extractDateFromUrl(url: string) {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }

  const match = path.match(/\/n\d\/(\d{4})\/(\d{4})\//);
  if (!match) return undefined;

  const year = match[1];
  const month = match[2].slice(0, 2);
  const day = match[2].slice(2);
  return `${year}-${month}-${day}`;
}

function normalizePublishedDate(input: string | undefined) {
  if (!input) return undefined;
  const normalized = input.normalize("NFKC");
  const match =
    normalized.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/) ??
    normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) ??
    normalized.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);

  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function normalizeDateScope(dates: string[] | undefined) {
  return [...new Set((dates ?? []).map(normalizeDateInput).filter(Boolean))] as string[];
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

function cachedArticle(url: string) {
  return articleCache().get(url);
}

function rememberArticle(article: Article) {
  const cache = articleCache();
  if (cache.has(article.url)) cache.delete(article.url);
  cache.set(article.url, article);

  while (cache.size > ARTICLE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }

  return article;
}

function articleCache() {
  globalThis.__PEOPLEDIFF_JP_MAJOR_ARTICLE_CACHE__ ??= new Map<string, Article>();
  return globalThis.__PEOPLEDIFF_JP_MAJOR_ARTICLE_CACHE__;
}

function scrapeConcurrency(configured: number | undefined) {
  if (!configured || !Number.isFinite(configured) || configured <= 0) return 12;
  return Math.min(24, Math.max(2, Math.round(configured)));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  );
  return results;
}

function emptyResult(
  jp: Article,
  queries: string[],
  warnings: string[],
  reason: string
): JpMajorMatcherResult {
  return {
    jp,
    queries,
    candidates: [],
    match_score: 0,
    match_reason: reason,
    status: "NO_MATCH",
    warnings: trimWarnings(warnings)
  };
}

function clampScore(input: number) {
  if (!Number.isFinite(input)) return 0;
  return Math.min(100, Math.max(0, Math.round(input)));
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause;
  if (isNodeError(cause) && cause.code) {
    return `${error.message}: ${cause.code}`;
  }

  return error.message;
}

function isTlsCertificateError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  if (isNodeError(cause)) {
    return (
      cause.code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
      cause.code === "CERT_HAS_EXPIRED" ||
      cause.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    );
  }

  return /certificate|cert|altname|TLS/i.test(error.message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function trimWarnings(warnings: string[]) {
  return [...new Set(warnings)].slice(0, 8);
}
