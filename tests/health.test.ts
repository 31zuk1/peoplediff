import test from "node:test";
import assert from "node:assert/strict";
import { snapshotHealth, assertUsableCollection } from "../lib/health";
import { collectionMode } from "../lib/collection-mode";
import type { Article, RefreshResult, ScrapeCoverage } from "../lib/types";

function fixture(): RefreshResult {
  const a: Article = { id: "cn", source: "CN", title: "example", url: "https://example.com/cn", publishedDate: "2026-10-06", body: "body", summary: "", keywords: [] };
  return {
    generatedAt: "2026-10-07T02:00:00Z", mode: "live", model: "configured-model",
    dateScope: ["2026-10-06"], cnArticles: [a], jpArticles: [{ ...a, id: "jp", source: "JP" }], pairs: [], warnings: [],
    stats: { cnCount: 1, jpCount: 1, cnDateCounts: { "2026-10-06": 1 }, jpDateCounts: { "2026-10-06": 1 }, dateMismatches: 0, matched: 0, cnOnly: 1, jpOnly: 1, framingShift: 0, bodyDifference: 0, coverageRatio: 0 },
    run: { runId: "test", durationMs: 1000, warningCount: 0, openaiCalls: 0, openaiInputTokens: 0, openaiOutputTokens: 0, estimatedOpenAiCostUsd: 0, storageBackend: "file" }
  };
}
function coverage(): ScrapeCoverage {
  return { attemptedPages: 2, successfulPages: 2, failedPages: 0, listingParseFailureCount: 0, candidateCount: 0, selectedCount: 0, articleCount: 0, bodyFailureCount: 0, articleLimitReached: false, pageLimitReached: false, requestedDates: ["2026-10-01"], datesWithArticles: [], emptyDates: ["2026-10-01"] };
}
const now = new Date("2026-10-07T03:00:00Z");

test("legacy zero-success archives are not presented as healthy AI analysis", () => {
  const health = snapshotHealth(fixture(), { now });
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.issues.map((i) => i.code), ["ai_unverified", "no_matches"]);
  assert.equal(health.latestArticleDate, "2026-10-06");
});

test("missing archives are different from a successfully collected empty day", () => {
  const data = fixture();
  const health = snapshotHealth(data, { now, expectedDates: ["2026-10-06", "2026-10-05"] });
  assert.deepEqual(health.missingDates, ["2026-10-05"]);
  data.collection = { JP: coverage() };
  assert.doesNotThrow(() => assertUsableCollection(data));
});

test("failed or truncated empty collections cannot overwrite an archive", () => {
  for (const patch of [{ failedPages: 1 }, { listingParseFailureCount: 1 }, { bodyFailureCount: 1 }, { pageLimitReached: true }, { articleLimitReached: true }]) {
    const data = fixture(); data.collection = { JP: { ...coverage(), ...patch } };
    assert.throws(() => assertUsableCollection(data));
  }
});

test("body fetch placeholders cannot replace working article bodies", () => {
  const data = fixture();
  data.collection = { JP: { ...coverage(), selectedCount: 2, articleCount: 2, bodyFailureCount: 2 } };
  assert.throws(() => assertUsableCollection(data));
});

test("historical snapshots do not show a false freshness alarm", () => {
  const data = fixture(); data.generatedAt = "2026-05-01T00:00:00Z";
  assert(snapshotHealth(data, { now }).issues.some((i) => i.code === "stale_snapshot"));
  assert(!snapshotHealth(data, { now, historical: true }).issues.some((i) => i.code === "stale_snapshot"));
});

test("AI failures remain visible when one of the calls succeeded", () => {
  const data = fixture(); data.run = { ...data.run!, openaiCalls: 1, openaiFailures: 1, openaiStatus: "degraded" };
  assert(snapshotHealth(data, { now }).issues.some((i) => i.code === "ai_failed"));
});

test("existing broad archives remain the default; the focused mode is explicit", () => {
  assert.equal(collectionMode(undefined), "broad");
  assert.equal(collectionMode("jp-major"), "jp-major");
  assert.equal(collectionMode("unknown", "broad"), "broad");
});

test("mixed legacy diagnostics are unverified rather than invented AI failures", () => {
  const data = fixture(); data.run = { ...data.run!, openaiCalls: 1, openaiFailures: 0, openaiStatus: "degraded" };
  const issues = snapshotHealth(data, { now }).issues;
  assert(issues.some((i) => i.code === "ai_unverified"));
  assert(!issues.some((i) => i.code === "ai_failed"));
});
