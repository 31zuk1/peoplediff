import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Article, Source } from "./types";
import { cleanText, compactSummary, extractKeywords, stableId, truncate } from "./text";

const CN_HOME = "https://www.people.com.cn/";
const JP_HOME = "http://j.people.com.cn/";
const JP_ALL_ARTICLES = "http://j.people.com.cn/94765/index.html";
const USER_AGENT =
  "PeopleDiff/0.1 (+https://vercel.app; research dashboard; contact: local-poc)";

type Candidate = {
  title: string;
  url: string;
  urlDate?: string;
  listPublishedAt?: string;
  listDate?: string;
  discoveredFrom?: string;
  category?: string;
};

type ScrapeOptions = {
  limit?: number;
  dates?: string[];
  maxPages?: number;
  maxArticles?: number;
};

export async function scrapePeople(source: Source, options: ScrapeOptions = {}) {
  const limit = options.limit ?? 10;
  const dateScope = normalizeDateScope(options.dates);
  const candidates = dateScope.length
    ? await collectDailyCandidates(source, dateScope, {
        maxPages: options.maxPages ?? (source === "CN" ? 5 : 8)
      })
    : await collectHomeCandidates(source, limit);
  const selectedCandidates = candidates.slice(
    0,
    dateScope.length ? (options.maxArticles ?? 160) : limit
  );
  const articles: Article[] = [];
  const seen = new Set<string>();
  const seenTitles = new Set<string>();

  const scraped = await mapWithConcurrency(selectedCandidates, 8, async (candidate) => {
    const titleKey = cleanTitle(candidate.title);
    if (seen.has(candidate.url) || seenTitles.has(titleKey)) return undefined;
    seen.add(candidate.url);

    try {
      const article = await scrapeArticle(candidate, source);
      const articleTitleKey = cleanTitle(article.title);
      if (
        article.title &&
        (dateScope.length > 0 || article.body.length > 80) &&
        !seenTitles.has(articleTitleKey || titleKey)
      ) {
        seenTitles.add(articleTitleKey || titleKey);
        return article;
      }
    } catch {
      seenTitles.add(titleKey);
      return {
        id: stableId(candidate.url),
        source,
        title: candidate.title,
        url: candidate.url,
        urlDate: candidate.urlDate,
        publishedAt: candidate.listPublishedAt,
        publishedDate: candidate.listDate,
        discoveredFrom: candidate.discoveredFrom,
        category: candidate.category,
        body: "",
        summary: "本文取得に失敗しました。",
        keywords: extractKeywords(candidate.title)
      } satisfies Article;
    }
    return undefined;
  });

  for (const article of scraped) {
    if (article) articles.push(article);
  }

  return articles;
}

