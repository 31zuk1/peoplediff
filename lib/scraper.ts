import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Article, ScrapeCoverage, Source } from "./types";
import { getPeopleLanguageConfig, PEOPLE_LANGUAGE_CODES } from "./languages";
import { cleanText, compactSummary, extractKeywords, stableId, truncate } from "./text";

const USER_AGENT =
  "PeopleDiff/0.1 (+https://vercel.app; research dashboard; contact: local-poc)";
const ARTICLE_CACHE_LIMIT = 2500;

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

type PeopleSearchOptions = {
  dates?: string[];
  maxQueries?: number;
  maxResultsPerQuery?: number;
  maxArticles?: number;
};

type PeopleSearchRecord = {
  title?: string;
  url?: string;
  displayTime?: number;
  inputTime?: number;
  belongsName?: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_ARTICLE_CACHE__: Map<string, Article> | undefined;
}

export async function scrapePeople(source: Source, options: ScrapeOptions = {}) {
  return (await scrapePeopleDetailed(source, options)).articles;
}

export async function scrapePeopleDetailed(source: Source, options: ScrapeOptions = {}) {
  const language = getPeopleLanguageConfig(source);
  const limit = options.limit ?? 10;
  const dateScope = normalizeDateScope(options.dates);
  const dailyCollection = dateScope.length
    ? await collectDailyCandidates(source, dateScope, {
        maxPages: options.maxPages ?? language.defaultDailyMaxPages
      })
    : undefined;
  const warnings = [...(dailyCollection?.warnings ?? [])];
  if (dailyCollection && dailyCollection.attemptedPages > 0 && dailyCollection.successfulPages === 0) {
    throw new Error(
      `${language.warningLabel}の一覧ページを取得できませんでした: ${warnings.slice(0, 3).join(" / ")}`
    );
  }
  const candidates = dailyCollection?.candidates ?? (await collectHomeCandidates(source, limit));
  const selectedCandidates = dateScope.length
    ? selectDailyCandidates(candidates, dateScope, options.maxArticles ?? 160)
    : candidates.slice(0, limit);
  const articles: Article[] = [];
  const seen = new Set<string>();
  const seenTitles = new Set<string>();
  let bodyFailureCount = 0;
  const articleLimitReached = selectedCandidates.length < candidates.length;
  if (articleLimitReached && dateScope.length) {
    warnings.push(
      `${language.warningLabel}は記事数上限に達しました（候補${candidates.length}件中${selectedCandidates.length}件）。収集範囲は不完全です。`
    );
  }

  const scraped = await mapWithConcurrency(selectedCandidates, scrapeConcurrency(), async (candidate) => {
    const titleKey = cleanTitle(candidate.title);
    if (seen.has(candidate.url) || seenTitles.has(titleKey)) return undefined;
    seen.add(candidate.url);

    try {
      const article = await scrapeArticle(candidate, source);
      const articleTitleKey = cleanTitle(article.title);
      if (!article.body) {
        bodyFailureCount += 1;
        warnings.push(`${language.warningLabel}本文を抽出できませんでした: ${candidate.title}`);
      }
      if (
        article.title &&
        (dateScope.length > 0 || article.body.length > 80) &&
        !seenTitles.has(articleTitleKey || titleKey)
      ) {
        seenTitles.add(articleTitleKey || titleKey);
        return article;
      }
    } catch {
      bodyFailureCount += 1;
      seenTitles.add(titleKey);
      warnings.push(`${language.warningLabel}本文取得失敗: ${candidate.title}`);
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

  const datesWithArticles = [
    ...new Set(
      articles
        .map((article) => article.urlDate || article.publishedDate)
        .filter((date): date is string => Boolean(date))
    )
  ].sort();
  const collection: ScrapeCoverage = {
    attemptedPages: dailyCollection?.attemptedPages ?? 1,
    successfulPages: dailyCollection?.successfulPages ?? 1,
    failedPages: dailyCollection?.failedPages ?? 0,
    listingParseFailureCount: dailyCollection?.listingParseFailureCount ?? 0,
    candidateCount: candidates.length,
    selectedCount: selectedCandidates.length,
    articleCount: articles.length,
    bodyFailureCount,
    articleLimitReached: dateScope.length > 0 && articleLimitReached,
    pageLimitReached: dailyCollection?.pageLimitReached ?? false,
    earliestDiscoveredDate: dailyCollection?.earliestDiscoveredDate,
    latestDiscoveredDate: dailyCollection?.latestDiscoveredDate,
    requestedDates: dateScope,
    datesWithArticles,
    emptyDates: dateScope.filter((date) => !datesWithArticles.includes(date))
  };

  return { articles, warnings: trimWarnings(warnings), collection };
}

export async function searchPeopleChineseArticlesForTargets(
  targetArticles: Article[],
  options: PeopleSearchOptions = {}
) {
  const dateScope = normalizeDateScope(options.dates);
  const queries = [
    ...new Set(targetArticles.flatMap((article) => buildPeopleSearchQueries(article)))
  ].slice(0, options.maxQueries ?? 24);
  const warnings: string[] = [];
  if (!queries.length) return { articles: [] as Article[], warnings };

  const searched = await mapWithConcurrency(queries, 4, async (query) => {
    try {
      return await queryPeopleSearch(query, options.maxResultsPerQuery ?? 5);
    } catch (error) {
      warnings.push(`人民網検索取得失敗: ${query} (${errorMessage(error)})`);
      return [] as Candidate[];
    }
  });
  const candidates = searched
    .flat()
    .filter((candidate): candidate is Candidate => Boolean(candidate))
    .filter((candidate) => {
      const date = candidate.urlDate || candidate.listDate;
      return !dateScope.length || dateScope.includes(date ?? "");
    })
    .filter((candidate, index, all) => all.findIndex((item) => item.url === candidate.url) === index)
    .slice(0, options.maxArticles ?? 60);

  const scraped = await mapWithConcurrency(candidates, scrapeConcurrency(), async (candidate) => {
    try {
      return await scrapeArticle(candidate, "CN");
    } catch {
      warnings.push(`中国語版検索候補の本文取得失敗: ${candidate.title}`);
      return undefined;
    }
  });

  return {
    articles: scraped.filter((article): article is Article => Boolean(article)),
    warnings: trimWarnings(warnings)
  };
}

async function scrapeArticle(candidate: Candidate, source: Source): Promise<Article> {
  const cached = cachedArticle(source, candidate.url);
  if (cached) {
    return {
      ...cached,
      urlDate: cached.urlDate || candidate.urlDate,
      publishedAt: cached.publishedAt || candidate.listPublishedAt,
      publishedDate: cached.publishedDate || candidate.listDate,
      discoveredFrom: cached.discoveredFrom || candidate.discoveredFrom,
      category: cached.category || candidate.category
    };
  }

  const language = getPeopleLanguageConfig(source);
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
    summary: compactSummary(body, language.summaryLength),
    keywords: extractKeywords(sourceText)
  });
}

async function collectHomeCandidates(source: Source, limit: number) {
  const homeUrl = getPeopleLanguageConfig(source).homeUrl;
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
  const warnings: string[] = [];
  let attemptedPages = 0;
  let successfulPages = 0;
  let failedPages = 0;
  let listingParseFailureCount = 0;
  let pageLimitReached = false;
  const discoveredDates = new Set<string>();
  const language = getPeopleLanguageConfig(source);
  const initialPages =
    source === "CN"
      ? cnDailySourcePages(options.maxPages)
      : targetDailySourcePages(source, options.maxPages);
  const pages = [...initialPages];
  const queuedPages = new Set(pages);
  const linkedPages = new Set<string>();
  const earliest = dateScope.slice().sort()[0];
  const stoppedPageBases = new Set<string>();
  const stalePageCounts = new Map<string, number>();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageUrl = pages[pageIndex];
    const pageInfo = paginatedPageInfo(pageUrl);
    if (stoppedPageBases.has(pageInfo.baseUrl)) continue;

    attemptedPages += 1;
    try {
      const html = await fetchDecodedHtml(pageUrl);
      const $ = cheerio.load(html);
      successfulPages += 1;
      $("a").each((_, element) => {
        const linkedUrl = normalizeUrl($(element).attr("href"), pageUrl);
        if (linkedUrl && queuedPages.has(linkedUrl)) linkedPages.add(linkedUrl);
      });
      if (source !== "CN" && !language.allArticlesUrl && pageUrl === language.homeUrl) {
        for (const listingPage of discoverTargetListingPages($, pageUrl, source, options.maxPages)) {
          if (queuedPages.has(listingPage)) continue;
          queuedPages.add(listingPage);
          pages.push(listingPage);
        }
      }

      const pageCandidates =
        source === "JP" && pageUrl.includes("/94765/")
          ? collectJapaneseListingCandidates($, pageUrl)
          : collectCandidates($, pageUrl, source, pageUrl);
      if (!pageCandidates.length) {
        listingParseFailureCount += 1;
        warnings.push(`${language.warningLabel}一覧から記事リンクを抽出できませんでした: ${pageUrl}`);
        stoppedPageBases.add(pageInfo.baseUrl);
        continue;
      }

      let addedForDate = 0;
      for (const candidate of pageCandidates) {
        const date = candidate.urlDate || candidate.listDate;
        if (date) discoveredDates.add(date);
        if (!dateScope.includes(date ?? "")) continue;
        if (!candidates.has(candidate.url)) {
          candidates.set(candidate.url, candidate);
          addedForDate += 1;
        }
      }

      const dates = pageCandidates
        .map((candidate) => candidate.urlDate || candidate.listDate)
        .filter((date): date is string => Boolean(date))
        .sort();
      const newestOnPage = dates.at(-1);
      if (source !== "CN") {
        if (language.allArticlesUrl && newestOnPage && newestOnPage < earliest) break;
        if (language.allArticlesUrl && pageInfo.pageNumber >= options.maxPages) {
          pageLimitReached = hasNextListingPage($, pageUrl) || source !== "JP";
        }
        continue;
      }

      if (newestOnPage && newestOnPage < earliest) {
        stoppedPageBases.add(pageInfo.baseUrl);
        continue;
      }

      if (pageInfo.pageNumber >= options.maxPages && pageUrl !== language.homeUrl) {
        pageLimitReached = true;
      }

      if (pageInfo.pageNumber >= 2 && addedForDate === 0) {
        const staleCount = (stalePageCounts.get(pageInfo.baseUrl) ?? 0) + 1;
        stalePageCounts.set(pageInfo.baseUrl, staleCount);
        if (staleCount >= 2) stoppedPageBases.add(pageInfo.baseUrl);
      } else if (addedForDate > 0) {
        stalePageCounts.set(pageInfo.baseUrl, 0);
      }
    } catch (error) {
      if (isOptionalPaginationMiss(pageUrl, error) && !linkedPages.has(pageUrl)) {
        stoppedPageBases.add(pageInfo.baseUrl);
      } else {
        failedPages += 1;
        warnings.push(`${getPeopleLanguageConfig(source).warningLabel}一覧取得失敗: ${pageUrl} (${errorMessage(error)})`);
      }
    }
  }

  if (pageLimitReached) {
    warnings.push(
      `${language.warningLabel}は一覧ページ数上限に達しました。対象日の記事がまだ残っている可能性があります。`
    );
  }
  const orderedDates = [...discoveredDates].sort();

  return {
    candidates: [...candidates.values()].sort(
      (a, b) => scoreCandidate(b, source) - scoreCandidate(a, source)
    ),
    warnings: trimWarnings(warnings),
    attemptedPages,
    successfulPages,
    failedPages,
    listingParseFailureCount,
    pageLimitReached,
    earliestDiscoveredDate: orderedDates[0],
    latestDiscoveredDate: orderedDates.at(-1)
  };
}

