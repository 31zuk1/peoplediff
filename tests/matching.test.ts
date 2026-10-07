import assert from "node:assert/strict";
import test from "node:test";
import { eventEvidenceScore, matchArticles, rankMatchCandidates } from "../lib/matcher";
import { calculateStats, enrichPairs, matchArticlePairs, refreshOptionsSignature } from "../lib/compare";
import type { Article, ArticlePair } from "../lib/types";

function article(id: string, source: "CN" | "JP", title: string, body: string, extra: Partial<Article> = {}): Article {
  return { id, source, title, body, summary: body, keywords: [], url: `https://example.test/${id}`, publishedDate: "2026-03-03", ...extra };
}

// Synthetic facts, deliberately different from production articles.
const portCn = article("cn-port", "CN", "北海港单船装卸量刷新纪录", "3月2日，北海港完成31234标箱装卸作业。");
const portJp = article("jp-port", "JP", "北海港のコンテナ取扱量が記録を更新", "3月2日、北海港で3万1234TEUの荷役が完了した。");

test("unit-aware body facts recover a bilingual match without translated titles or AI", () => {
  const pairs = matchArticles([portCn], [portJp]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].status, "MATCHED");
  assert.ok(pairs[0].matchScore >= 0.62);
});

test("an incidental topic in one summary does not veto a concrete shared event", () => {
  const cn = { ...portCn, summary: `${portCn.body} 铁路运输为港口发展提供支撑。` };
  assert.equal(matchArticles([cn], [portJp])[0].status, "MATCHED");
});

test("two independent small counts identify a resolution across script variants", () => {
  const cn = article("resolution-cn", "CN", "人权理事会通过无障碍决议", "人权理事会第71届会议通过31国提出的决议。");
  const jp = article("resolution-jp", "JP", "人権理事会がバリアフリー決議を採択", "人権理事会の第71回会合で31ヶ国が提起した決議を採択した。");
  assert.ok(eventEvidenceScore(cn, jp) >= 0.62);
  assert.equal(matchArticles([cn], [jp])[0].status, "MATCHED");
});

test("multiple independent numerical facts recover a release with completely retitled headlines", () => {
  const cn = article("release-cn", "CN", "月度报告发布", "3月2日，交通运输部公布14250人、12.3%、9300人、14.5%、1450人、2.7%的数据。");
  const jp = article("release-jp", "JP", "各地の移動者数が増加", "3月2日、交通運輸部が14250人、12.3%、9300人、14.5%、1450人、2.7%と発表した。");
  assert.equal(eventEvidenceScore(cn, jp), 0.78);
  assert.equal(matchArticles([cn], [jp])[0].status, "MATCHED");
  assert.equal(eventEvidenceScore(cn, { ...jp, body: jp.body.replace("3月2日", "3月1日") }), 0);
});

test("generic country, holiday, publication date and numbers are insufficient", () => {
  const cn = article("generic-cn", "CN", "中国国庆经济发展", "2026年3月3日。收入31234元，第71届活动由31国参加。");
  const jp = article("generic-jp", "JP", "中国の国慶節と経済発展", "2026年3月3日。売上31234元。第71回の会議には31ヶ国が参加。");
  assert.equal(eventEvidenceScore(cn, jp), 0);
  assert.equal(matchArticles([cn], [jp]).filter((pair) => pair.status === "MATCHED").length, 0);
});

test("same numeric value with different units is not event evidence", () => {
  const cn = { ...portCn, body: "北海港は31234人の雇用を創出した。" };
  assert.equal(eventEvidenceScore(cn, portJp), 0);
});

test("year, month and day numbers do not become quantitative match anchors", () => {
  const cn = { ...portCn, body: "2026年3月3日，北海港今天发布公告。" };
  const jp = { ...portJp, body: "2026年3月3日、北海港が発表した。" };
  assert.equal(eventEvidenceScore(cn, jp), 0);
});

test("numerical evidence does not link repeated reports from distant dates", () => {
  assert.equal(eventEvidenceScore(portCn, { ...portJp, publishedDate: "2026-04-03" }), 0);
});

