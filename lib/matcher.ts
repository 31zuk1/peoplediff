import type { Article, ArticlePair, PairStatus } from "./types";
import { charNgrams, jaccard, keywordOverlap, normalizeForMatch, stableId } from "./text";

export type ArticleMatch = {
  base: Article;
  target: Article;
  score: number;
};

export type MatchCandidate = ArticleMatch;

// A refresh compares each article many times. Cache immutable text features,
// bounded across warm serverless invocations, rather than repeating the large
// bilingual dictionaries and signal regular expressions for every pair.
const normalizedTitleCache = new Map<string, string>();
const signalCache = new Map<string, string[]>();
const aliasCache = new Map<string, Set<string>>();
const topicTokenCache = new Map<string, string[]>();
const eventFeatureCache = new WeakMap<Article, EventFeatures>();

export function matchArticles(baseArticles: Article[], targetArticles: Article[]) {
  const matches: ArticleMatch[] = [];
  const usedBase = new Set<string>();

  for (const target of targetArticles) {
    const candidates = baseArticles
      .filter((base) => !usedBase.has(base.id))
      .map((base) => ({
        base,
        target,
        score: scorePair(base, target)
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (best && best.score >= matchThreshold(best.base, target)) {
      usedBase.add(best.base.id);
      matches.push({ base: best.base, target, score: best.score });
    }
  }

  return pairArticlesFromMatches(baseArticles, targetArticles, matches);
}

export function pairArticlesFromMatches(
  baseArticles: Article[],
  targetArticles: Article[],
  matches: ArticleMatch[]
) {
  const pairs: ArticlePair[] = [];
  const usedBase = new Set<string>();
  const matchedTarget = new Set<string>();

  for (const match of matches) {
    if (usedBase.has(match.base.id) || matchedTarget.has(match.target.id)) continue;
    usedBase.add(match.base.id);
    matchedTarget.add(match.target.id);
    pairs.push({
      id: stableId(`${match.base.id}:${match.target.id}`),
      status: "MATCHED",
      visibilityStatus: "MATCHED",
      base: match.base,
      target: match.target,
      cn: match.base,
      jp: match.target,
      sourceLanguage: match.base.source,
      targetLanguage: match.target.source,
      articlesBySource: {
        [match.base.source]: match.base,
        [match.target.source]: match.target
      },
      matchScore: match.score,
      highlights: mergedHighlights(match.base, match.target)
    });
  }

  for (const base of baseArticles) {
    if (usedBase.has(base.id)) continue;
    pairs.push({
      id: stableId(`${base.id}:base-only`),
      status: "CN ONLY",
      visibilityStatus: "BASE_ONLY",
      base,
      cn: base,
      sourceLanguage: base.source,
      articlesBySource: {
        [base.source]: base
      },
      onlySource: base.source,
      matchScore: 0,
      highlights: base.keywords.slice(0, 5)
    });
  }

  for (const target of targetArticles) {
    if (matchedTarget.has(target.id)) continue;
    pairs.push({
      id: stableId(`target-only:${target.id}`),
      status: targetOnlyStatus(target),
      visibilityStatus: "TARGET_ONLY",
      target,
      jp: target,
      targetLanguage: target.source,
      articlesBySource: {
        [target.source]: target
      },
      onlySource: target.source,
      matchScore: 0,
      highlights: target.keywords.slice(0, 5)
    });
  }

  return pairs;
}

export function rankMatchCandidates(
  baseArticles: Article[],
  target: Article,
  options: {
    limit?: number;
    minScore?: number;
    usedBase?: Set<string>;
  } = {}
) {
  const limit = options.limit ?? 6;
  const minScore = options.minScore ?? 0.12;
  const usedBase = options.usedBase ?? new Set<string>();

  return baseArticles
    .filter((base) => !usedBase.has(base.id))
    .map((base) => ({
      base,
      target,
      score: looseScorePair(base, target)
    }))
    .filter((candidate) => candidate.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function targetOnlyStatus(target: Article): PairStatus {
  return target.source === "JP" ? "JP ONLY" : "TARGET ONLY";
}

export function scorePair(cn: Article, jp: Article) {
  if (hasConflictingEventDates(cn, jp)) return 0;
  const eventScore = eventEvidenceScore(cn, jp);
  if (hasHardTopicMismatch(cn, jp)) return 0;
  if (eventScore >= 0.62) return eventScore;
  const cnTitle = cn.translatedTitle || cn.title;
  const jpTitle = jp.translatedTitle || jp.title;
  const aliasedCnTitle = normalizeBilingualTitle(cnTitle);
  const aliasedRawCnTitle = normalizeBilingualTitle(cn.title);
  const aliasedJpTitle = normalizeBilingualTitle(jpTitle);
  const aliasedRawJpTitle = normalizeBilingualTitle(jp.title);
  const sameCategory = Boolean(
    cn.category && jp.category && normalizeForMatch(cn.category) === normalizeForMatch(jp.category)
  );
  const titleScore = Math.max(
    jaccard(charNgrams(aliasedCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(aliasedCnTitle, 2), charNgrams(aliasedRawJpTitle, 2)),
    jaccard(charNgrams(aliasedRawCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(cnTitle, 2), charNgrams(jpTitle, 2)),
    jaccard(charNgrams(cn.title, 2), charNgrams(jp.title, 2))
  );
  const topicScore = keywordOverlap(cn.keywords, jp.keywords);
  const softTopicScore = Math.max(
    topicScore,
    softKeywordOverlap(cn.keywords, jp.keywords),
    signalOverlap(cn.keywords.join(" "), jp.keywords.join(" "))
  );
  const categoryScore = sameCategory ? 0.08 : 0;
  const strongSharedKeyword = hasStrongSharedKeyword(cn, jp);
  const aliasScore = Math.max(aliasOverlap(cn.title, jp.title), aliasOverlap(cnTitle, jpTitle));
  const strongAlias = hasStrongAlias(cn.title, jp.title) || hasStrongAlias(cnTitle, jpTitle);
  const titleTopicScore = tokenOverlap(topicTokens(aliasedCnTitle), topicTokens(aliasedJpTitle));
  const signalScore = Math.max(
    signalOverlap(aliasedCnTitle, aliasedJpTitle),
    signalOverlap(cn.title, jp.title),
    signalOverlap(cnTitle, jp.title),
    signalOverlap(cn.title, jpTitle)
  );
  const unsharedSpecificSignal = hasUnsharedSpecificSignal(cn, jp);
  const unsharedCriticalSignal = hasUnsharedCriticalSignal(cn, jp);
  const translatedTitleScore =
    cn.translatedTitle || jp.translatedTitle
      ? Math.max(
          jaccard(charNgrams(cnTitle, 2), charNgrams(jpTitle, 2)),
          jaccard(charNgrams(cn.translatedTitle || cn.title, 2), charNgrams(jp.title, 2)),
          jaccard(charNgrams(cn.title, 2), charNgrams(jp.translatedTitle || jp.title, 2))
        )
      : 0;
  const strongSignal = signalScore >= 0.5 && (softTopicScore >= 0.12 || titleScore >= 0.08);

  if (unsharedCriticalSignal && titleScore < 0.72 && translatedTitleScore < 0.72) {
    return 0;
  }

  if (
    unsharedSpecificSignal &&
    !strongAlias &&
    titleScore < 0.72 &&
    translatedTitleScore < 0.72
  ) {
    return 0;
  }

  if (
    !strongSharedKeyword &&
    !strongAlias &&
    !strongSignal &&
    translatedTitleScore < 0.28 &&
    titleScore < 0.28 &&
    titleTopicScore < 0.34 &&
    softTopicScore < 0.18 &&
    signalScore < 0.5
  ) {
    return 0;
  }

  if (
    !sameCategory &&
    !strongAlias &&
    !strongSharedKeyword &&
    !strongSignal &&
    translatedTitleScore < 0.34 &&
    titleScore < 0.38 &&
    titleTopicScore < 0.42 &&
    softTopicScore < 0.24 &&
    signalScore < 0.55
  ) {
    return 0;
  }

  return Number(
    Math.min(
      1,
      titleScore * 0.34 +
        aliasScore * 0.34 +
        titleTopicScore * 0.22 +
        translatedTitleScore * 0.2 +
        softTopicScore * 0.22 +
        signalScore * 0.22 +
        categoryScore +
        (strongSignal ? 0.18 : 0) +
        (strongSharedKeyword ? 0.04 : 0)
    ).toFixed(3)
  );
}

function looseScorePair(cn: Article, jp: Article) {
  if (hasHardTopicMismatch(cn, jp)) return 0;
  const eventScore = eventEvidenceScore(cn, jp);
  if (eventScore >= 0.62) return eventScore;

  const cnTitle = cn.translatedTitle || cn.title;
  const jpTitle = jp.translatedTitle || jp.title;
  const aliasedCnTitle = normalizeBilingualTitle(cnTitle);
  const aliasedRawCnTitle = normalizeBilingualTitle(cn.title);
  const aliasedJpTitle = normalizeBilingualTitle(jpTitle);
  const aliasedRawJpTitle = normalizeBilingualTitle(jp.title);
  const sameCategory = Boolean(
    cn.category && jp.category && normalizeForMatch(cn.category) === normalizeForMatch(jp.category)
  );
  const titleScore = Math.max(
    jaccard(charNgrams(aliasedCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(aliasedCnTitle, 2), charNgrams(aliasedRawJpTitle, 2)),
    jaccard(charNgrams(aliasedRawCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(cnTitle, 2), charNgrams(jpTitle, 2)),
    jaccard(charNgrams(cn.title, 2), charNgrams(jp.title, 2))
  );
  const topicScore = keywordOverlap(cn.keywords, jp.keywords);
  const softTopicScore = Math.max(
    topicScore,
    softKeywordOverlap(cn.keywords, jp.keywords),
    signalOverlap(cn.keywords.join(" "), jp.keywords.join(" "))
  );
  const aliasScore = Math.max(aliasOverlap(cn.title, jp.title), aliasOverlap(cnTitle, jpTitle));
  const titleTopicScore = tokenOverlap(topicTokens(aliasedCnTitle), topicTokens(aliasedJpTitle));
  const signalScore = Math.max(
    signalOverlap(aliasedCnTitle, aliasedJpTitle),
    signalOverlap(cn.title, jp.title),
    signalOverlap(cnTitle, jp.title),
    signalOverlap(cn.title, jpTitle)
  );
  const translatedTitleScore =
    cn.translatedTitle || jp.translatedTitle
      ? Math.max(
          jaccard(charNgrams(cnTitle, 2), charNgrams(jpTitle, 2)),
          jaccard(charNgrams(cn.translatedTitle || cn.title, 2), charNgrams(jp.title, 2)),
          jaccard(charNgrams(cn.title, 2), charNgrams(jp.translatedTitle || jp.title, 2))
        )
      : 0;
  const categoryScore = sameCategory ? 0.04 : 0;

  return Number(
    Math.max(candidateRecallScore(cn, jp), Math.min(
      1,
      titleScore * 0.26 +
        aliasScore * 0.28 +
        titleTopicScore * 0.18 +
        translatedTitleScore * 0.18 +
        softTopicScore * 0.18 +
        signalScore * 0.18 +
        categoryScore
    )).toFixed(3)
  );
}

export function hasHardTopicMismatch(cn: Article, jp: Article) {
  if (hasOutcomeStageMismatch(cn, jp)) return true;
  if (!hasUnsharedCriticalSignal(cn, jp)) return false;

  const cnTitle = cn.translatedTitle || cn.title;
  const jpTitle = jp.translatedTitle || jp.title;
  const aliasedCnTitle = normalizeBilingualTitle(cnTitle);
  const aliasedJpTitle = normalizeBilingualTitle(jpTitle);
  const titleScore = Math.max(
    jaccard(charNgrams(aliasedCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(cn.title, 2), charNgrams(jp.title, 2))
  );
  const translatedTitleScore =
    cn.translatedTitle || jp.translatedTitle
      ? Math.max(
          jaccard(charNgrams(cnTitle, 2), charNgrams(jpTitle, 2)),
          jaccard(charNgrams(cn.translatedTitle || cn.title, 2), charNgrams(jp.title, 2)),
          jaccard(charNgrams(cn.title, 2), charNgrams(jp.translatedTitle || jp.title, 2))
        )
      : 0;

  return titleScore < 0.72 && translatedTitleScore < 0.72;
}

function matchThreshold(cn: Article, jp: Article) {
  return hasMatchAnchor(cn, jp) ? 0.34 : 0.5;
}

function hasMatchAnchor(cn: Article, jp: Article) {
  const cnTitle = cn.translatedTitle || cn.title;
  const jpTitle = jp.translatedTitle || jp.title;
  const aliasedCnTitle = normalizeBilingualTitle(cnTitle);
  const aliasedJpTitle = normalizeBilingualTitle(jpTitle);
  const titleScore = Math.max(
    jaccard(charNgrams(aliasedCnTitle, 2), charNgrams(aliasedJpTitle, 2)),
    jaccard(charNgrams(cn.title, 2), charNgrams(jp.title, 2))
  );
  const signalScore = Math.max(
    signalOverlap(aliasedCnTitle, aliasedJpTitle),
    signalOverlap(cn.title, jp.title),
    signalOverlap(cn.keywords.join(" "), jp.keywords.join(" "))
  );

  return (
    titleScore >= 0.55 ||
    hasStrongSharedKeyword(cn, jp) ||
    hasStrongAlias(cn.title, jp.title) ||
    hasStrongAlias(cnTitle, jpTitle) ||
    signalScore >= 0.5
  );
}

export function applyAnalysisStatus(pair: ArticlePair): ArticlePair {
  if (!pair.cn || !pair.jp || !pair.analysis) return pair;
  if (pair.analysis.sameTopic === false || (pair.analysis.matchConfidence ?? 100) < 45) {
    return {
      ...pair,
      status: "CN ONLY",
      visibilityStatus: "BASE_ONLY",
      target: undefined,
      jp: undefined,
      articlesBySource: { [pair.cn.source]: pair.cn },
      onlySource: pair.cn.source,
      matchScore: 0,
      analysis: undefined,
      highlights: pair.cn.keywords.slice(0, 5)
    };
  }

  return {
    ...pair,
    status: "MATCHED",
    visibilityStatus: "MATCHED",
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
    "科学技術",
    "五一",
    "労働節",
    "劳动节",
    "連休",
    "假期",
    "観光",
    "旅游",
    "游客",
    "旅行",
    "交通",
    "管理",
    "公園",
    "公园",
    "北京",
    "上海",
    "パリ",
    "テヘラン",
    "ホルムズ海峡",
    "オマーン海峡",
    "トランプ",
    "ドナルドトランプ",
    "イラン"
  ]);
  const left = new Set(cn.keywords.map(normalizeForMatch).filter((keyword) => keyword && !weak.has(keyword)));
  return jp.keywords
    .map(normalizeForMatch)
    .some((keyword) => keyword && !weak.has(keyword) && left.has(keyword));
}

function normalizeBilingualTitle(input: string) {
  const cached = normalizedTitleCache.get(input);
  if (cached !== undefined) return cached;
  const aliases: Array<[RegExp, string]> = [
    [/进攻型导弹|攻撃型ミサイル|導弾/g, "攻撃型ミサイル"],
    [/日本/g, "日本"],
    [/中国/g, "中国"],
    [/习近平|習近平|Xi Jinping/gi, "習近平"],
    [/中国青年五四奖章|中国青年五四奨章/gi, "中国青年五四奨章"],
    [/新时代青年先锋奖|新時代青年先鋒賞/gi, "新時代青年先鋒賞"],
    [/回信|返信/gi, "返信"],
    [/乌兹别克斯坦|ウズベキスタン|Uzbekistan/gi, "ウズベキスタン"],
    [/阿里波夫|アリポフ|Aripov/gi, "アリポフ"],
    [/总理|首相|prime minister/gi, "首相"],
    [/高市早苗|Takaichi Sanae/gi, "高市早苗"],
    [/反思纠错|反省と是正|反省是正|soul-searching|correct mistakes/gi, "反省是正"],
    [/正常交流|normal exchanges/gi, "正常交流"],
    [/台湾问题|台湾問題|Taiwan question|Taiwan issue/gi, "台湾問題"],
    [/发射|発射/g, "発射"],
    [/回应|评论|コメント|答记者问|記者の質問/g, "コメント"],
    [/美方|美国|米国|アメリカ/g, "米国"],
    [/古巴|キューバ/g, "キューバ"],
    [/制裁|封锁/g, "制裁"],
    [/升级|强化|強化/g, "強化"],
    [/外交部|外務省|外务省|外務部|Chinese foreign ministry|foreign ministry|FM spokesperson/gi, "外交部"],
    [/发言人|スポークスマン|報道官|spokesperson/gi, "報道官"],
    [/一个中国原则|一つの中国原則|one-China principle/gi, "一つの中国原則"],
    [/中美关系|中米関係|米中関係|bilateral ties|U\.S\.-China ties|US-China ties/gi, "中米関係"],
    [/三个联合公报|三つの共同コミュニケ|三つの共同宣言|共同宣言|three joint communiques/gi, "三つの共同コミュニケ"],
    [/台湾当局|Taiwan authorities/gi, "台湾当局"],
    [/所谓“外交关系”|所谓外交关系|外交关系|外交関係|diplomatic ties/gi, "外交関係"],
    [/巴拉圭|パラグアイ|Paraguay/gi, "パラグアイ"],
    [/赖清德|頼清徳|李靖徳|Lai Ching-te/gi, "頼清徳"],
    [/斯威士兰|エスワティニ|Eswatini/gi, "エスワティニ"],
    [/台独|台湾独立|Taiwan independence/gi, "台湾独立"],
    [/分裂主义|分裂主義|separatism|secessionist/gi, "分裂主義"],
    [/习近平主席特使|習近平主席特使|習近平特使|Xi's special envoy|special envoy/gi, "習近平特使"],
    [/哥斯达黎加|コスタリカ|Costa Rica/gi, "コスタリカ"],
    [/吉布提|ジブチ|Djibouti/gi, "ジブチ"],
    [/乌干达|ウガンダ|Uganda/gi, "ウガンダ"],
    [/总统就职典礼|总统权力交接仪式|大統領就任式|大統領権限移譲式|presidential inauguration|presidential handover/gi, "大統領就任式"],
    [/洛桑江村|ロサン・ジャムカン|ロサンジャムカン|Losang Jamcan/gi, "ロサンジャムカン"],
    [/陈晓东|陈小东|陳暁東|陳小東|Chen Xiaodong/gi, "陳暁東"],
    [/孟加拉国|孟加拉人民共和国|バングラデシュ|Bangladesh/gi, "バングラデシュ"],
    [/卡利勒|ハリル|ハリルル|Khalil|Touhid Hossain/gi, "ハリル"],
    [/联合新闻稿|共同新闻稿|共同発表|共同プレスリリース|Joint Press Release/gi, "共同発表"],
    [/王沪宁|王滬寧|Wang Huning|top political advisor/gi, "王滬寧"],
    [/王毅|Wang Yi/gi, "王毅"],
    [/会谈|会談|hold talks|holds talks|talks/gi, "会談"],
    [/出入境|国境越え|cross-border|inbound|outbound/gi, "出入境"],
    [/1127\\.9万人次|1127万|11\\.279m|11.279 million/gi, "1127.9万人"],
    [/消费活力|消费市场|服务消费|消費市場|消費活力|Holiday consumption market|holiday consumption/gi, "祝日消費"],
    [/铁路.*五一|五一.*铁路|鉄道.*五一|railway.*May Day|rail/i, "鉄道輸送"],
    [/全面停火|全面停戦|full ceasefire|ceasefire/gi, "全面停戦"],
    [/当前局势|現情勢|current situation|Iran situation/gi, "現情勢"],
    [/特朗普|トランプ|Trump/gi, "トランプ"],
    [/马克龙|マクロン|Macron/gi, "マクロン"],
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
    [/右倾化|右傾化|右翼|右翼勢力/g, "右傾化"],
    [/再军事化|再軍事化|再军备|再軍備|軍国主義|军国主义/g, "再軍事化"],
    [/武器輸出|武器出口|武器禁运解除|防衛装備移転|防卫装备转移|殺傷兵器/g, "武器輸出"],
    [/大将|大佐|官階|军衔|軍階/g, "軍階復活"],
    [/吴宜泽|呉宜沢/g, "呉宜沢"],
    [/肖恩·墨菲|ショーン・マーフィー/g, "ショーンマーフィー"],
    [/谢菲尔德|シェフィールド/g, "シェフィールド"],
    [/斯诺克|スヌーカー/g, "スヌーカー"],
    [/世锦赛|世界錦標賽|世界選手権/g, "世界選手権"],
    [/夺冠|冠军|優勝|登顶|登頂/g, "優勝"],
    [/中国一拖|一拖集团|一拖集団/g, "中国一拖"],
    [/东方红|東方紅/g, "東方紅"],
    [/海鹰加科|海鷹加科/g, "海鷹加科"],
    [/长江第一隧道|長江第一トンネル|江海号|江海號/g, "長江第一トンネル"],
    [/阿拉格齐|アラグチ/g, "アラグチ"],
    [/伊朗|イラン/g, "イラン"],
    [/外长|外相/g, "外相"],
    [/访华|訪中|中国訪問|中国を訪問/g, "中国訪問"],
    [/悬崖|崖/g, "崖"]
  ];

  return rememberFeature(
    normalizedTitleCache,
    input,
    aliases.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input)
  );
}

function topicTokens(input: string) {
  const cached = topicTokenCache.get(input);
  if (cached) return cached;
  return rememberFeature(topicTokenCache, input, normalizeBilingualTitle(input)
    .normalize("NFKC")
    .split(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}ー]+/gu)
    .flatMap((part) => part.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーA-Za-z0-9]{2,12}/gu) ?? [])
    .map(normalizeForMatch)
    .filter((token) => token.length >= 2));
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

function softKeywordOverlap(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0;
  const a = [...new Set(left.map(normalizeTopicKeyword).filter(Boolean))];
  const b = [...new Set(right.map(normalizeTopicKeyword).filter(Boolean))];
  if (!a.length || !b.length) return 0;
  let hits = 0;

  for (const leftKeyword of a) {
    if (b.some((rightKeyword) => keywordsTouch(leftKeyword, rightKeyword))) hits += 1;
  }

  return hits / Math.max(a.length, b.length, 1);
}

function normalizeTopicKeyword(input: string) {
  return normalizeForMatch(normalizeBilingualTitle(input));
}

function keywordsTouch(left: string, right: string) {
  if (left === right) return true;
  if (left.length >= 3 && right.includes(left)) return true;
  if (right.length >= 3 && left.includes(right)) return true;
  return jaccard(charNgrams(left, 2), charNgrams(right, 2)) >= 0.52;
}

function signalOverlap(left: string, right: string) {
  const leftSignals = signalTerms(left);
  const rightSignals = signalTerms(right);
  if (!leftSignals.length || !rightSignals.length) return 0;
  const shared = leftSignals.filter((term) => rightSignals.includes(term));
  const strongShared = shared.filter((term) => strongSingleSignals.has(term));
  if (strongShared.length) {
    return Math.max(
      0.65,
      strongShared.length / Math.max(Math.min(leftSignals.length, rightSignals.length), 1)
    );
  }
  if (shared.length >= 3 && shared.some((term) => !weakSignals.has(term))) {
    return shared.length / Math.max(Math.min(leftSignals.length, rightSignals.length), 1);
  }
  return 0;
}

function signalTerms(input: string) {
  const cached = signalCache.get(input);
  if (cached) return cached;
  const text = normalizeBilingualTitle(input).normalize("NFKC");
  return rememberFeature(signalCache, input, signalPatterns
    .filter(([pattern]) => pattern.test(text))
    .map(([, term]) => term)
    .filter((term, index, all) => all.indexOf(term) === index));
}

const aliasTerms = [
  "日本",
  "中国",
  "習近平",
  "中国青年五四奨章",
  "新時代青年先鋒賞",
  "返信",
  "ウズベキスタン",
  "アリポフ",
  "首相",
  "高市早苗",
  "反省是正",
  "正常交流",
  "台湾問題",
  "海外",
  "攻撃型ミサイル",
  "発射",
  "米国",
  "キューバ",
  "制裁",
  "強化",
  "外交部",
  "報道官",
  "一つの中国原則",
  "中米関係",
  "三つの共同コミュニケ",
  "台湾当局",
  "外交関係",
  "パラグアイ",
  "頼清徳",
  "エスワティニ",
  "台湾独立",
  "分裂主義",
  "習近平特使",
  "コスタリカ",
  "ジブチ",
  "ウガンダ",
  "大統領就任式",
  "ロサンジャムカン",
  "陳暁東",
  "バングラデシュ",
  "ハリル",
  "共同発表",
  "王滬寧",
  "王毅",
  "会談",
  "出入境",
  "1127.9万人",
  "祝日消費",
  "鉄道輸送",
  "全面停戦",
  "現情勢",
  "トランプ",
  "マクロン",
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
  "再軍事化",
  "武器輸出",
  "軍階復活",
  "呉宜沢",
  "ショーンマーフィー",
  "シェフィールド",
  "中国一拖",
  "東方紅",
  "海鷹加科",
  "長江第一トンネル",
  "アラグチ",
  "イラン",
  "外相",
  "中国訪問",
  "崖"
];

const weakAliasTerms = new Set([
  "日本",
  "中国",
  "米国",
  "外交部",
  "報道官",
  "発射",
  "海外",
  "資料",
  "外相",
  "会談",
  "中国訪問",
  "現情勢",
  "守る",
  "広州交易会",
  "海外バイヤー",
  "トランプ",
  "マクロン",
  "イラン"
]);

const titleLineageWeakTerms = new Set([
  ...weakAliasTerms,
  "外相",
  "会談",
  "コメント",
  "発射",
  "強化",
  "制裁"
]);

const titleLineageActionTerms = new Set([
  "会談",
  "コメント",
  "発射",
  "強化",
  "制裁",
  "中国訪問",
  "守る",
  "再軍事化",
  "武器輸出",
  "共同発表"
]);

const signalPatterns: Array<[RegExp, string]> = [
  [/習近平|习近平|Xi Jinping/i, "xiJinping"],
  [/五一|劳动节|勞動節|労働節|メーデー|連休|祝日|May Day|holiday/i, "holiday"],
  [/消费|消費|consumption/i, "consumption"],
  [/市场|市場|market/i, "market"],
  [/增长|増加|成長|growth/i, "growth"],
  [/高质量发展|高品質発展|high-quality development|high quality development/i, "highQualityDevelopment"],
  [/義烏|义乌|Yiwu/i, "yiwu"],
  [/東京裁判|Tokyo Trial/i, "tokyoTrial"],
  [/世界卓球|卓球|table tennis|ITTF/i, "tableTennis"],
  [/西夏王陵|西夏皇陵|Xixia/i, "xixiaMausoleum"],
  [/中国青年五四奨章|新時代青年先鋒賞|五四奖章|青年先锋奖/i, "xiYouthLetter"],
  [/(?=.*(?:ウズベキスタン|Uzbekistan|乌兹别克斯坦))(?=.*(?:アリポフ|Aripov|首相|总理))(?=.*(?:訪中|访华|中国訪問|中国を訪問|visit China))/i, "uzbekPmVisit"],
  [/(?=.*(?:高市早苗|Takaichi))(?=.*(?:反省是正|soul-searching|正常交流|normal exchanges|中日|日中))/i, "takaichiExchange"],
  [/ジブチ|Djibouti/i, "djibouti"],
  [/ウガンダ|Uganda/i, "uganda"],
  [/コスタリカ|Costa Rica/i, "costaRica"],
  [/陳暁東|陳曉東|Chen Xiaodong/i, "chenXiaodong"],
  [/ロサンジャムカン|ロサン・ジャムカン|Losang Jamcan/i, "losangJamcan"],
  [/(?=.*(?:パラグアイ|Paraguay|巴拉圭))(?=.*(?:台湾|Taiwan|外交関係|diplomatic ties))/i, "paraguayTaiwan"],
  [/(?=.*(?:頼清徳|李靖徳|Lai Ching-te|赖清德|エスワティニ|Eswatini))(?=.*(?:台湾独立|台独|independence|separatism|分裂主義|偷渡))/i, "laiEswatini"],
  [/(?=.*(?:一つの中国|one-China|一个中国|三つの共同|three joint|台湾問題|Taiwan question))(?=.*(?:米国|美国|U\.S\.|US|中米|中美|bilateral))/i, "oneChinaUs"],
  [/(?=.*(?:習近平特使|主席特使|special envoy))(?=.*(?:コスタリカ|Costa Rica|ジブチ|Djibouti|ウガンダ|Uganda|就任式|handover|inauguration))/i, "xiSpecialEnvoy"],
  [/(?=.*(?:バングラデシュ|Bangladesh|孟加拉))(?=.*(?:外相|外长|FM|Khalil|ハリル|王毅|王沪宁|王滬寧))/i, "bangladeshFm"],
  [/共同発表|Joint Press Release/i, "jointPressRelease"],
  [/王滬寧|Wang Huning|top political advisor/i, "wangHuning"],
  [/出入境|cross-border|inbound|outbound|1127\\.9万人|11\\.279m/i, "crossBorderTravel"],
  [/祝日消費|Holiday consumption|消费活力|消费市场|サービス消費/i, "holidayConsumption"],
  [/鉄道輸送|railway|铁路/i, "railTransport"],
  [/(?=.*(?:イラン|Iran|伊朗))(?=.*(?:王毅|外相|外长|FM|Foreign Minister|Chinese FM|中伊|ceasefire|停戦|停火))/i, "iranCurrentSituation"],
  [/トランプ|Trump/i, "trump"],
  [/マクロン|Macron/i, "macron"],
  [/イスラエル.*核|Israel.*nuclear|nuclear program/i, "israelNuclear"],
  [/社会救助法|社会救助|social assistance|social relief/i, "socialAssistance"],
  [/交通事故|道路交通|road traffic/i, "roadTraffic"],
  [/公安院校|警察学院|police academ/i, "policeAcademy"],
  [/城乡教育|農村.*教育|教育均等|education equal/i, "educationEqualization"],
  [/電子情報製造|电子信息制造|electronic information manufacturing/i, "electronicsManufacturing"],
  [/再军事化|再軍事化|再军备|再軍備|軍国主義|军国主义|右傾化|右倾化|右翼勢力|武器輸出|防衛装備移転|殺傷兵器/i, "japanMilitarization"],
  [/吴宜泽|呉宜沢|斯诺克|スヌーカー|肖恩·墨菲|ショーン・マーフィー|シェフィールド|谢菲尔德/i, "snooker"],
  [/夺冠|冠军|優勝|登顶|登頂|champion/i, "championOutcome"],
  [/中国一拖|东方红|東方紅|トラクター|拖拉机/i, "tractor"],
  [/海鹰加科|海鷹加科|科学調査船|科学调查船|民間資本|民间资本/i, "researchVessel"],
  [/长江第一隧道|長江第一トンネル|江海号|江海號|シールドマシン|盾构/i, "yangtzeTunnel"],
  [/广交会|広州交易会|Canton Fair|海外バイヤー|境外采购商/i, "cantonFair"],
  [/支付宝|アリペイ|Alipay|訪中外国人|访中外国人/i, "alipayInbound"],
  [/(?=.*(?:伊朗|イラン|Iran))(?=.*(?:外长|外相|Foreign Minister))(?=.*(?:将访华|中国訪問|訪中予定|訪中する|訪中へ|will visit China|visit China))/i, "iranVisitAnnouncement"],
  [/阿拉格齐|アラグチ|Araghchi/i, "iranFmVisit"],
  [/(?=.*(?:伊朗|イラン|Iran))(?=.*(?:外长|外相|Foreign Minister))(?=.*(?:访华|訪中|中国訪問|中国を訪問|visit China))/i, "iranFmVisit"]
];

const weakSignals = new Set([
  "holiday",
  "consumption",
  "market",
  "growth",
  "highQualityDevelopment",
  "japanMilitarization",
  "cantonFair",
  "trump",
  "macron"
]);

const strongSingleSignals = new Set([
  "yiwu",
  "tokyoTrial",
  "tableTennis",
  "xixiaMausoleum",
  "xiYouthLetter",
  "uzbekPmVisit",
  "takaichiExchange",
  "socialAssistance",
  "roadTraffic",
  "policeAcademy",
  "educationEqualization",
  "electronicsManufacturing",
  "paraguayTaiwan",
  "laiEswatini",
  "oneChinaUs",
  "xiYouthLetter",
  "uzbekPmVisit",
  "takaichiExchange",
  "xiSpecialEnvoy",
  "costaRica",
  "chenXiaodong",
  "losangJamcan",
  "bangladeshFm",
  "jointPressRelease",
  "wangHuning",
  "crossBorderTravel",
  "holidayConsumption",
  "railTransport",
  "iranCurrentSituation",
  "iranVisitAnnouncement",
  "israelNuclear",
  "snooker",
  "tractor",
  "researchVessel",
  "yangtzeTunnel",
  "alipayInbound",
  "iranFmVisit"
]);

const exclusiveSpecificSignals = new Set([
  "paraguayTaiwan",
  "laiEswatini",
  "oneChinaUs",
  "xiSpecialEnvoy",
  "costaRica",
  "chenXiaodong",
  "losangJamcan",
  "bangladeshFm",
  "jointPressRelease",
  "wangHuning",
  "crossBorderTravel",
  "holidayConsumption",
  "railTransport",
  "trump",
  "macron",
  "israelNuclear",
  "iranCurrentSituation",
  "iranVisitAnnouncement",
  "iranFmVisit"
]);

const criticalExclusiveSignals = new Set([
  "jointPressRelease",
  "wangHuning",
  "crossBorderTravel",
  "railTransport",
  "iranCurrentSituation",
  "iranVisitAnnouncement",
  "iranFmVisit",
  "trump",
  "macron",
  "israelNuclear"
]);

function hasUnsharedSpecificSignal(cn: Article, jp: Article) {
  const cnSignals = specificSignals(cn);
  const jpSignals = specificSignals(jp);
  if (!cnSignals.size && !jpSignals.size) return false;

  const unsharedExclusive = [...cnSignals, ...jpSignals].some(
    (signal) =>
      exclusiveSpecificSignals.has(signal) &&
      !(cnSignals.has(signal) && jpSignals.has(signal))
  );
  if (unsharedExclusive) return true;

  for (const signal of cnSignals) {
    if (jpSignals.has(signal)) return false;
  }
  return true;
}

function hasUnsharedCriticalSignal(cn: Article, jp: Article) {
  // A detail present in only one summary is exactly what PeopleDiff should
  // investigate; it cannot veto candidate retrieval. Reserve hard exclusions
  // for subjects explicitly present in the headlines.
  const cnSignals = new Set(signalTerms([cn.title, cn.translatedTitle].filter(Boolean).join(" ")));
  const jpSignals = new Set(signalTerms([jp.title, jp.translatedTitle].filter(Boolean).join(" ")));
  return [...cnSignals, ...jpSignals].some(
    (signal) =>
      criticalExclusiveSignals.has(signal) &&
      !(cnSignals.has(signal) && jpSignals.has(signal))
  );
}

function specificSignals(article: Article) {
  const text = [
    article.title,
    article.translatedTitle,
    article.summary,
    article.keywords.join(" ")
  ]
    .filter(Boolean)
    .join(" ");
  return new Set(
    signalTerms(text).filter(
      (term) => term !== "championOutcome" && strongSingleSignals.has(term)
    )
  );
}

function hasOutcomeStageMismatch(cn: Article, jp: Article) {
  const cnText = articleOutcomeText(cn);
  const jpText = articleOutcomeText(jp);
  return (
    (hasFinalOutcome(cnText) && hasInProgressOutcome(jpText)) ||
    (hasFinalOutcome(jpText) && hasInProgressOutcome(cnText))
  );
}

function hasFinalOutcome(text: string) {
  return /夺冠|冠军|登顶|登頂|優勝|初優勝|champion/i.test(text);
}

function hasInProgressOutcome(text: string) {
  return /暂时领先|暫定|リード|领先|晋级决赛|決勝進出|半决赛|準決勝/i.test(text);
}

function articleSignalText(article: Article) {
  return [
    article.title,
    article.translatedTitle,
    article.summary,
    article.keywords.join(" ")
  ]
    .filter(Boolean)
    .join(" ");
}

function articleOutcomeText(article: Article) {
  return [article.title, article.translatedTitle].filter(Boolean).join(" ");
}

export function titleLineageScore(cn: Article, jp: Article) {
  const cnAliases = aliasSet(cn.title);
  const jpAliases = aliasSet(jp.title);
  if (!cnAliases.size || !jpAliases.size) return 0;
  const shared = [...jpAliases].filter((term) => cnAliases.has(term));
  const importantShared = shared.filter((term) => !titleLineageWeakTerms.has(term));
  if (!importantShared.length) return 0;
  const importantTarget = [...jpAliases].filter((term) => !titleLineageWeakTerms.has(term));
  const coverage = shared.length / Math.max(jpAliases.size, 1);
  const importantCoverage = importantShared.length / Math.max(importantTarget.length, 1);
  const actionBonus = shared.some((term) => titleLineageActionTerms.has(term)) ? 0.15 : 0;

  return Number(Math.min(1, coverage * 0.45 + importantCoverage * 0.4 + actionBonus).toFixed(3));
}

function aliasSet(input: string) {
  const cached = aliasCache.get(input);
  if (cached) return cached;
  const normalized = normalizeBilingualTitle(input);
  return rememberFeature(aliasCache, input, new Set(aliasTerms.filter((term) => normalized.includes(term))));
}

function rememberFeature<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.size >= 4096) cache.clear();
  cache.set(key, value);
  return value;
}

type EventFeatures = {
  titleGrams: Set<string>;
  bodyGrams: Set<string>;
  eventDates: Set<string>;
  quantities: Set<string>;
  date?: number;
};

// Script variants are evidence-preserving normalization, not a translation.
// In particular, a country name or a generic news word is never an event anchor.
const scriptVariants = new Map(
  "权権 盐塩 议議 决決 录録 记記 关関 会会 园園 门門 国国 东東 长長 龙竜 广広 气気 产産 车車 运運 输輸 贸貿 业業 经経 济済 资資 矿鉱 学学 术術 创創 设設 备備 现現 发発 观観 华華 总総 夺奪 进進 连連 对対 选選 获獲 银銀 铜銅 单単 数数 历歴 县県 场場 测測 试試 线線 马馬 尔爾 万万 亿億 计計 统統 报報 开開 庆慶 实実 终終 桥橋 铁鉄 湾湾 级級 组組 届回".split(" ").map((pair) => [pair[0], pair[1]])
);
const weakEventGrams = new Set([
  "中国", "日本", "人民", "国際", "社会", "経済", "政治", "文化", "世界",
  "全国", "発展", "最新", "今年", "国慶", "慶節", "連休", "観光", "旅行",
  "更新", "新記", "記録", "増加", "成長", "第一", "初日", "開催", "代表"
]);

function normalizeEventText(text: string) {
  return text.normalize("NFKC")
    .replace(/使馆/g, "使館")
    .replace(/侵闯/g, "侵入")
    .replace(/纪录|记录/g, "記録")
    .replace(/经济/g, "経済")
    .replace(/[\p{Script=Han}]/gu, (char) => scriptVariants.get(char) ?? char);
}

function eventFeatures(article: Article): EventFeatures {
  const cached = eventFeatureCache.get(article);
  if (cached) return cached;
  const title = normalizeEventText([article.title, article.translatedTitle].filter(Boolean).join(" "));
  const titleGrams = new Set(
    (title.match(/[\p{Script=Han}]{2,}/gu) ?? [])
      .flatMap((part) => charNgrams(part, 2))
      .filter((gram) => !weakEventGrams.has(gram))
  );
  const bodyGrams = new Set(
    (normalizeEventText(article.body.slice(0, 1800)).match(/[\p{Script=Han}]{3,}/gu) ?? [])
      .flatMap((part) => charNgrams(part, 3))
      .filter((gram) => !/中国|日本|人民|新華/.test(gram))
  );
  const eventDates = eventDatesFromLead(article);
  // Lead facts carry the concrete event. Limit background and footer numbers.
  const lead = `${article.title}\n${article.body.slice(0, 1800)}`.normalize("NFKC").replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "");
  const quantities = new Set<string>();
  const pattern = /(\d+(?:\.\d+)?(?:[兆億亿万萬]\d*(?:\.\d+)?)?(?:[億亿万萬]\d*(?:\.\d+)?)?)\s*(%|パーセント|ヶ国|か国|カ国|国|届|回|标箱|標箱|TEU|平方メートル|平方米|トン|吨|噸|公里|キロメートル|km|亿元|億元|美元|ドル|元|人)/gi;
  for (const match of lead.matchAll(pattern)) {
    const value = parseQuantity(match[1]);
    const unit = quantityUnit(match[2]);
    if (value >= 2 && Number.isFinite(value)) quantities.add(`${unit}:${value}`);
  }
  const date = Date.parse(article.publishedDate || article.urlDate || "");
  const features = { titleGrams, bodyGrams, eventDates, quantities, date: Number.isFinite(date) ? date : undefined };
  eventFeatureCache.set(article, features);
  return features;
}

function parseQuantity(text: string) {
  let value = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)([万萬][億亿]|[兆億亿万萬]?)/g)) {
    const scale = match[2] === "兆" || /[万萬][億亿]/.test(match[2]) ? 1e12 : /[億亿]/.test(match[2]) ? 1e8 : /[万萬]/.test(match[2]) ? 1e4 : 1;
    value += Number(match[1]) * scale;
  }
  return Number(value.toPrecision(12));
}

