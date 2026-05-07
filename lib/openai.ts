import OpenAI from "openai";
import type { Article, DifferenceAnalysis } from "./types";
import { compactSummary, extractKeywords, truncate } from "./text";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

let client: OpenAI | undefined;

function getClient() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export function activeModelLabel() {
  return process.env.OPENAI_API_KEY ? MODEL : "local-heuristic";
}

type EnrichOptions = {
  useAi?: boolean;
};

export async function enrichChineseArticle(
  article: Article,
  options: EnrichOptions = {}
): Promise<Article> {
  const openai = options.useAi === false ? undefined : getClient();
  if (!openai) {
    return {
      ...article,
      translatedTitle: article.title,
      summary: compactSummary(article.body, 180),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }

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
    ]);

    return {
      ...article,
      translatedTitle: json.translatedTitle || article.title,
      summary: json.summary || compactSummary(article.body, 180),
      keywords: sanitizeKeywords(json.keywords, article)
    };
  } catch {
    return {
      ...article,
      translatedTitle: article.title,
      summary: compactSummary(article.body, 180),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }
}

export async function enrichJapaneseArticle(
  article: Article,
  options: EnrichOptions = {}
): Promise<Article> {
  const openai = options.useAi === false ? undefined : getClient();
  if (!openai) {
    return {
      ...article,
      summary: compactSummary(article.body, 180),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }

  try {
    const json = await askJson<{ summary?: string; keywords?: string[] }>(openai, [
      {
        role: "system",
        content:
          "You are a Japanese media analysis assistant. Return compact JSON only."
      },
      {
        role: "user",
        content: `人民網日本語版の記事を分析用に整形してください。
JSON schema:
{
  "summary": "180字以内の日本語要約",
  "keywords": ["具体的な固有名詞", "具体的なテーマ", "地名"]
}
keywordsは照合に使うため、記事固有の語だけにしてください。「政策」「外交」「政治」「中国」「日本」のような汎用語は、それ自体が主題でない限り避けてください。

Title: ${article.title}
Body:
${truncate(article.body, 2600)}`
      }
    ]);

    return {
      ...article,
      summary: json.summary || compactSummary(article.body, 180),
      keywords: sanitizeKeywords(json.keywords, article)
    };
  } catch {
    return {
      ...article,
      summary: compactSummary(article.body, 180),
      keywords: article.keywords.length ? article.keywords : extractKeywords(article.body)
    };
  }
}

export async function analyzeDifference(
  cn: Article,
  jp: Article
): Promise<DifferenceAnalysis> {
  const fallback = localDifference(cn, jp);
  const openai = getClient();
  if (!openai) return fallback;

  try {
    const json = await askJson<Partial<DifferenceAnalysis>>(openai, [
      {
        role: "system",
        content:
          "You compare Chinese state media articles across language editions. First decide whether they are the same concrete news topic. Return Japanese JSON only. Be concise, analytical, and surface even small observable differences."
      },
      {
        role: "user",
        content: `中国語版と日本語版の同一話題らしい記事を比較してください。
次のJSON schemaだけを返してください:
{
  "sameTopic": true,
  "matchConfidence": 0,
  "bodyDifferenceScore": 0,
  "framingShiftScore": 0,
  "cnPoints": ["中国語版の要点"],
  "jpPoints": ["日本語版の要点"],
  "missingPoints": [],
  "emphasizedPoints": [],
  "toneDifference": "論調差分を1文",
  "politicalLanguage": "政治的表現の変化を1文",
  "verdict": "観測メモを1文",
  "shiftScore": 0
}
sameTopicは同一の具体的ニュース話題ならtrue。単に同じ分野、同じ国、同じ論調だけならfalse。
matchConfidenceは0-100。同一話題でない場合は30以下。
bodyDifferenceScoreは0-100。分量、具体情報、背景、引用、経歴、数値などの本文差が大きいほど高くしてください。
framingShiftScoreは0-100。価値判断、政治的表現、批判/称賛の向き、読者への見せ方が違うほど高くしてください。
shiftScoreはmax(bodyDifferenceScore, framingShiftScore)を入れてください。
重要: 差分観測UIなので、軽微でも本文から観測できる省略・追加・強調・圧縮はmissingPoints/emphasizedPointsに書いてください。
完全に同じと言える場合だけ空配列にしてください。
論調差が小さくても本文の具体情報量に差がある場合は、missingPoints/emphasizedPointsに具体的に書いてください。
差が軽微ならtoneDifferenceに「大きな論調差は限定的」と書きつつ、本文差分は別途列挙してください。
missingPointsは「中国語版にあり日本語版で欠落または明確に弱い論点」だけ。
emphasizedPointsは「日本語版で中国語版より明確に強調された論点」だけ。
各差分は「どちらに何がある/ないか」が分かる具体表現にしてください。

CN title: ${cn.title}
CN translated title: ${cn.translatedTitle || cn.title}
CN body:
${truncate(cn.body, 3200)}

JP title: ${jp.title}
JP body:
${truncate(jp.body, 3200)}`
      }
    ]);
    return normalizeDifference(json, fallback);
  } catch {
    return fallback;
  }
}

async function askJson<T>(
  openai: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Promise<T> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages
  });

  const content = completion.choices[0]?.message?.content || "{}";
  return JSON.parse(content) as T;
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
  const cnKeywords = cn.keywords.slice(0, 6);
  const jpKeywords = jp.keywords.slice(0, 6);
  const missing = cnKeywords.filter((keyword) => !jpKeywords.includes(keyword)).slice(0, 4);
  const emphasized = jpKeywords.filter((keyword) => !cnKeywords.includes(keyword)).slice(0, 4);
  const bodyGap = Math.abs(cn.body.length - jp.body.length);
  const bodyDifferenceScore = Math.min(70, Math.round(bodyGap / 180));
  const framingShiftScore = 0;
  const shiftScore = Math.max(bodyDifferenceScore, framingShiftScore);
  return {
    sameTopic: true,
    matchConfidence: Math.max(35, 100 - shiftScore),
    bodyDifferenceScore,
    framingShiftScore,
    cnPoints: [cn.summary],
    jpPoints: [jp.summary],
    missingPoints: missing.length ? missing : ["大きな欠落は限定的だが、本文の圧縮や省略の可能性があります。"],
    emphasizedPoints: emphasized.length ? emphasized : ["大きな追加強調は限定的です。"],
    toneDifference:
      shiftScore > 35
        ? "語彙と分量の差から、対外向け編集の可能性が高いペアです。"
        : "顕著な論調差は見られません。",
    politicalLanguage:
      "OPENAI_API_KEYを設定すると、政治的表現の変化を本文ベースで抽出します。",
    verdict: "ローカルヒューリスティックによる暫定判定です。",
    shiftScore
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
    sameTopic: input.sameTopic ?? fallback.sameTopic,
    matchConfidence: normalizeScore(input.matchConfidence, fallback.matchConfidence ?? 0),
    bodyDifferenceScore,
    framingShiftScore,
    cnPoints: normalizeStringArray(input.cnPoints, fallback.cnPoints),
    jpPoints: normalizeStringArray(input.jpPoints, fallback.jpPoints),
    missingPoints: normalizeStringArray(input.missingPoints, []),
    emphasizedPoints: normalizeStringArray(input.emphasizedPoints, []),
    toneDifference: cleanSentence(input.toneDifference, fallback.toneDifference),
    politicalLanguage: cleanSentence(input.politicalLanguage, fallback.politicalLanguage),
    verdict: cleanSentence(input.verdict, fallback.verdict),
    shiftScore
  };
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
  return text || fallback;
}