function selectDailyCandidates(
  candidates: Candidate[],
  dateScope: string[],
  maxArticles: number
) {
  const limit = Math.max(1, Math.round(maxArticles));
  const groups = new Map(dateScope.map((date) => [date, [] as Candidate[]]));
  const selected: Candidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const date = candidate.urlDate || candidate.listDate;
    const group = date ? groups.get(date) : undefined;
    if (group) group.push(candidate);
  }

  while (selected.length < limit) {
    let added = false;
    for (const date of dateScope) {
      const candidate = groups.get(date)?.shift();
      if (!candidate || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      selected.push(candidate);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }

  return selected;
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

    if (!url || !title || title.length < getPeopleLanguageConfig(source).minTitleLength) return;
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
  // Keep ranking/sidebar links out of the chronological feed: their newer
  // dates can otherwise prevent stopping, or conceal a broken listing parser.
  const main = $(".j-d2tuwen .left, main, #main, #content, .article-list, .news-list").first();
  const anchors = main.length
    ? main.find("a")
    : $(".list h1 a, .list h2 a, .list h3 a, .list h4 a, .list .title a, .list .tit a");
  const seen = new Set<string>();
  const candidates = anchors
    .map((_, element) => {
      const anchor = $(element);
      const row = anchor.closest("li, article, .list, .item, .news-item");
      const title = cleanTitle(anchor.text() || anchor.attr("title") || "");
      const url = normalizeUrl(anchor.attr("href"), pageUrl);
      const time = row.find("time, .time, .date").first();
      const listPublishedAt = cleanText(time.attr("datetime") || time.text());

      if (!url || !title || !isLikelyArticleUrl(url, "JP") || seen.has(url)) return undefined;
      seen.add(url);

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

function hasNextListingPage($: cheerio.CheerioAPI, pageUrl: string) {
  const current = paginatedPageInfo(pageUrl);
  return $("a").toArray().some((element) => {
    const url = normalizeUrl($(element).attr("href"), pageUrl);
    if (!url) return false;
    const next = paginatedPageInfo(url);
    return next.baseUrl === current.baseUrl && next.pageNumber > current.pageNumber;
  });
}

async function queryPeopleSearch(query: string, limit: number): Promise<Candidate[]> {
  const response = await fetch("http://search.people.cn/search-platform/front/search", {
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
    .map((record) => candidateFromPeopleSearchRecord(record))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
}

function candidateFromPeopleSearchRecord(record: PeopleSearchRecord): Candidate | undefined {
  const title = cleanTitle(stripInlineHtml(record.title ?? ""));
  if (!record.url || !title || !isLikelyArticleUrl(record.url, "CN")) return undefined;
  const listPublishedAt = peopleSearchTime(record.displayTime ?? record.inputTime);

  return {
    title,
    url: record.url,
    urlDate: extractDateFromUrl(record.url),
    listPublishedAt,
    listDate: normalizePublishedDate(listPublishedAt),
    discoveredFrom: "http://search.people.cn/search-platform/front/search",
    category: record.belongsName || inferCategory(record.url, title)
  } satisfies Candidate;
}

function buildPeopleSearchQueries(article: Article) {
  if (!isPeopleSearchWorthy(article)) return [];
  const queries: string[] = [];
  for (const title of [article.title, article.translatedTitle].filter(Boolean) as string[]) {
    const foreignMinisterQuery = foreignMinisterTalkSearchQuery(title);
    if (foreignMinisterQuery) queries.push(foreignMinisterQuery);
    const foreignMinisterVisitQuery = foreignMinisterVisitSearchQuery(title);
    if (foreignMinisterVisitQuery) queries.push(foreignMinisterVisitQuery);

    const normalized = normalizeChineseSearchQuery(title);
    if (isUsefulPeopleSearchQuery(normalized)) queries.push(normalized);
  }

  return [...new Set(queries)].slice(0, 2);
}

function isPeopleSearchWorthy(article: Article) {
  const text = [article.title, article.translatedTitle, article.category, article.keywords.join(" ")]
    .filter(Boolean)
    .join(" ");
  return /政治|国際|台湾|軍事|外交|外相|会談|イラン|ホルムズ|村山|米国|キューバ|再軍事化|导弹|導弾|王毅/.test(
    text
  );
}

function foreignMinisterTalkSearchQuery(input: string) {
  const text = replaceForChineseSearch(input);
  const match = text.match(
    /(王毅|习近平|習近平)氏?が([\p{Script=Han}A-Za-z・]+)の([\p{Script=Han}A-Za-z・]+)外长と会谈/u
  );
  if (!match) return undefined;
  return `${match[1]}同${match[2]}外长${match[3]}会谈`;
}

function foreignMinisterVisitSearchQuery(input: string) {
  const text = replaceForChineseSearch(input);
  const match = text.match(/([\p{Script=Han}A-Za-z・]+)の([\p{Script=Han}A-Za-z・]+)外长が将访华/u);
  if (match) return `${match[1]}外长${match[2]}将访华`;
  const normalized = normalizeChineseSearchQuery(input);
  return /外长/.test(normalized) && /将访华/.test(normalized) ? normalized : undefined;
}

function normalizeChineseSearchQuery(input: string) {
  return replaceForChineseSearch(input)
    .replace(/[「」『』“”"'（）()\[\]【】]/g, "")
    .replace(/氏/g, "")
    .replace(/[がのをにはへでと、。・\s　]/g, "")
    .replace(/について|に関する|めぐり/g, "")
    .trim();
}

function replaceForChineseSearch(input: string) {
  const replacements: Array<[RegExp, string]> = [
    [/王毅氏/g, "王毅"],
    [/習近平/g, "习近平"],
    [/イラン/g, "伊朗"],
    [/アラグチ/g, "阿拉格齐"],
    [/外相/g, "外长"],
    [/会談/g, "会谈"],
    [/訪中へ|訪中予定|訪中する|中国を訪問へ/g, "将访华"],
    [/ホルムズ海峡/g, "霍尔木兹海峡"],
    [/米国|アメリカ/g, "美国"],
    [/キューバ/g, "古巴"],
    [/制裁/g, "制裁"],
    [/外交部/g, "外交部"],
    [/コメント/g, "回应"],
    [/村山談話/g, "村山谈话"],
    [/歴史を鑑とし|歴史を鑑/g, "以史为镜"],
    [/時代的価値/g, "时代价值"],
    [/守る/g, "守护"],
    [/右翼勢力/g, "右翼势力"],
    [/再軍事化/g, "再军事化"],
    [/攻撃型ミサイル|導弾/g, "进攻型导弹"],
    [/台湾/g, "台湾"]
  ];

  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

function isUsefulPeopleSearchQuery(query: string) {
  return query.length >= 8 && query.length <= 48 && /[\p{Script=Han}]/u.test(query);
}

function stripInlineHtml(input: string) {
  return input.replace(/<[^>]*>/g, "");
}

function peopleSearchTime(input: number | undefined) {
  if (!input || !Number.isFinite(input)) return undefined;
  return new Date(input).toISOString().slice(0, 10);
}

function cnDailySourcePages(maxPages: number) {
  const cnHome = getPeopleLanguageConfig("CN").homeUrl;
  const bases = [
    cnHome,
    "http://politics.people.com.cn/GB/1024/index.html",
    "http://finance.people.com.cn/GB/70846/index.html",
    "http://society.people.com.cn/GB/136657/index.html",
    "http://world.people.com.cn/GB/157278/index.html",
    "http://military.people.com.cn/index.html",
    "http://tw.people.com.cn/GB/index.html",
    "http://scitech.people.com.cn/GB/1057/index.html"
  ];

  return bases.flatMap((base) => expandIndexPages(base, base === cnHome ? 1 : maxPages));
}

function targetDailySourcePages(source: Source, maxPages: number) {
  const language = getPeopleLanguageConfig(source);
  const base = language.allArticlesUrl ?? language.homeUrl;
  return expandIndexPages(base, language.allArticlesUrl ? maxPages : 1);
}

function discoverTargetListingPages(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  source: Source,
  maxPages: number
) {
  const language = getPeopleLanguageConfig(source);
  const listingBases: string[] = [];
  const seen = new Set<string>();

  $("a").each((_, element) => {
    const url = normalizeUrl($(element).attr("href"), pageUrl);
    if (!url || seen.has(url)) return;
    const parsed = new URL(url);
    if (!language.articleHosts.includes(parsed.hostname)) return;
    if (!/\/index\.html$/i.test(parsed.pathname)) return;
    if (parsed.href === language.homeUrl) return;
    seen.add(url);
    listingBases.push(url);
  });

  return listingBases
    .slice(0, 12)
    .flatMap((base) => expandIndexPages(base, Math.min(maxPages, 5)));
}

function expandIndexPages(base: string, maxPages: number) {
  const pages = [base];
  for (let page = 2; page <= maxPages; page += 1) {
    pages.push(base.replace(/index\.html$/, `index${page}.html`));
  }
  return pages;
}

function paginatedPageInfo(pageUrl: string) {
  try {
    const parsed = new URL(pageUrl);
    const pageMatch = parsed.pathname.match(/index(\d*)\.html$/i);
    const pageNumber = pageMatch?.[1] ? Number(pageMatch[1]) : 1;
    parsed.pathname = parsed.pathname.replace(/index\d*\.html$/i, "index.html");
    return {
      baseUrl: parsed.toString(),
      pageNumber: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1
    };
  } catch {
    return { baseUrl: pageUrl, pageNumber: 1 };
  }
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

function cachedArticle(source: Source, url: string) {
  return articleCache().get(articleCacheKey(source, url));
}

function rememberArticle(article: Article) {
  const cache = articleCache();
  const key = articleCacheKey(article.source, article.url);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, article);

  while (cache.size > ARTICLE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }

  return article;
}

function articleCache() {
  globalThis.__PEOPLEDIFF_ARTICLE_CACHE__ ??= new Map<string, Article>();
  return globalThis.__PEOPLEDIFF_ARTICLE_CACHE__;
}

function articleCacheKey(source: Source, url: string) {
  return `${source}:${url}`;
}

function scrapeConcurrency() {
  const configured = Number(process.env.PEOPLEDIFF_SCRAPE_CONCURRENCY);
  if (!Number.isFinite(configured) || configured <= 0) return 16;
  return Math.min(32, Math.max(4, Math.round(configured)));
}

function isLikelyArticleUrl(url: string, source: Source) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname;
  const language = getPeopleLanguageConfig(source);

  if (!path.endsWith(".html")) return false;
  if (source !== "CN") {
    return language.articleHosts.includes(host) && /\/n\d\/\d{4}\/\d{4}\//.test(path);
  }

  if (!isChineseArticleHost(host)) return false;
  if (/pic|photo|video|tv|fangtan/i.test(host + path)) return false;
  return /\/n\d\/\d{4}\/\d{4}\//.test(path) || /\/GB\/.+\.html$/.test(path);
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
  const pathCategory = inferCategoryFromPath(url);
  if (pathCategory) return pathCategory;
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
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return isRealDate(normalized) ? normalized : undefined;
}

function isRealDate(input: string) {
  const [year, month, day] = input.split("-").map(Number);
  if (!year || !month || !day) return false;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10) === input;
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

function isOptionalPaginationMiss(pageUrl: string, error: unknown) {
  return /index\d+\.html$/i.test(new URL(pageUrl).pathname) && /Fetch failed 404/.test(errorMessage(error));
}

function trimWarnings(warnings: string[]) {
  return [...new Set(warnings)].slice(0, 8);
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