function eventDatesFromLead(article: Article) {
  const year = (article.publishedDate || article.urlDate || "").slice(0, 4);
  const lead = article.body.slice(0, 600).normalize("NFKC")
    .replace(/(?:新华社|人民网|本报)[^\n。]{0,70}?\d{1,2}月\d{1,2}日电/g, "")
    .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日\s*(?:配信|掲載|更新)/g, "")
    .replace(/[「“]人民[網网](?:日本語版)?[」”][\s\S]*$/, "")
    .replace(/《\s*人民日报[\s\S]*$/, "");
  return new Set(
    [...lead.matchAll(/(?:(\d{4})年\s*)?(\d{1,2})月(\d{1,2})日/g)]
      .map((match) => `${match[1] || year || "unknown"}-${Number(match[2])}-${Number(match[3])}`)
  );
}

function quantityUnit(unit: string) {
  if (/^(%|パーセント)$/.test(unit)) return "percent";
  if (/国$/.test(unit)) return "countries";
  if (/^(届|回)$/.test(unit)) return "edition";
  if (/^(标箱|標箱|TEU)$/i.test(unit)) return "containers";
  if (/^(平方メートル|平方米)$/.test(unit)) return "area";
  if (/^(トン|吨|噸)$/.test(unit)) return "tonnes";
  if (/^(公里|キロメートル|km)$/i.test(unit)) return "distance";
  if (/^(美元|ドル)$/.test(unit)) return "usd";
  return unit;
}

