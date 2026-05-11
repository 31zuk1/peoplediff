import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Article } from "./types";
import { cleanText, compactSummary, extractKeywords, stableId, truncate } from "./text";

export const JP_MAJOR_NEWS_URL = "https://j.people.com.cn/95958/index.html";
const USER_AGENT =
  "PeopleDiff/0.1 (+https://vercel.app; research dashboard; contact: local-poc)";
const DEFAULT_MAX_LIST_PAGES = 5;
const DEFAULT_ARTICLE_CONCURRENCY = 8;
const DEFAULT_FETCH_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ARTICLE_PAGES = 6;

export type JpMajorScrapeOptions = {
  dates?: string[];
  limit?: number;
  maxArticles?: number;
  maxPages?: number;
  articleConcurrency?: number;
  fetchTimeoutMs?: number;
  maxArticlePages?: number;
  startUrl?: string;
};

export type PeopleArticleScrapeOptions = Pick<
  JpMajorScrapeOptions,
  "fetchTimeoutMs" | "maxArticlePages" | "startUrl"
> & {
  source?: PeopleArticleSource;
  title?: string;
  discoveredFrom?: string;
  listPublishedAt?: string;
  listDate?: string;
  category?: string;
};

export type JpMajorScrapeResult = {
  articles: Article[];
  warnings: string[];
  candidateCount: number;
  pagesVisited: string[];
};

type Candidate = {
  title: string;
  url: string;
  urlDate?: string;
  listPublishedAt?: string;
  listDate?: string;
  discoveredFrom: string;
  category?: string;
};

type PeopleArticleSource = Extract<Article["source"], "CN" | "JP">;

export async function scrapeJapaneseMajorNews(
  options: JpMajorScrapeOptions = {}
): Promise<JpMajorScrapeResult> {
  return scrapeJapaneseMajorNewsDetailed(options);
}

export async function scrapeJapaneseMajorNewsArticles(
  options: JpMajorScrapeOptions = {}
): Promise<Article[]> {
  return (await scrapeJapaneseMajorNewsDetailed(options)).articles;
}

export async function scrapeJapaneseMajorNewsDetailed(
  options: JpMajorScrapeOptions = {}
): Promise<JpMajorScrapeResult> {
  const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_LIST_PAGES);
  const limit = positiveInteger(options.limit ?? options.maxArticles, maxPages * 20);
  const articleConcurrency = positiveInteger(
    options.articleConcurrency,
    DEFAULT_ARTICLE_CONCURRENCY
  );
  const dateScope = normalizeDateScope(options.dates);
  const collection = await collectMajorNewsCandidates(options.startUrl ?? JP_MAJOR_NEWS_URL, {
    ...options,
    maxPages
  });
  const warnings = [...collection.warnings];
  const selectedCandidates = collection.candidates
    .filter((candidate) => {
      if (!dateScope.length) return true;
      const date = candidate.urlDate || candidate.listDate;
      return dateScope.includes(date ?? "");
    })
    .slice(0, limit);
  const seenTitles = new Set<string>();

  const scraped = await mapWithConcurrency(
    selectedCandidates,
    articleConcurrency,
    async (candidate) => {
      const titleKey = cleanTitle(candidate.title);
      if (seenTitles.has(titleKey)) return undefined;
      seenTitles.add(titleKey);

      try {
        return await scrapeJapaneseMajorNewsArticle(candidate, options);
      } catch (error) {
        warnings.push(`JP主要ニュース本文取得失敗: ${candidate.title} (${errorMessage(error)})`);
        return fallbackArticle(candidate);
      }
    }
  );

  return {
    articles: scraped.filter((article): article is Article => Boolean(article)),
    warnings: trimWarnings(warnings),
    candidateCount: collection.candidates.length,
    pagesVisited: collection.pagesVisited
  };
}

