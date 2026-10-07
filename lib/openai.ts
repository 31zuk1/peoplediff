import OpenAI from "openai";
import { createHash } from "node:crypto";
import { getPeopleLanguageConfig } from "./languages";
import {
  beginOpenAiAttempt,
  recordOpenAiCacheHit,
  recordOpenAiCompletionUsage,
  recordOpenAiFailure,
  recordOpenAiSuccess
} from "./telemetry";
import type { Article, DifferenceAnalysis } from "./types";
import { compactSummary, extractKeywords, truncate } from "./text";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const REPAIR_MODEL = process.env.OPENAI_REPAIR_MODEL || "gpt-4.1-nano";
const OPENAI_CACHE_LIMIT = 3000;

const DISPLAY_ARRAY_FIELDS = [
  "cnPoints",
  "jpPoints",
  "missingPoints",
  "emphasizedPoints"
] as const;
const DISPLAY_TEXT_FIELDS = [
  "toneDifference",
  "politicalLanguage",
  "verdict"
] as const;

type DisplayArrayField = (typeof DISPLAY_ARRAY_FIELDS)[number];
type DisplayTextField = (typeof DISPLAY_TEXT_FIELDS)[number];
type DifferenceDisplayFields = Pick<
  DifferenceAnalysis,
  DisplayArrayField | DisplayTextField
>;

let client: OpenAI | undefined;

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_OPENAI_CACHE__: Map<string, unknown> | undefined;
}

function getClient() {
  if (!process.env.OPENAI_API_KEY?.trim()) return undefined;
  client ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY.trim(),
    // One attempt per article, bounded by the per-refresh circuit breaker.
    // In particular, retrying a 429 quota error cannot restore API access.
    maxRetries: 0,
    timeout: 20_000
  });
  return client;
}

export function activeModelLabel() {
  return process.env.OPENAI_API_KEY?.trim() ? MODEL : "local-heuristic";
}

type EnrichOptions = {
  useAi?: boolean;
};

export type SameTopicCandidate = {
  baseId: string;
  score: number;
  article: Article;
};

export type SameTopicDecision = {
  baseId?: string;
  sameTopic: boolean;
  matchConfidence: number;
  reason: string;
};

export function canUseOpenAI() {
  return Boolean(getClient());
}

export async function enrichArticle(
  article: Article,
  options: EnrichOptions = {}
): Promise<Article> {
  return article.source === "CN"
    ? enrichChineseArticle(article, options)
    : enrichTargetArticle(article, options);
}