async function scrapeArticle(candidate: Candidate, source: Source): Promise<Article> {
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

async function collectHomeCandidates(source: Source, limit: number) {
  const homeUrl = source === "CN" ? CN_HOME : JP_HOME;
  const html = await fetchDecodedHtml(homeUrl);
  const $ = cheerio.load(html);
  return collectCandidates($, homeUrl, source, homeUrl).slice(0, Math.max(limit * 2, limit));
}

async function collectDailyCandidates(
  source: Source,
  dateScope: string[],
  options: { maxPages: number }
) {
  const candidates = new Map<string, Candidate>();
  const pages =
    source === "CN"
      ? cnDailySourcePages(options.maxPages)
      : jpDailySourcePages(options.maxPages);
  const earliest = dateScope.slice().sort()[0];

  for (const pageUrl of pages) {
    try {
      const html = await fetchDecodedHtml(pageUrl);
      const $ = cheerio.load(html);
      const pageCandidates =
        source === "JP" && pageUrl.includes("/94765/")
          ? collectJapaneseListingCandidates($, pageUrl)
          : collectCandidates($, pageUrl, source, pageUrl);

      for (const candidate of pageCandidates) {
        const date = candidate.urlDate || candidate.listDate;
        if (!dateScope.includes(date ?? "")) continue;
        if (!candidates.has(candidate.url)) candidates.set(candidate.url, candidate);
      }

      if (source === "JP") {
        const dates = pageCandidates
          .map((candidate) => candidate.listDate || candidate.urlDate)
          .filter(Boolean)
          .sort();
        const newestOnPage = dates.at(-1);
        if (newestOnPage && newestOnPage < earliest) break;
      }
    } catch {
      continue;
    }
  }

  return [...candidates.values()].sort((a, b) => scoreCandidate(b, source) - scoreCandidate(a, source));
}

function collectCandidates(
  $: cheerio.CheerioAPI,
  homeUrl: string,
  source: Source,
  discoveredFrom = homeUrl
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("a").each((_, element) => {
    const anchor = $(element);
    const rawHref = anchor.attr("href");
    const title = cleanTitle(anchor.text() || anchor.attr("title") || "");
    const url = normalizeUrl(rawHref, homeUrl);

    if (!url || !title || title.length < (source === "CN" ? 6 : 5)) return;
    if (!isLikelyArticleUrl(url, source)) return;
    if (seen.has(url)) return;

    seen.add(url);
    candidates.push({
      title,
      url,
      urlDate: extractDateFromUrl(url),
      discoveredFrom,
      category: inferCategory(url, title)
    });
  });

  return candidates.sort((a, b) => scoreCandidate(b, source) - scoreCandidate(a, source));
}

function collectJapaneseListingCandidates($: cheerio.CheerioAPI, pageUrl: string): Candidate[] {
  const candidates = $(".list")
    .map((_, element) => {
      const row = $(element);
      const anchor = row.find("h3 a").first();
      const title = cleanTitle(anchor.text());
      const url = normalizeUrl(anchor.attr("href"), pageUrl);
      const listPublishedAt = cleanText(row.find(".time").first().text());

      if (!url || !title || !isLikelyArticleUrl(url, "JP")) return undefined;

      return {
        title,
        url,
        urlDate: extractDateFromUrl(url),
        listPublishedAt,
        listDate: normalizePublishedDate(listPublishedAt),
        discoveredFrom: pageUrl,
        category: inferCategory(url, title)
      } satisfies Candidate;
    })
    .get()
    .filter(Boolean) as Candidate[];

  return candidates.sort((a, b) => scoreCandidate(b, "JP") - scoreCandidate(a, "JP"));
}

function cnDailySourcePages(maxPages: number) {
  const bases = [
    CN_HOME,
    "http://politics.people.com.cn/GB/1024/index.html",
    "http://finance.people.com.cn/GB/70846/index.html",
    "http://society.people.com.cn/GB/136657/index.html",
    "http://world.people.com.cn/GB/157278/index.html",
    "http://military.people.com.cn/index.html",
    "http://tw.people.com.cn/GB/index.html",
    "http://ent.people.com.cn/GB/436801/index.html",
    "http://health.people.com.cn/GB/415859/index.html"
  ];

  return bases.flatMap((base) => expandIndexPages(base, base === CN_HOME ? 1 : maxPages));
}

function jpDailySourcePages(maxPages: number) {
  return expandIndexPages(JP_ALL_ARTICLES, maxPages);
}

function expandIndexPages(base: string, maxPages: number) {
  const pages = [base];
  for (let page = 2; page <= maxPages; page += 1) {
    pages.push(base.replace(/index\.html$/, `index${page}.html`));
  }
  return pages;
}

async function fetchDecodedHtml(url: string) {
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

function normalizeUrl(rawHref: string | undefined, base: string) {
  if (!rawHref || /^javascript:|^mailto:|^tel:/i.test(rawHref)) return undefined;
  try {
    const url = new URL(rawHref, base);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isLikelyArticleUrl(url: string, source: Source) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname;

  if (!path.endsWith(".html")) return false;
  if (source === "JP") {
    return host === "j.people.com.cn" && /\/n\d\/\d{4}\/\d{4}\//.test(path);
  }

  if (!host.endsWith("people.com.cn") || host === "j.people.com.cn") return false;
  if (/pic|photo|video|tv|fangtan/i.test(host + path)) return false;
  return /\/n\d\/\d{4}\/\d{4}\//.test(path) || /\/GB\/.+\.html$/.test(path);
}

function scoreCandidate(candidate: Candidate, source: Source) {
  let score = candidate.title.length;
  const dateScore = dateScoreFromUrl(candidate.url);
  if (dateScore) score += 1000 + dateScore;
  if (/\/n\d\/\d{4}\/\d{4}\//.test(new URL(candidate.url).pathname)) score += 40;
  if (candidate.category) score += 10;
  if (source === "CN" && candidate.url.startsWith("https://")) score += 2;
  return score;
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
      .filter((line) => line.length > 20);
    const body = cleanText(paragraphs.join("\n\n"));
    if (body.length > 120) return body;
  }

  const fallback = $("p")
    .map((_, p) => cleanText($(p).text()))
    .get()
    .filter((line) => line.length > 24)
    .join("\n\n");

  return cleanText(fallback);
}

function extractCategory($: cheerio.CheerioAPI, url: string, fallback?: string) {
  const pathCategory = inferCategoryFromPath(url);
  if (pathCategory) return pathCategory;

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

  return breadcrumb || inferCategory(url, "") || fallback;
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

function inferCategoryFromPath(url: string) {
  const { hostname, pathname } = new URL(url);
  if (hostname === "j.people.com.cn") {
    const code = pathname.match(/\/(c\d+)-/)?.[1];
    const jpMap: Record<string, string> = {
      c94474: "政治",
      c94475: "社会",
      c94476: "経済",
      c94477: "国際",
      c94638: "科学技術",
      c95952: "社会"
    };
    if (code && jpMap[code]) return jpMap[code];
  }

  return undefined;
}

function dateScoreFromUrl(url: string) {
  const date = extractDateFromUrl(url);
  if (!date) return 0;

  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return 0;

  return year * 400 + month * 32 + day;
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