export async function scrapePeopleArticleFromUrl(
  url: string,
  options?: PeopleArticleScrapeOptions
): Promise<Article>;
export async function scrapePeopleArticleFromUrl(
  url: string,
  source: PeopleArticleSource,
  options?: PeopleArticleScrapeOptions
): Promise<Article>;
export async function scrapePeopleArticleFromUrl(
  url: string,
  sourceOrOptions: PeopleArticleSource | PeopleArticleScrapeOptions = {},
  maybeOptions: PeopleArticleScrapeOptions = {}
): Promise<Article> {
  const options =
    typeof sourceOrOptions === "string" ? maybeOptions : sourceOrOptions;
  const requestedSource = typeof sourceOrOptions === "string" ? sourceOrOptions : options.source;
  const normalizedUrl = normalizeUrl(url, options.startUrl ?? JP_MAJOR_NEWS_URL);
  const source = requestedSource ?? inferArticleSource(normalizedUrl);

  if (!normalizedUrl || !source || !isLikelyPeopleArticleUrl(normalizedUrl, source)) {
    throw new Error(`People記事URLではありません: ${url}`);
  }

  return scrapePeopleArticle(
    {
      title: options.title ?? "",
      url: normalizedUrl,
      urlDate: extractDateFromUrl(normalizedUrl),
      listPublishedAt: options.listPublishedAt,
      listDate: options.listDate,
      discoveredFrom: options.discoveredFrom ?? options.startUrl ?? JP_MAJOR_NEWS_URL,
      category: options.category ?? inferCategory(normalizedUrl, "")
    },
    source,
    options
  );
}

async function collectMajorNewsCandidates(
  startUrl: string,
  options: JpMajorScrapeOptions & { maxPages: number }
) {
  const candidates = new Map<string, Candidate>();
  const warnings: string[] = [];
  const pagesVisited: string[] = [];
  const pageQueue = [normalizeMajorListingUrl(startUrl) ?? JP_MAJOR_NEWS_URL];
  const queuedPages = new Set(pageQueue);
  const timeoutMs = positiveInteger(options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);

  for (let index = 0; index < pageQueue.length && pagesVisited.length < options.maxPages; index += 1) {
    const pageUrl = pageQueue[index];

    try {
      const html = await fetchDecodedHtml(pageUrl, timeoutMs);
      const $ = cheerio.load(html);
      pagesVisited.push(pageUrl);

      for (const candidate of collectCandidates($, pageUrl)) {
        if (!candidates.has(candidate.url)) candidates.set(candidate.url, candidate);
      }

      for (const nextPage of collectPaginationUrls($, pageUrl)) {
        if (queuedPages.has(nextPage) || queuedPages.size >= options.maxPages) continue;
        queuedPages.add(nextPage);
        pageQueue.push(nextPage);
      }
    } catch (error) {
      warnings.push(`JP主要ニュース一覧取得失敗: ${pageUrl} (${errorMessage(error)})`);
    }
  }

  return {
    candidates: [...candidates.values()],
    warnings: trimWarnings(warnings),
    pagesVisited
  };
}

function collectCandidates($: cheerio.CheerioAPI, pageUrl: string) {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $(".j-d2tuwen .left .list").each((_, element) => {
    const row = $(element);
    const anchor = row.find("h3 a").first();
    const title = cleanTitle(anchor.text() || anchor.attr("title") || "");
    const url = normalizeUrl(anchor.attr("href"), pageUrl);
    const listPublishedAt = cleanText(row.find(".time").first().text());

    if (!url || !title || title.length < 5) return;
    if (!isLikelyJapaneseArticleUrl(url) || seen.has(url)) return;

    seen.add(url);
    candidates.push({
      title,
      url,
      urlDate: extractDateFromUrl(url),
      listPublishedAt,
      listDate: normalizePublishedDate(listPublishedAt),
      discoveredFrom: pageUrl,
      category: inferCategory(url, title)
    });
  });

  return candidates;
}