export async function enrichChineseArticle(
  article: Article,
  options: EnrichOptions = {}
): Promise<Article> {
  const openai = options.useAi === false ? undefined : getClient();
  if (!openai) {
    return {
      ...article,
      enrichmentStatus: "heuristic",
      translatedTitle: article.title,
      summary: compactSummary(article.body, 180),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }

  const cacheKey = openAiCacheKey("enrich-cn", article);
  const cached = getOpenAiCache<Article>(cacheKey);
  if (cached) return cached;

  try {
    const json = await askJson<{
      translatedTitle?: string;
      summary?: string;
      keywords?: string[];
    }>(openai, [
      {
        role: "system",
        content:
          "You are a Japanese OSINT research assistant. Return compact JSON only."
      },
      {
        role: "user",
        content: `人民網中国語記事を日本語分析用に整形してください。
JSON schema:
{
  "translatedTitle": "日本語タイトル",
  "summary": "180字以内の日本語要約",
  "keywords": ["具体的な固有名詞", "具体的なテーマ", "地名"]
}
keywordsは照合に使うため、記事固有の語だけにしてください。「政策」「外交」「政治」「中国」「日本」のような汎用語は、それ自体が主題でない限り避けてください。

Title: ${article.title}
Body:
${truncate(article.body, 2600)}`
      }
    ], { validate: isArticleEnrichment });

    return setOpenAiCache(cacheKey, {
      ...article,
      enrichmentStatus: "ai",
      translatedTitle: json.translatedTitle || article.title,
      summary: json.summary || compactSummary(article.body, 180),
      keywords: sanitizeKeywords(json.keywords, article)
    });
  } catch {
    return {
      ...article,
      enrichmentStatus: "heuristic",
      translatedTitle: article.title,
      summary: compactSummary(article.body, 180),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }
}

export async function enrichTargetArticle(
  article: Article,
  options: EnrichOptions = {}
): Promise<Article> {
  const language = getPeopleLanguageConfig(article.source);
  const openai = options.useAi === false ? undefined : getClient();
  if (!openai) {
    return {
      ...article,
      enrichmentStatus: "heuristic",
      translatedTitle: article.translatedTitle || article.title,
      summary: compactSummary(article.body, language.summaryLength),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }

  const cacheKey = openAiCacheKey("enrich-target", article);
  const cached = getOpenAiCache<Article>(cacheKey);
  if (cached) return cached;

  try {
    const json = await askJson<{
      translatedTitle?: string;
      summary?: string;
      keywords?: string[];
    }>(openai, [
      {
        role: "system",
        content:
          "You are a Japanese OSINT media analysis assistant. Translate cross-language state media article metadata for matching. Return compact JSON only."
      },
      {
        role: "user",
        content: `人民網${language.editionLabel}の記事を日本語分析用に整形してください。対象言語が英語・仏語・西語・露語など日本語以外でも、必ず日本語のtranslatedTitleを返してください。
JSON schema:
{
  "translatedTitle": "日本語タイトル",
  "summary": "180字以内の日本語要約",
  "keywords": ["具体的な固有名詞", "具体的なテーマ", "地名"]
}
translatedTitleは照合に使います。原題をそのまま返さず、固有名詞を保った自然な日本語にしてください。
keywordsは照合に使うため、記事固有の固有名詞、制度名、地名、事件名だけにしてください。「政策」「外交」「政治」「中国」「日本」のような汎用語は、それ自体が主題でない限り避けてください。

Source language: ${language.label} (${language.code})
Title: ${article.title}
Body:
${truncate(article.body, 2600)}`
      }
    ], { validate: isArticleEnrichment });

    return setOpenAiCache(cacheKey, {
      ...article,
      enrichmentStatus: "ai",
      translatedTitle: json.translatedTitle || article.translatedTitle || article.title,
      summary: json.summary || compactSummary(article.body, language.summaryLength),
      keywords: sanitizeKeywords(json.keywords, article)
    });
  } catch {
    return {
      ...article,
      enrichmentStatus: "heuristic",
      translatedTitle: article.translatedTitle || article.title,
      summary: compactSummary(article.body, language.summaryLength),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }
}

export const enrichJapaneseArticle = enrichTargetArticle;

export async function adjudicateSameTopicMatch(
  target: Article,
  candidates: SameTopicCandidate[]
): Promise<SameTopicDecision | undefined> {
  const openai = getClient();
  if (!openai || !candidates.length) return undefined;
  const cacheKey = [
    "same-topic-v3",
    MODEL,
    target.id,
    articleFingerprint(target),
    candidates.map((candidate) => `${candidate.baseId}:${articleFingerprint(candidate.article)}`).join("|")
  ].join(":");
  const cached = getOpenAiCache<SameTopicDecision>(cacheKey);
  if (cached) return cached;

  try {
    const json = await askJson<{
      baseId?: string | null;
      sameTopic?: boolean;
      matchConfidence?: number;
      reason?: string;
    }>(openai, [
      {
        role: "system",
        content:
          "You are a strict cross-language People's Daily article matcher. Return compact Japanese JSON only."
      },
      {
        role: "user",
        content: `対象言語の記事と同一の具体的ニュース話題に当たる中国語版候補を1つだけ選んでください。なければbaseIdはnullにしてください。

JSON schema:
{
  "baseId": "candidate id or null",
  "sameTopic": true,
  "matchConfidence": 0,
  "reason": "日本語で短く理由"
}

判定基準:
- 同じ具体的な出来事、発表、会談、声明、試合、人物処分、制度改正ならsameTopic=true。
- 同じ国、同じ人物、同じ外交テーマ、同じ論調だけではfalse。
- 関連ニュース、背景解説、続報、同じ期間の別記事はfalse。
- 中国語版と対象言語版でタイトルの角度や本文量が違っても、同じ具体記事ならtrue。
- 候補が複数同じ出来事を扱う場合は、対象言語版の見出し、リード、本文構成に最も直接対応する中国語版を選んでください。
- 後日掲載の紙面版、詳報、要約版、関連解説より、同じ見出し・同じリード・同じ配信元本文に近い元記事を優先してください。
- 迷う場合はfalse寄りにしてください。

Target:
id: ${target.id}
source: ${target.source}
title: ${target.title}
translatedTitle: ${target.translatedTitle || ""}
date: ${target.urlDate || target.publishedDate || ""}
category: ${target.category || ""}
summary: ${truncate(target.summary || target.body, 700)}
keywords: ${target.keywords.join(", ")}

Candidates:
${candidates
  .map(
    (candidate, index) => `#${index + 1}
baseId: ${candidate.baseId}
heuristicScore: ${candidate.score}
title: ${candidate.article.title}
translatedTitle: ${candidate.article.translatedTitle || ""}
date: ${candidate.article.urlDate || candidate.article.publishedDate || ""}
category: ${candidate.article.category || ""}
bodyLength: ${candidate.article.body.length}
summary: ${truncate(candidate.article.summary || candidate.article.body, 620)}
keywords: ${candidate.article.keywords.join(", ")}`
  )
  .join("\n\n")}`
      }
    ], {
      validate: (input) => isSameTopicDecision(input) && (!input.sameTopic ||
        candidates.some((candidate) => candidate.baseId === input.baseId))
    });

    const baseId =
      typeof json.baseId === "string" && candidates.some((candidate) => candidate.baseId === json.baseId)
        ? json.baseId
        : undefined;
    const sameTopic = Boolean(json.sameTopic && baseId);
    return setOpenAiCache(cacheKey, {
      baseId,
      sameTopic,
      matchConfidence: normalizeScore(json.matchConfidence, sameTopic ? 60 : 0),
      reason: cleanSentence(json.reason, sameTopic ? "同一話題候補です。" : "同一話題ではありません。")
    });
  } catch {
    return undefined;
  }
}

export async function analyzeDifference(
  cn: Article,
  jp: Article,
  options: EnrichOptions = {}
): Promise<DifferenceAnalysis> {
  const baseLanguage = getPeopleLanguageConfig(cn.source);
  const targetLanguage = getPeopleLanguageConfig(jp.source);
  const fallback = sanitizeDifferenceAnalysisForJapaneseDisplay(localDifference(cn, jp));
  const openai = options.useAi === false ? undefined : getClient();
  if (!openai) return fallback;
  const cacheKey = [
    "diff-v4-analysis-status",
    MODEL,
    REPAIR_MODEL,
    cn.id,
    articleFingerprint(cn),
    jp.id,
    articleFingerprint(jp)
  ].join(":");
  const cached = getOpenAiCache<DifferenceAnalysis>(cacheKey);
  if (cached) return sanitizeDifferenceAnalysisForJapaneseDisplay(cached, fallback);

  try {
    const json = await askJson<Partial<DifferenceAnalysis>>(openai, [
      {
        role: "system",
        content:
          "You compare Chinese state media articles across language editions. First decide whether they are the same concrete news topic. Return Japanese JSON only. Every user-facing string must be natural Japanese. Be concise, analytical, and surface even small observable differences."
      },
      {
        role: "user",
        content: `${baseLanguage.editionLabel}と${targetLanguage.editionLabel}の同一話題らしい記事を比較してください。
次のJSON schemaだけを返してください:
{
  "sameTopic": true,
  "matchConfidence": 0,
  "bodyDifferenceScore": 0,
  "framingShiftScore": 0,
  "cnPoints": ["基準言語版の要点"],
  "jpPoints": ["対象言語版の要点"],
  "missingPoints": [],
  "emphasizedPoints": [],
  "toneDifference": "論調差分を1文",
  "politicalLanguage": "政治的表現の変化を1文",
  "verdict": "観測メモを1文",
  "shiftScore": 0
}
cnPoints、jpPoints、missingPoints、emphasizedPoints、toneDifference、politicalLanguage、verdictはすべて自然な日本語で書いてください。
中国語の文法や語句（例: 「具体提及」「未提及」「中国强调」「军演」「威胁」）をそのまま出さず、日本語に訳してください。
記事内の固有表現を引用する場合も、原則として日本語訳を使い、必要な場合だけ原語を括弧で補足してください。
悪い例: 具体提及“肩并肩”军演细节（CN）、未提及“88式导弹首次”具体时间（JP）
良い例: 中国語版は「肩を並べて」演習の詳細に触れる一方、対象言語版では88式導弾の初使用時点が弱い。
sameTopicは同一の具体的ニュース話題ならtrue。単に同じ分野、同じ国、同じ論調だけならfalse。
matchConfidenceは0-100。同一話題でない場合は30以下。
bodyDifferenceScoreは0-100。分量、具体情報、背景、引用、経歴、数値などの本文差が大きいほど高くしてください。
framingShiftScoreは0-100。価値判断、政治的表現、批判/称賛の向き、読者への見せ方が違うほど高くしてください。
shiftScoreはmax(bodyDifferenceScore, framingShiftScore)を入れてください。
重要: 差分観測UIなので、軽微でも本文から観測できる省略・追加・強調・圧縮はmissingPoints/emphasizedPointsに書いてください。
本文から確認できる意味のある差分がなければ空配列にしてください。翻訳上の語順・文字数・表記の違いだけから、省略や政治的編集を推測しないでください。
本文は上限で切り詰める場合があります。抜粋範囲に見当たらないだけの情報を、記事全体から削除された情報と断定しないでください。確認できない場合はその限界をverdictに明記してください。
論調差が小さくても本文の具体情報量に差がある場合は、missingPoints/emphasizedPointsに具体的に書いてください。
差が軽微ならtoneDifferenceに「大きな論調差は限定的」と書きつつ、本文差分は別途列挙してください。
missingPointsは「${baseLanguage.editionLabel}にあり${targetLanguage.editionLabel}で欠落または明確に弱い論点」だけ。
emphasizedPointsは「${targetLanguage.editionLabel}で${baseLanguage.editionLabel}より明確に強調された論点」だけ。
各差分は「どちらに何がある/ないか」が分かる具体表現にしてください。

Base (${baseLanguage.code}) title: ${cn.title}
Base translated title: ${cn.translatedTitle || cn.title}
Base body excerpt: ${Math.min(cn.body.length, 3200)} / ${cn.body.length} characters
Base body:
${truncate(cn.body, 3200)}

Target (${targetLanguage.code}) title: ${jp.title}
Target translated title: ${jp.translatedTitle || jp.title}
Target body excerpt: ${Math.min(jp.body.length, 3200)} / ${jp.body.length} characters
Target body:
${truncate(jp.body, 3200)}`
      }
    ], { validate: isDifferenceAnalysis });
    const normalized = normalizeDifference(json, fallback);
    const repaired = await ensureJapaneseAnalysis(openai, normalized, fallback);
    return setOpenAiCache(cacheKey, repaired);
  } catch {
    return fallback;
  }
}

export async function askJson<T>(
  openai: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options: { model?: string; temperature?: number; validate?: (input: Record<string, unknown>) => boolean } = {}
): Promise<T> {
  if (!beginOpenAiAttempt()) throw new Error("AI processing is paused for this refresh");
  const model = options.model ?? MODEL;
  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: options.temperature ?? 0.2,
      response_format: { type: "json_object" },
      messages
    }, { maxRetries: 0, timeout: 20_000 });
    recordOpenAiCompletionUsage(model, completion.usage);
    const choice = completion.choices[0];
    if (!choice?.message.content || choice.finish_reason !== "stop" || choice.message.refusal) {
      throw new InvalidOpenAiResponseError();
    }
    const parsed: unknown = JSON.parse(choice.message.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length ||
      (options.validate && !options.validate(parsed as Record<string, unknown>))) {
      throw new InvalidOpenAiResponseError();
    }
    recordOpenAiSuccess();
    return parsed as T;
  } catch (error) {
    recordOpenAiFailure(error);
    throw error;
  }
}

class InvalidOpenAiResponseError extends Error {
  name = "InvalidOpenAiResponseError";
  constructor() { super("AI response did not satisfy the expected JSON format"); }
}

function isArticleEnrichment(input: Record<string, unknown>) {
  return typeof input.translatedTitle === "string" && Boolean(input.translatedTitle.trim()) &&
    typeof input.summary === "string" && Boolean(input.summary.trim()) && isStringArray(input.keywords);
}

function isSameTopicDecision(input: Record<string, unknown>) {
  return typeof input.sameTopic === "boolean" &&
    (input.baseId === null || typeof input.baseId === "string") &&
    typeof input.matchConfidence === "number" && Number.isFinite(input.matchConfidence) &&
    typeof input.reason === "string";
}

function isDifferenceAnalysis(input: Record<string, unknown>) {
  return typeof input.sameTopic === "boolean" &&
    ["matchConfidence", "bodyDifferenceScore", "framingShiftScore", "shiftScore"].every(
      (field) => typeof input[field] === "number" && Number.isFinite(input[field])
    ) && DISPLAY_ARRAY_FIELDS.every((field) => isStringArray(input[field])) &&
    DISPLAY_TEXT_FIELDS.every((field) => typeof input[field] === "string" && Boolean(input[field].trim()));
}

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((item) => typeof item === "string");
}