test("a shared four-character name and action remain AI candidates rather than automatic matches", () => {
  const cn = article("case-cn", "CN", "司马弘毅侵闯使馆案件开庭", "3月2日，法院审理该案。");
  const jp = article("case-jp", "JP", "司馬弘毅による大使館侵入事件の裁判", "3月2日、裁判が開かれた。");
  assert.equal(eventEvidenceScore(cn, jp), 0);
  assert.equal(eventEvidenceScore(cn, { ...jp, body: "3月1日、別の裁判が開かれた。" }), 0);
  assert.equal(eventEvidenceScore(cn, { ...jp, title: "司馬弘毅による大使館の建設計画" }), 0);
});

const falsePositiveCases: Array<[string, string, string, string, string]> = [
  ["round counts on different dates", "北海港举行消防演练", "3月2日，北海港共有1000人参加消防演练。", "北海港で求人説明会", "3月1日、北海港で1000人が求人説明会に参加した。"],
  ["round counts for different actions on the same date", "北海港招聘千人", "3月2日，北海港宣布招聘1000人。", "北海港で観光客が増加", "3月2日、北海港に1000人の観光客が訪れた。"],
  ["different event years", "司马弘毅侵闯使馆案件开庭", "2025年3月2日，法院审理该案。", "司馬弘毅による大使館侵入事件の裁判", "2026年3月2日、別の裁判が開かれた。"],
  ["generic institution and action with different people", "赵甲因大使馆侵闯被拘束", "3月2日，赵甲进入甲国大使馆。", "李乙が大使館侵入で拘束", "3月2日、李乙が乙国大使館で拘束された。"],
  ["trillion versus ten-thousand scale", "北海港项目工程投资", "3月2日，北海港项目总投资2万亿元。", "北海港の工事費", "3月2日、北海港の工事費は2万元となった。"],
  ["precise quantities in different event years", portCn.title, "2025年3月2日，北海港完成31234标箱装卸作业。", portJp.title, "2026年3月2日、北海港で3万1234TEUの荷役が完了した。"],
  ["the same publication dateline with different event dates", "司马弘毅侵闯使馆案件开庭", "新华社3月3日电。3月2日，法院审理司马弘毅侵闯使馆案。", "司馬弘毅による大使館侵入事件の裁判", "3月3日配信。3月1日、司馬弘毅の別の事件を審理した。"],
  ["the same publication dateline cannot corroborate conflicting numeric events", portCn.title, "新华社3月3日电。3月2日，北海港完成31234标箱装卸作业。", portJp.title, "3月3日配信。3月1日、北海港で3万1234TEUの荷役が完了した。"],
  ["round container counts without independent evidence", portCn.title, "3月2日，北海港完成1000标箱装卸作业。", portJp.title, "3月2日、北海港で1000TEUの荷役が完了した。"]
];

for (const [name, cnTitle, cnBody, jpTitle, jpBody] of falsePositiveCases) {
  test(`does not auto-match ${name}`, () => {
    const cn = article(`negative-cn-${name}`, "CN", cnTitle, cnBody);
    const jp = article(`negative-jp-${name}`, "JP", jpTitle, jpBody);
    assert.equal(eventEvidenceScore(cn, jp), 0);
    assert.equal(matchArticles([cn], [jp]).filter((pair) => pair.status === "MATCHED").length, 0);
  });
}

test("different publication datelines do not hide the same explicitly dated event", () => {
  const cn = { ...portCn, body: `新华社3月3日电。${portCn.body}` };
  const jp = { ...portJp, body: `3月4日配信。${portJp.body}` };
  assert.ok(eventEvidenceScore(cn, jp) >= 0.62);
});

test("identical translated headlines cannot override explicit conflicting event years", () => {
  const cn = { ...portCn, translatedTitle: "北海港でコンテナ取扱記録を更新", body: "2025年3月2日、北海港で31234TEUを取り扱った。" };
  const jp = { ...portJp, translatedTitle: cn.translatedTitle, body: "2026年3月2日、北海港で31234TEUを取り扱った。" };
  assert.equal(matchArticles([cn], [jp]).filter((pair) => pair.status === "MATCHED").length, 0);
});