function hasConflictingEventDates(base: Article, target: Article) {
  const left = eventFeatures(base).eventDates;
  const right = eventFeatures(target).eventDates;
  return left.size > 0 && right.size > 0 && ![...left].some((date) => right.has(date));
}

/** Require both title subject evidence and independent, unit-aware body facts. */
export function eventEvidenceScore(base: Article, target: Article) {
  const left = eventFeatures(base);
  const right = eventFeatures(target);
  if (left.date !== undefined && right.date !== undefined && Math.abs(left.date - right.date) > 4 * 86400000) return 0;
  const sharedTitle = [...left.titleGrams].filter((gram) => right.titleGrams.has(gram));
  const sharedQuantities = [...left.quantities].filter((quantity) => right.quantities.has(quantity));
  const sharedUnits = new Set(sharedQuantities.map((quantity) => quantity.split(":")[0]));
  const sharedDate = [...left.eventDates].some((date) => right.eventDates.has(date));
  if (left.eventDates.size && right.eventDates.size && !sharedDate) return 0;
  const sharedBody = [...left.bodyGrams].filter((gram) => right.bodyGrams.has(gram)).length;
  // A release can be retitled entirely in translation. Five independently
  // equal quantities across multiple units, subject wording in the body, and
  // the same event date form a stronger fingerprint than headline similarity.
  if (sharedQuantities.length >= 5 && sharedUnits.size >= 2 && sharedBody >= 3 && sharedDate) return 0.78;
  if (sharedTitle.length < 2) return 0;
  const preciseQuantity = sharedQuantities.some((quantity) => {
    const [unit, raw] = quantity.split(":");
    const value = Number(raw);
    return !["edition", "countries", "人"].includes(unit) &&
      ((value >= 1000 && value % 100 !== 0) || !Number.isInteger(value));
  });
  if (!preciseQuantity && (sharedUnits.size < 2 || sharedTitle.length < 3)) return 0;
  return Number(Math.min(0.86, 0.62 + Math.max(0, sharedTitle.length - 3) * 0.02 + Math.max(0, sharedQuantities.length - 1) * 0.03).toFixed(3));
}

// Broader body recall is only for the AI shortlist. It never independently
// authorizes a heuristic match: translating headlines can change every noun.
function candidateRecallScore(base: Article, target: Article) {
  const left = eventFeatures(base);
  const right = eventFeatures(target);
  if (left.date !== undefined && right.date !== undefined && Math.abs(left.date - right.date) > 4 * 86400000) return 0;
  const sharedBody = [...left.bodyGrams].filter((gram) => right.bodyGrams.has(gram)).length;
  const sharedQuantities = [...left.quantities].filter((quantity) => right.quantities.has(quantity)).length;
  const sharedDate = [...left.eventDates].some((date) => right.eventDates.has(date));
  if (sharedBody < 3 || (!sharedQuantities && !sharedDate)) return 0;
  return Math.min(0.55, 0.18 + sharedBody * 0.015 + sharedQuantities * 0.04);
}

function aliasOverlap(left: string, right: string) {
  const a = aliasSet(left);
  const b = aliasSet(right);
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const term of a) {
    if (b.has(term)) hits += weakAliasTerms.has(term) ? 0.25 : 1;
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