function articleFingerprint(article: Article) {
  return createHash("sha256").update(JSON.stringify([
    article.title, article.translatedTitle, article.body, article.summary, article.keywords
  ])).digest("hex").slice(0, 24);
}

function openAiCacheKey(kind: string, article: Article) {
  // Enrichment prompts contain original title/body only. The JP anchored matcher
  // may receive this same article with enrichment already attached.
  const content = createHash("sha256").update(JSON.stringify([article.title, article.body])).digest("hex").slice(0, 24);
  return [kind, MODEL, article.source, article.id, content].join(":");
}

function getOpenAiCache<T>(key: string) {
  const cached = openAiCache().get(key) as T | undefined;
  if (cached !== undefined) recordOpenAiCacheHit();
  return cached;
}

function setOpenAiCache<T>(key: string, value: T) {
  const cache = openAiCache();
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);

  while (cache.size > OPENAI_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }

  return value;
}

function openAiCache() {
  globalThis.__PEOPLEDIFF_OPENAI_CACHE__ ??= new Map<string, unknown>();
  return globalThis.__PEOPLEDIFF_OPENAI_CACHE__;
}

function sanitizeKeywords(keywords: string[] | undefined, article: Article) {
  const weak = new Set(["政策", "外交", "政治", "中国", "日本", "社会", "経済"]);
  const fromModel = (keywords ?? [])
    .map((keyword) => String(keyword).trim())
    .filter(Boolean)
    .filter((keyword, _, all) => all.length <= 3 || !weak.has(keyword))
    .slice(0, 8);

  return fromModel.length ? fromModel : article.keywords.length ? article.keywords : extractKeywords(article.body);
}