test("concrete body evidence puts the real story ahead of generic title candidates", () => {
  const distractors = Array.from({ length: 8 }, (_, i) => article(`distractor-${i}`, "CN", "北海港单船运输发展", "运输发展取得新的成果。"));
  const candidates = rankMatchCandidates([...distractors, portCn], portJp, { limit: 7, minScore: 0.08 });
  assert.equal(candidates[0].base.id, portCn.id);
});

test("body recall can propose a candidate without auto-matching unrelated headlines", () => {
  const cn = article("recall-cn", "CN", "南湖试验基地今日竣工", "3月2日。星海研究基地、中央制御室、測定技術研究室の設備を紹介した。");
  const jp = article("recall-jp", "JP", "都市圏で新研究施設が稼働", "3月2日。星海研究基地、中央制御室、測定技術研究室の設備を紹介した。");
  assert.equal(rankMatchCandidates([cn], jp, { minScore: 0.08 }).length, 1);
  assert.equal(matchArticles([cn], [jp]).filter((pair) => pair.status === "MATCHED").length, 0);
});

test("an unavailable adjudicator falls back to conservative matching", async () => {
  let calls = 0;
  const pairs = await matchArticlePairs([portCn], [portJp], 10, async () => { calls++; return undefined; });
  assert.equal(calls, 1);
  assert.equal(pairs.filter((pair) => pair.status === "MATCHED").length, 1);
});

test("the AI limit also bounds difference analysis and zero fully disables it", async () => {
  const pair = matchArticles([portCn], [portJp])[0];
  const pairs = [pair, { ...pair, id: "second-pair", matchScore: 0.6 }];
  const calls: boolean[] = [];
  const analyze = async (_base: Article, _target: Article, options: { useAi?: boolean } = {}) => {
    calls.push(options.useAi === true);
    return { analysisStatus: "unavailable" as const, cnPoints: [], jpPoints: [], missingPoints: [], emphasizedPoints: [], toneDifference: "", politicalLanguage: "", verdict: "", shiftScore: 0 };
  };
  await enrichPairs(pairs, 1, analyze);
  assert.equal(calls.filter(Boolean).length, 1);
  calls.length = 0;
  await enrichPairs(pairs, 0, analyze);
  assert.equal(calls.filter(Boolean).length, 0);
  assert.notEqual(refreshOptionsSignature({ useAi: true }), refreshOptionsSignature({ useAi: false }));
});

test("an explicit AI rejection is retained instead of overridden by fallback", async () => {
  const pairs = await matchArticlePairs([portCn], [portJp], 10, async () => ({ sameTopic: false, baseId: undefined, matchConfidence: 90, reason: "Different incident" }));
  assert.equal(pairs.filter((pair) => pair.status === "MATCHED").length, 0);
  assert.equal(pairs.length, 2);
});

test("a malformed AI selection cannot suppress an otherwise valid local pair", async () => {
  const pairs = await matchArticlePairs([portCn], [portJp], 10, async () => ({ sameTopic: true, baseId: "not-a-candidate", matchConfidence: 90, reason: "Invalid selection" }));
  assert.equal(pairs.filter((pair) => pair.status === "MATCHED").length, 1);
});

test("one source article is used at most once", () => {
  const secondTarget = { ...portJp, id: "second-jp" };
  const pairs = matchArticles([portCn], [portJp, secondTarget]);
  assert.equal(pairs.filter((pair) => pair.status === "MATCHED").length, 1);
  assert.equal(pairs.filter((pair) => pair.status === "JP ONLY").length, 1);
});

test("body length alone never creates a difference badge in stats", () => {
  const pair: ArticlePair = {
    ...matchArticles([portCn], [portJp])[0],
    base: { ...portCn, body: "長".repeat(10000) },
    cn: { ...portCn, body: "長".repeat(10000) }
  };
  assert.equal(calculateStats([pair], 1, 1).bodyDifference, 0);
});