function collectPaginationUrls($: cheerio.CheerioAPI, pageUrl: string) {
  const urls = new Set<string>();

  $(".j-d2tuwen .left .pages a[href]").each((_, element) => {
    const url = normalizeMajorListingUrl(normalizeUrl($(element).attr("href"), pageUrl));
    if (url) urls.add(url);
  });

  return [...urls].sort((a, b) => listingPageNumber(a) - listingPageNumber(b));
}

async function scrapeJapaneseMajorNewsArticle(
  candidate: Candidate,
  options: JpMajorScrapeOptions
): Promise<Article> {
  return scrapePeopleArticle(candidate, "JP", options);
}

async function scrapePeopleArticle(
  candidate: Candidate,
  source: PeopleArticleSource,
  options: JpMajorScrapeOptions | PeopleArticleScrapeOptions
): Promise<Article> {
  const timeoutMs = positiveInteger(options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
  const maxArticlePages = positiveInteger(options.maxArticlePages, DEFAULT_MAX_ARTICLE_PAGES);
  const html = await fetchDecodedHtml(candidate.url, timeoutMs);
  const $ = cheerio.load(html);

  removeNoise($);

  const title =
    firstCleanTitle([
      $("meta[property='og:title']").attr("content"),
      $("meta[name='title']").attr("content"),
      $("meta[name='twitter:title']").attr("content"),
      $("h1").first().text(),
      $("title").first().text(),
      candidate.title
    ]) || candidate.title;
  const pageBodies = [extractBody($)];
  const continuationPages = collectArticleContinuationUrls($, candidate.url).slice(
    0,
    Math.max(0, maxArticlePages - 1)
  );

  for (const pageUrl of continuationPages) {
    try {
      const pageHtml = await fetchDecodedHtml(pageUrl, timeoutMs);
      const page = cheerio.load(pageHtml);
      removeNoise(page);
      pageBodies.push(extractBody(page));
    } catch {
      // Keep the first page usable when an optional continuation page is unavailable.
    }
  }

  const body = uniqueParagraphs(pageBodies.join("\n\n"));
  const publishedAt = extractPublishedAt($) || candidate.listPublishedAt;
  const publishedDate = normalizePublishedDate(publishedAt) || candidate.listDate;
  const urlDate = candidate.urlDate || extractDateFromUrl(candidate.url);
  const category = extractCategory($, candidate.url, candidate.category);
  const sourceText = [title, category, body].filter(Boolean).join("\n");

  return {
    id: stableId(candidate.url),
    source,
    title,
    url: candidate.url,
    urlDate,
    publishedAt,
    publishedDate,
    dateMismatch: Boolean(urlDate && publishedDate && urlDate !== publishedDate),
    discoveredFrom: candidate.discoveredFrom,
    category,
    body: truncate(body, 8000),
    summary: compactSummary(body, source === "CN" ? 160 : 180),
    keywords: extractKeywords(sourceText)
  };
}

function fallbackArticle(candidate: Candidate): Article {
  const sourceText = [candidate.title, candidate.category].filter(Boolean).join("\n");

  return {
    id: stableId(candidate.url),
    source: "JP",
    title: candidate.title,
    url: candidate.url,
    urlDate: candidate.urlDate,
    publishedAt: candidate.listPublishedAt,
    publishedDate: candidate.listDate,
    discoveredFrom: candidate.discoveredFrom,
    category: candidate.category,
    body: "",
    summary: "本文取得に失敗しました。",
    keywords: extractKeywords(sourceText)
  };
}

function extractBody($: cheerio.CheerioAPI) {
  const selectors = [
    ".j-d2txt",
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
      .map((_, paragraph) => cleanText($(paragraph).text()))
      .get()
      .filter(isContentParagraph);
    const body = cleanText(paragraphs.join("\n\n"));
    if (body.length > 40) return body;
  }

  const fallback = $("p")
    .map((_, paragraph) => cleanText($(paragraph).text()))
    .get()
    .filter(isContentParagraph)
    .join("\n\n");

  return cleanText(fallback);
}

function collectArticleContinuationUrls($: cheerio.CheerioAPI, articleUrl: string) {
  const baseKey = articlePageKey(articleUrl);
  const urls = new Set<string>();

  $(".j-d2txt .pages a[href]").each((_, element) => {
    const url = normalizeUrl($(element).attr("href"), articleUrl);
    if (!url || url === articleUrl || articlePageKey(url) !== baseKey) return;
    urls.add(url);
  });

  return [...urls].sort((a, b) => articlePageNumber(a) - articlePageNumber(b));
}

function removeNoise($: cheerio.CheerioAPI) {
  $(
    "script, style, noscript, iframe, svg, form, nav, footer, .j-header, .j-nav, .j-bottom, .share"
  ).remove();
}

async function fetchDecodedHtml(url: string, timeoutMs: number) {
  const { buffer, contentType } = await fetchHtmlBuffer(url, timeoutMs);
  const sniff = buffer.subarray(0, 4096).toString("latin1");
  const charset =
    contentType.match(/charset=([^;]+)/i)?.[1] ??
    sniff.match(/charset=['\"]?([\w-]+)/i)?.[1] ??
    "utf-8";

  if (/gb2312|gbk|gb18030/i.test(charset)) {
    return iconv.decode(buffer, "gb18030");
  }

  return iconv.decode(buffer, "utf-8");
}

async function fetchHtmlBuffer(url: string, timeoutMs: number) {
  try {
    return await fetchHtmlBufferOnce(url, timeoutMs);
  } catch (error) {
    const fallbackUrl = httpFallbackUrl(url, error);
    if (!fallbackUrl) throw error;

    try {
      return await fetchHtmlBufferOnce(fallbackUrl, timeoutMs);
    } catch (fallbackError) {
      throw new Error(`${errorMessage(error)}; HTTP fallback failed: ${errorMessage(fallbackError)}`);
    }
  }
}

async function fetchHtmlBufferOnce(url: string, timeoutMs: number) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  return { buffer, contentType };
}

function normalizeUrl(rawHref: string | undefined, base: string) {
  if (!rawHref || /^javascript:|^mailto:|^tel:/i.test(rawHref.trim())) return undefined;
  try {
    const url = new URL(rawHref.trim().replace(/\s+/g, ""), base);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeMajorListingUrl(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "j.people.com.cn") return undefined;
    if (!/^\/95958\/index\d*\.html$/i.test(parsed.pathname)) return undefined;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function inferArticleSource(url: string | undefined): PeopleArticleSource | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    if (["j.people.com.cn", "j.peopledaily.com.cn"].includes(host)) return "JP";
    if (host.endsWith("people.com.cn") || host.endsWith("people.cn")) return "CN";
    return undefined;
  } catch {
    return undefined;
  }
}

function isLikelyPeopleArticleUrl(url: string, source: PeopleArticleSource) {
  return source === "JP" ? isLikelyJapaneseArticleUrl(url) : isLikelyChineseArticleUrl(url);
}

function isLikelyJapaneseArticleUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!["j.people.com.cn", "j.peopledaily.com.cn"].includes(parsed.hostname)) return false;
    return /\/n\d\/\d{4}\/\d{4}\/c\d+-\d+(?:_\d+)?\.html$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isLikelyChineseArticleUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname;

    if (!host.endsWith("people.com.cn") && !host.endsWith("people.cn")) return false;
    if (["j.people.com.cn", "j.peopledaily.com.cn"].includes(host)) return false;
    if (!path.endsWith(".html")) return false;
    if (/pic|photo|video|tv|fangtan/i.test(host + path)) return false;
    return /\/n\d\/\d{4}\/\d{4}\//.test(path) || /\/GB\/.+\.html$/i.test(path);
  } catch {
    return false;
  }
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