function localDifference(cn: Article, jp: Article): DifferenceAnalysis {
  // Different scripts and word counts are not evidence of omitted content or
  // framing. Absence of AI analysis must also not overturn a topic match.
  return {
    analysisStatus: "unavailable",
    bodyDifferenceScore: 0,
    framingShiftScore: 0,
    cnPoints: [`${getPeopleLanguageConfig(cn.source).editionLabel}の要点は未分析です。原文を確認してください。`],
    jpPoints: [`${getPeopleLanguageConfig(jp.source).editionLabel}の要点は未分析です。原文を確認してください。`],
    missingPoints: [],
    emphasizedPoints: [],
    toneDifference: "論調差分は未分析です。差分がないという判定ではありません。",
    politicalLanguage: "政治的表現の差分は未分析です。",
    verdict: "AIによる本文比較は未実施です。同一話題の照合結果のみを表示しています。",
    shiftScore: 0
  };
}

function normalizeDifference(
  input: Partial<DifferenceAnalysis>,
  fallback: DifferenceAnalysis
): DifferenceAnalysis {
  const bodyDifferenceScore = normalizeScore(
    input.bodyDifferenceScore,
    fallback.bodyDifferenceScore ?? fallback.shiftScore
  );
  const framingShiftScore = normalizeScore(
    input.framingShiftScore,
    fallback.framingShiftScore ?? 0
  );
  const shiftScore = normalizeScore(
    input.shiftScore,
    Math.max(bodyDifferenceScore, framingShiftScore, fallback.shiftScore)
  );

  return {
    analysisStatus: "ai",
    sameTopic: input.sameTopic ?? fallback.sameTopic,
    matchConfidence: normalizeScore(input.matchConfidence, fallback.matchConfidence ?? 0),
    bodyDifferenceScore,
    framingShiftScore,
    cnPoints: normalizeStringArray(input.cnPoints, fallback.cnPoints),
    jpPoints: normalizeStringArray(input.jpPoints, fallback.jpPoints),
    missingPoints: normalizeStringArray(input.missingPoints, []).map(normalizeJapaneseUiText),
    emphasizedPoints: normalizeStringArray(input.emphasizedPoints, []).map(normalizeJapaneseUiText),
    toneDifference: cleanSentence(input.toneDifference, fallback.toneDifference),
    politicalLanguage: cleanSentence(input.politicalLanguage, fallback.politicalLanguage),
    verdict: cleanSentence(input.verdict, fallback.verdict),
    shiftScore
  };
}

