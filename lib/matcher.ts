import type { Article, ArticlePair } from "./types";
import { charNgrams, jaccard, keywordOverlap, normalizeForMatch, stableId } from "./text";

export function matchArticles(cnArticles: Article[], jpArticles: Article[]) {
  const pairs: ArticlePair[] = [];
  const usedCn = new Set<string>();
  const matchedJp = new Set<string>();

  for (const jp of jpArticles) {
    const candidates = cnArticles
      .filter((cn) => !usedCn.has(cn.id))
      .map((cn) => ({
        cn,
        jp,
        score: scorePair(cn, jp)
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (best && best.score >= 0.34) {
      usedCn.add(best.cn.id);
      matchedJp.add(jp.id);
      pairs.push({
        id: stableId(`${best.cn.id}:${jp.id}`),
        status: "MATCHED",
        cn: best.cn,
        jp,
        matchScore: best.score,
        highlights: mergedHighlights(best.cn, jp)
      });
    }
  }

  for (const cn of cnArticles) {
    if (usedCn.has(cn.id)) continue;
    pairs.push({
      id: stableId(`${cn.id}:cn-only`),
      status: "CN ONLY",
      cn,
      matchScore: 0,
      highlights: cn.keywords.slice(0, 5)
    });
  }

  for (const jp of jpArticles) {
    if (matchedJp.has(jp.id)) continue;
    pairs.push({
      id: stableId(`jp-only:${jp.id}`),
      status: "JP ONLY",
      jp,
      matchScore: 0,
      highlights: jp.keywords.slice(0, 5)
    });
  }

  return pairs;
}

export function scorePair(cn: Article, jp: Article) {
  const cnTitle = cn.translatedTitle || cn.title;
  const aliasedCnTitle = normalizeBilingualTitle(cnTitle);
  const aliasedRawCnTitle = normalizeBilingualTitle(cn.title);
  const aliasedJpTitle = normalizeBilingualTitle(jp.title);
  const sameCategory = Boolean(
    cn.category && jp.category && normalizeForMatch(cn.category) === normalizeForMatch(jp.category)
  );
  const titleScore = Math.max(
    jaccard(charNgrams(aliasedCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(aliasedRawCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(cnTitle, 2), charNgrams(jp.title, 2)),
    jaccard(charNgrams(cn.title, 2), charNgrams(jp.title, 2))
  );
  const topicScore = keywordOverlap(cn.keywords, jp.keywords);
  const categoryScore = sameCategory ? 0.08 : 0;
  const strongSharedKeyword = hasStrongSharedKeyword(cn, jp);
  const aliasScore = aliasOverlap(cn.title, jp.title);
  const strongAlias = hasStrongAlias(cn.title, jp.title);
  const titleTopicScore = tokenOverlap(topicTokens(aliasedCnTitle), topicTokens(aliasedJpTitle));
  const translatedTitleScore =
    cn.translatedTitle && cn.translatedTitle !== cn.title
      ? jaccard(charNgrams(cn.translatedTitle, 2), charNgrams(jp.title, 2))
      : 0;

  if (
    !strongSharedKeyword &&
    !strongAlias &&
    translatedTitleScore < 0.28 &&
    titleScore < 0.28 &&
    titleTopicScore < 0.34
  ) {
    return 0;
  }

  if (
    !sameCategory &&
    !strongAlias &&
    translatedTitleScore < 0.34 &&
    titleScore < 0.38 &&
    titleTopicScore < 0.42
  ) {
    return 0;
  }

  return Number(
    Math.min(
      1,
      titleScore * 0.42 +
        aliasScore * 0.42 +
        titleTopicScore * 0.34 +
        translatedTitleScore * 0.16 +
        topicScore * 0.04 +
        categoryScore
    ).toFixed(3)
  );
}

export function applyAnalysisStatus(pair: ArticlePair): ArticlePair {
  if (!pair.cn || !pair.jp || !pair.analysis) return pair;
  if (pair.analysis.sameTopic === false || (pair.analysis.matchConfidence ?? 100) < 45) {
    return {
      ...pair,
      status: "CN ONLY",
      jp: undefined,
      matchScore: 0,
      analysis: undefined,
      highlights: pair.cn.keywords.slice(0, 5)
    };
  }

  return {
    ...pair,
    status: "MATCHED",
    highlights: [
      ...pair.highlights,
      ...pair.analysis.missingPoints,
      ...pair.analysis.emphasizedPoints
    ]
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12)
  };
}

function mergedHighlights(cn: Article, jp: Article) {
  return [...cn.keywords, ...jp.keywords]
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .filter((keyword, index, all) => all.indexOf(keyword) === index)
    .slice(0, 8);
}

function hasStrongSharedKeyword(cn: Article, jp: Article) {
  const weak = new Set([
    "中国",
    "日本",
    "政策",
    "政治",
    "外交",
    "社会",
    "経済",
    "台湾",
    "文化",
    "科学技術"
  ]);
  const left = new Set(cn.keywords.map(normalizeForMatch).filter((keyword) => keyword && !weak.has(keyword)));
  return jp.keywords
    .map(normalizeForMatch)
    .some((keyword) => keyword && !weak.has(keyword) && left.has(keyword));
}

function normalizeBilingualTitle(input: string) {
  const aliases: Array<[RegExp, string]> = [
    [/进攻型导弹|攻撃型ミサイル|導弾/g, "攻撃型ミサイル"],
    [/日本/g, "日本"],
    [/中国/g, "中国"],
    [/发射|発射/g, "発射"],
    [/回应|评论|コメント|答记者问|記者の質問/g, "コメント"],
    [/美方|美国|米国|アメリカ/g, "米国"],
    [/古巴|キューバ/g, "キューバ"],
    [/制裁|封锁/g, "制裁"],
    [/升级|强化|強化/g, "強化"],
    [/外交部|外務省/g, "外交部"],
    [/以史为镜|歴史を鑑/g, "歴史を鑑"],
    [/村山谈话|村山談話/g, "村山談話"],
    [/守护|守る/g, "守る"],
    [/时代价值|時代的価値/g, "時代価値"],
    [/广交会|広州交易会/g, "広州交易会"],
    [/境外采购商|海外バイヤー/g, "海外バイヤー"],
    [/采购商|バイヤー/g, "バイヤー"],
    [/闭幕|閉幕/g, "閉幕"],
    [/访中外国人|訪中外国人/g, "訪中外国人"],
    [/支付宝|アリペイ/g, "アリペイ"],
    [/消费额|消費額/g, "消費額"],
    [/劳动节|労働節|五一/g, "労働節"],
    [/科学调查船|科学調査船/g, "科学調査船"],
    [/民间资本|民間資本/g, "民間資本"],
    [/浙江|浙江省/g, "浙江"],
    [/温岭|温嶺/g, "温嶺"],
    [/进水|進水/g, "進水"],
    [/长江|長江/g, "長江"],
    [/隧道|トンネル/g, "トンネル"],
    [/斯诺克|スヌーカー/g, "スヌーカー"],
    [/世锦赛|世界選手権/g, "世界選手権"],
    [/冠军|優勝/g, "優勝"],
    [/拖拉机|トラクター/g, "トラクター"],
    [/法国|フランス/g, "フランス"],
    [/侵华|中国侵略/g, "中国侵略"],
    [/资料|資料/g, "資料"],
    [/捐赠|寄贈/g, "寄贈"],
    [/右倾化|右傾化/g, "右傾化"],
    [/悬崖|崖/g, "崖"]
  ];

  return aliases.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

function topicTokens(input: string) {
  return normalizeBilingualTitle(input)
    .normalize("NFKC")
    .split(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}ー]+/gu)
    .flatMap((part) => part.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーA-Za-z0-9]{2,12}/gu) ?? [])
    .map(normalizeForMatch)
    .filter((token) => token.length >= 2);
}

function tokenOverlap(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits += 1;
  }
  return hits / Math.max(Math.min(a.size, b.size), 1);
}