function firstCleanTitle(inputs: Array<string | undefined>) {
  return inputs.map((input) => cleanTitle(input ?? "")).find(Boolean) ?? "";
}

function isContentParagraph(line: string) {
  if (line.length < 10) return false;
  return !/人民日報社概況|人民網について|広告掲載|著作権|無断転載|Copyright|japan@people\.cn|京ICP备|京公网安备/i.test(
    line
  );
}

function extractCategory($: cheerio.CheerioAPI, url: string, fallback?: string) {
  const pathCategory = inferCategory(url, "");
  if (pathCategory) return pathCategory;

  const breadcrumb = $(".route a, .path a, .breadcrumb a, .crumb a")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .find(
      (text) =>
        text.length >= 2 &&
        text.length <= 14 &&
        !/人民網|ホーム|トップ|ニュース|日本語版/.test(text)
    );

  return breadcrumb || fallback || "人民日報の主要ニュース";
}

function extractPublishedAt($: cheerio.CheerioAPI) {
  const publishedDate = $("meta[name='publishdate']").attr("content");
  const originText = cleanText($(".origin").first().text());
  const bodyText = cleanText($("body").text());
  const dateTimeMatch =
    originText.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/) ??
    bodyText.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/);

  return (
    dateTimeMatch?.[0] ??
    publishedDate ??
    bodyText.match(/\d{4}年\d{1,2}月\d{1,2}日/)?.[0]
  );
}