async function ensureJapaneseAnalysis(
  openai: OpenAI,
  analysis: DifferenceAnalysis,
  fallback: DifferenceAnalysis
): Promise<DifferenceAnalysis> {
  if (!analysisNeedsJapaneseRepair(analysis)) {
    return sanitizeDifferenceAnalysisForJapaneseDisplay(analysis, fallback);
  }

  try {
    const repaired = await askJson<Partial<DifferenceDisplayFields>>(
      openai,
      [
        {
          role: "system",
          content:
            "You are a Japanese copy editor and translation repair layer for an OSINT dashboard. Return compact JSON only. Do not add analysis, facts, or interpretation."
        },
        {
          role: "user",
          content: `次の差分分析JSONのユーザー表示文字列だけを自然な日本語に修復してください。

ルール:
- 意味、比較方向、固有名詞、数値、論点数を維持してください。
- 中国語の文法、簡体字、中国語語順、中国語メディア表現を残さないでください。
- 新しい分析、推測、事実追加はしないでください。
- すでに自然な日本語の項目は維持してください。
- 翻訳不能な配列項目は削除し、翻訳不能な文字列は空文字にしてください。

返すJSON schema:
{
  "cnPoints": ["日本語"],
  "jpPoints": ["日本語"],
  "missingPoints": ["日本語"],
  "emphasizedPoints": ["日本語"],
  "toneDifference": "日本語",
  "politicalLanguage": "日本語",
  "verdict": "日本語"
}

Input:
${JSON.stringify(displayFields(analysis))}`
        }
      ],
      { model: REPAIR_MODEL, temperature: 0 }
    );
    return sanitizeDifferenceAnalysisForJapaneseDisplay(
      applyRepairedDisplayFields(analysis, repaired),
      fallback
    );
  } catch {
    return sanitizeDifferenceAnalysisForJapaneseDisplay(analysis, fallback);
  }
}