const aliasTerms = [
  "日本",
  "中国",
  "海外",
  "攻撃型ミサイル",
  "発射",
  "米国",
  "キューバ",
  "制裁",
  "強化",
  "外交部",
  "村山談話",
  "歴史を鑑",
  "時代価値",
  "守る",
  "広州交易会",
  "海外バイヤー",
  "閉幕",
  "訪中外国人",
  "アリペイ",
  "消費額",
  "労働節",
  "科学調査船",
  "民間資本",
  "浙江",
  "温嶺",
  "進水",
  "長江",
  "トンネル",
  "スヌーカー",
  "世界選手権",
  "優勝",
  "トラクター",
  "フランス",
  "中国侵略",
  "資料",
  "寄贈",
  "右傾化",
  "崖"
];

const weakAliasTerms = new Set(["日本", "中国", "米国", "外交部", "発射", "海外", "資料"]);

function aliasSet(input: string) {
  const normalized = normalizeBilingualTitle(input);
  return new Set(aliasTerms.filter((term) => normalized.includes(term)));
}

function aliasOverlap(left: string, right: string) {
  const a = aliasSet(left);
  const b = aliasSet(right);
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const term of a) {
    if (b.has(term)) hits += 1;
  }
  return hits / Math.max(Math.min(a.size, b.size), 1);
}

function hasStrongAlias(left: string, right: string) {
  const a = aliasSet(left);
  const b = aliasSet(right);
  let shared = 0;
  let strong = 0;
  for (const term of a) {
    if (!b.has(term)) continue;
    shared += 1;
    if (!weakAliasTerms.has(term)) strong += 1;
  }
  return strong >= 2 || (strong >= 1 && shared >= 2);
}
