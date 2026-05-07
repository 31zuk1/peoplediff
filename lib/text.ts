import crypto from "node:crypto";

const KEYWORD_HINTS = [
  "台湾",
  "台独",
  "台獨",
  "頼清徳",
  "赖清德",
  "外交部",
  "国台办",
  "国務院",
  "人民銀行",
  "逆回购",
  "逆回購",
  "制裁",
  "キューバ",
  "米国",
  "美国",
  "日本",
  "中国",
  "軍事",
  "军事",
  "ミサイル",
  "防衛",
  "安全保障",
  "経済",
  "经济",
  "消費",
  "消费",
  "輸出",
  "税収",
  "税收",
  "五一",
  "労働節",
  "文旅",
  "観光",
  "文化",
  "科学技術",
  "科技",
  "長江",
  "科学調査船",
  "アリペイ",
  "投資",
  "投资",
  "外交",
  "政治"
];

export function stableId(input: string) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function cleanText(input: string) {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(input: string, max = 3600) {
  const text = cleanText(input);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function compactSummary(body: string, length = 180) {
  const text = cleanText(body).replace(/\n/g, " ");
  if (!text) return "本文を取得できませんでした。";
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

export function normalizeForMatch(input: string) {
  return input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/人民網|人民网|日本語版|写真|動画|速報|詳報|ニュース/g, "")
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}]+/gu, "")
    .trim();
}

export function charNgrams(input: string, size = 2) {
  const normalized = normalizeForMatch(input);
  if (normalized.length <= size) return normalized ? [normalized] : [];

  const grams: string[] = [];
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.push(normalized.slice(index, index + size));
  }
  return grams;
}

export function jaccard(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;

  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  return intersection / (left.size + right.size - intersection);
}

export function extractKeywords(text: string, max = 8) {
  const source = text.normalize("NFKC");
  const counts = new Map<string, number>();

  for (const hint of KEYWORD_HINTS) {
    if (source.includes(hint)) {
      counts.set(hint, 100 + (counts.get(hint) ?? 0));
    }
  }

  const chunks =
    source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーA-Za-z0-9]{2,18}/gu) ??
    [];

  for (const chunk of chunks) {
    const keyword = normalizeKeyword(chunk);
    if (!keyword) continue;
    counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([keyword]) => keyword);
}

export function keywordOverlap(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left.map(normalizeForMatch).filter(Boolean));
  const b = new Set(right.map(normalizeForMatch).filter(Boolean));
  let hits = 0;

  for (const keyword of a) {
    if (b.has(keyword)) hits += 1;
  }

  return hits / Math.max(a.size, b.size, 1);
}

function normalizeKeyword(input: string) {
  const keyword = input
    .replace(/人民網|人民网|日本語版|写真|動画|速報|詳報|ニュース|ホーム|新着/g, "")
    .replace(/^[\d.]+$/, "")
    .trim();

  if (keyword.length < 2 || keyword.length > 12) return "";
  if (/\d/.test(keyword)) return "";
  if (/(する|した|された|行われた|おいて|について|による|として|から|まで|あり|提供)/.test(keyword)) {
    return "";
  }

  return keyword;
}