function analysisNeedsJapaneseRepair(analysis: DifferenceAnalysis) {
  const display = displayFields(analysis);
  return [
    ...DISPLAY_ARRAY_FIELDS.flatMap((field) => display[field]),
    ...DISPLAY_TEXT_FIELDS.map((field) => display[field])
  ].some(containsChineseResidue);
}

function displayFields(analysis: DifferenceAnalysis): DifferenceDisplayFields {
  return {
    cnPoints: analysis.cnPoints,
    jpPoints: analysis.jpPoints,
    missingPoints: analysis.missingPoints,
    emphasizedPoints: analysis.emphasizedPoints,
    toneDifference: analysis.toneDifference,
    politicalLanguage: analysis.politicalLanguage,
    verdict: analysis.verdict
  };
}

function applyRepairedDisplayFields(
  analysis: DifferenceAnalysis,
  repaired: Partial<DifferenceDisplayFields>
): DifferenceAnalysis {
  return {
    ...analysis,
    cnPoints: normalizeRepairedArray(repaired.cnPoints, analysis.cnPoints),
    jpPoints: normalizeRepairedArray(repaired.jpPoints, analysis.jpPoints),
    missingPoints: normalizeRepairedArray(repaired.missingPoints, analysis.missingPoints),
    emphasizedPoints: normalizeRepairedArray(
      repaired.emphasizedPoints,
      analysis.emphasizedPoints
    ),
    toneDifference: normalizeRepairedText(
      repaired.toneDifference,
      analysis.toneDifference
    ),
    politicalLanguage: normalizeRepairedText(
      repaired.politicalLanguage,
      analysis.politicalLanguage
    ),
    verdict: normalizeRepairedText(repaired.verdict, analysis.verdict)
  };
}