function inferCategory(url: string, title: string) {
  const text = `${url} ${title}`.toLowerCase();
  const code = new URL(url).pathname.match(/\/(c\d+)-/)?.[1];
  const jpMap: Record<string, string> = {
    c94474: "政治",
    c94475: "社会",
    c94476: "経済",
    c94477: "国際",
    c94638: "写真",
    c95952: "科学技術",
    c206603: "カルチャー"
  };

  if (code && jpMap[code]) return jpMap[code];

  const pairs: Array<[RegExp, string]> = [
    [/政治|cpc|外交|首相|外相/, "政治"],
    [/world|国際|global|foreign/, "国際"],
    [/軍|防衛|ミサイル|自衛隊|安全保障/, "軍事"],
    [/台湾|台海/, "台湾"],
    [/finance|money|economy|経済|産業|貿易/, "経済"],
    [/society|社会|教育|健康|医療/, "社会"],
    [/culture|文化|観光|カルチャー/, "文化"],
    [/sports|体育|スポーツ/, "スポーツ"],
    [/tech|science|科学|科技|宇宙/, "科学技術"]
  ];

  return pairs.find(([pattern]) => pattern.test(text))?.[1];
}

function extractDateFromUrl(url: string) {
  const path = new URL(url).pathname;
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

function listingPageNumber(url: string) {
  const match = new URL(url).pathname.match(/index(\d*)\.html$/i);
  return match?.[1] ? Number(match[1]) : 1;
}

function articlePageKey(url: string) {
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/_\d+\.html$/i, ".html");
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

function articlePageNumber(url: string) {
  const match = new URL(url).pathname.match(/_(\d+)\.html$/i);
  return match ? Number(match[1]) : 1;
}

function uniqueParagraphs(input: string) {
  const seen = new Set<string>();
  const paragraphs = cleanText(input)
    .split(/\n{2,}/)
    .map(cleanText)
    .filter(Boolean)
    .filter((paragraph) => {
      if (seen.has(paragraph)) return false;
      seen.add(paragraph);
      return true;
    });

  return cleanText(paragraphs.join("\n\n"));
}

function positiveInteger(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.max(1, Math.round(value));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    })
  );

  return results;
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

function isTlsCertificateError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;

  if (isNodeError(cause)) {
    return (
      cause.code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
      cause.code === "CERT_HAS_EXPIRED" ||
      cause.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      cause.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      cause.code === "SELF_SIGNED_CERT_IN_CHAIN"
    );
  }

  return /certificate|cert|altname|SSL|TLS/i.test(error.message);
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause;
  if (isNodeError(cause) && cause.code) {
    return `${error.message}: ${cause.code}`;
  }

  return error.message;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function trimWarnings(warnings: string[]) {
  return warnings.slice(0, 20);
}