function sanitizeDifferenceAnalysisForJapaneseDisplay(
  analysis: DifferenceAnalysis,
  fallback?: DifferenceAnalysis
): DifferenceAnalysis {
  return {
    ...analysis,
    cnPoints: sanitizeDisplayArray(
      analysis.cnPoints,
      fallback?.cnPoints,
      "基準言語版の要点は日本語整形に失敗したため非表示にしました。"
    ),
    jpPoints: sanitizeDisplayArray(
      analysis.jpPoints,
      fallback?.jpPoints,
      "対象言語版の要点は日本語整形に失敗したため非表示にしました。"
    ),
    missingPoints: sanitizeDisplayArray(analysis.missingPoints, fallback?.missingPoints),
    emphasizedPoints: sanitizeDisplayArray(
      analysis.emphasizedPoints,
      fallback?.emphasizedPoints
    ),
    toneDifference: sanitizeDisplayText(
      analysis.toneDifference,
      fallback?.toneDifference,
      "論調差分の日本語整形に失敗しました。"
    ),
    politicalLanguage: sanitizeDisplayText(
      analysis.politicalLanguage,
      fallback?.politicalLanguage,
      "政治表現差分の日本語整形に失敗しました。"
    ),
    verdict: sanitizeDisplayText(
      analysis.verdict,
      fallback?.verdict,
      "本文差分の日本語整形に失敗しました。"
    )
  };
}

function sanitizeDisplayArray(
  items: string[] | undefined,
  fallback: string[] | undefined,
  placeholder?: string
) {
  const cleanItems = cleanJapaneseArray(items);
  if (cleanItems.length) return cleanItems;

  const cleanFallback = cleanJapaneseArray(fallback);
  if (cleanFallback.length) return cleanFallback;

  return placeholder ? [placeholder] : [];
}

function cleanJapaneseArray(items: string[] | undefined) {
  return (items ?? [])
    .map((item) => normalizeJapaneseUiText(String(item).trim()))
    .filter(Boolean)
    .filter((item) => !containsChineseResidue(item))
    .slice(0, 5);
}

function sanitizeDisplayText(
  text: string | undefined,
  fallback: string | undefined,
  placeholder: string
) {
  const cleanText = cleanJapaneseText(text);
  if (cleanText) return cleanText;

  const cleanFallback = cleanJapaneseText(fallback);
  return cleanFallback || placeholder;
}

function cleanJapaneseText(text: string | undefined) {
  const normalized = normalizeJapaneseUiText(String(text ?? "").trim());
  return normalized && !containsChineseResidue(normalized) ? normalized : "";
}

function normalizeRepairedArray(input: unknown, fallback: string[]) {
  if (!Array.isArray(input)) return fallback;
  return input
    .map((item) => normalizeJapaneseUiText(String(item).trim()))
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeRepairedText(input: unknown, fallback: string) {
  const text = normalizeJapaneseUiText(String(input ?? "").trim());
  return text || fallback;
}

function containsChineseResidue(input: string) {
  return assessChineseResidue(input).score >= 4;
}

function assessChineseResidue(input: string) {
  const text = input.trim();
  if (!text) return { score: 0, reasons: [] as string[] };

  let score = 0;
  const reasons: string[] = [];
  const simplifiedChars = new Set(
    Array.from(
      text.match(/[语资报团队调强为与将这该们员历际汉证认实东义华则问]/g) ?? []
    )
  );
  if (simplifiedChars.size) {
    score += Math.min(6, simplifiedChars.size * 2);
    reasons.push(`simplified:${Array.from(simplifiedChars).join("")}`);
  }

  const strongChinesePhrases = [
    "中文报道",
    "日文报道",
    "报道称",
    "报道指出",
    "更强调",
    "资料",
    "揭露",
    "具体身份",
    "具体描述",
    "具体史料",
    "相关",
    "方面表示",
    "多角度",
    "证据",
    "未涉及",
    "未在",
    "即时性",
    "详细性",
    "侵华",
    "价值",
    "显示双方",
    "具有重要意义"
  ];
  strongChinesePhrases.forEach((phrase) => {
    if (text.includes(phrase)) {
      score += 3;
      reasons.push(`phrase:${phrase}`);
    }
  });

  const grammarPatterns = [
    /[\p{Script=Han}]{1,8}的[\p{Script=Han}]{1,8}/u,
    /(?:而中文|而日文|则|并|以及|将|该|对)[\p{Script=Han}]/u,
    /[\p{Script=Han}](?:了|被|把|与)[\p{Script=Han}]/u
  ];
  grammarPatterns.forEach((pattern) => {
    if (pattern.test(text)) {
      score += 2;
      reasons.push(`grammar:${pattern.source}`);
    }
  });

  const kanaCount = countMatches(text, /[ぁ-んァ-ヶー]/g);
  const hanCount = countMatches(text, /\p{Script=Han}/gu);
  const visibleCount = Array.from(text.replace(/\s/g, "")).length;
  if (visibleCount >= 14 && hanCount / visibleCount > 0.6) {
    if (kanaCount / visibleCount < 0.1) {
      score += 2;
      reasons.push("low-kana");
    } else if (kanaCount / visibleCount < 0.2) {
      score += 1;
      reasons.push("thin-kana");
    }
  }

  if (
    kanaCount > 0 &&
    /(?:的具体|具体身份|具体描述|具体史料|相关|资料|报道|团队|未涉及|未在|更强调|则)/.test(
      text
    )
  ) {
    score += 3;
    reasons.push("mixed-ja-cn");
  }

  const japaneseDampeners = [
    /している/,
    /していない/,
    /される/,
    /では/,
    /には/,
    /から/,
    /まで/,
    /として/,
    /について/,
    /という/,
    /こと/,
    /もの/,
    /具体的な/,
    /政治的に/,
    /歴史的背景/,
    /象徴的意味/,
    /多角的な/,
    /に関する/,
    /を強調/,
    /に言及/,
    /が追加/,
    /を説明/
  ];
  japaneseDampeners.forEach((pattern) => {
    if (pattern.test(text)) score -= 1;
  });

  return { score: Math.max(0, score), reasons };
}

function countMatches(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

function normalizeScore(input: unknown, fallback: number) {
  const score = Number(input);
  return Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : fallback;
}

function normalizeStringArray(input: unknown, fallback: string[]) {
  if (!Array.isArray(input)) return fallback;
  const items = input
    .map((item) => String(item).trim())
    .filter(Boolean)
    .filter((item) => !/差分なし|特になし|なし|見られない|確認できない/.test(item))
    .slice(0, 5);
  return items.length ? items : fallback;
}

function cleanSentence(input: unknown, fallback: string) {
  const text = String(input ?? "").trim();
  return text ? normalizeJapaneseUiText(text) : fallback;
}

function normalizeJapaneseUiText(input: string) {
  const text = input
    .replace(/“([^”]+)”/g, "「$1」")
    .replace(/"([^"]+)"/g, "「$1」")
    .replace(/（CN）|\(CN\)/g, "（中国語版）")
    .replace(/（JP）|\(JP\)/g, "（対象言語版）")
    .replace(/具体提及/g, "具体的に言及")
    .replace(/未提及/g, "言及していない")
    .replace(/中国强调/g, "中国語版は")
    .replace(/日本强调/g, "対象言語版は")
    .replace(/军演/g, "軍事演習")
    .replace(/细节/g, "詳細")
    .replace(/威胁/g, "脅威")
    .replace(/首次/g, "初使用")
    .replace(/具体时间/g, "具体的な時点")
    .replace(/导弹/g, "導弾")
    .replace(/再军事化/g, "再軍事化")
    .replace(/加速/g, "加速")
    .replace(/肩并肩/g, "肩を並べて")
    .replace(/新型军国主义/g, "新型軍国主義")
    .trim();

  return text;
}
