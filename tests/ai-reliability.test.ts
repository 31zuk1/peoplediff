import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { analyzeDifference, askJson, enrichArticle } from "../lib/openai";
import {
  buildRefreshRunMetadata,
  classifyOpenAiError,
  createRefreshTelemetryState,
  getOpenAiWarnings,
  recordOpenAiCacheHit,
  withRefreshTelemetry
} from "../lib/telemetry";
import type { Article } from "../lib/types";

const messages = [{ role: "user", content: "Return JSON" }] as const;

function fakeClient(response: () => Response) {
  let requests = 0;
  const client = new OpenAI({
    apiKey: "synthetic-test-key",
    fetch: (async () => {
      requests += 1;
      return response();
    }) as NonNullable<ConstructorParameters<typeof OpenAI>[0]>["fetch"]
  });
  return { client, requestCount: () => requests };
}

function completion(content: string, finishReason = "stop") {
  return Response.json({
    id: "synthetic-completion",
    object: "chat.completion",
    created: 0,
    model: "gpt-4.1-nano",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 20, completion_tokens: 10 }
  });
}

function configuredState() {
  const state = createRefreshTelemetryState();
  state.openaiConfigured = true;
  return state;
}

for (const failure of [
  { status: 429, code: "credit_balance_exhausted", category: "quota" },
  { status: 429, code: "insufficient_quota", category: "quota" },
  { status: 401, code: "invalid_api_key", category: "authentication" }
]) {
  test(`${failure.code}: stop further requests and publish only safe diagnostics`, async () => {
    const secret = "synthetic-private-error-content";
    const transport = fakeClient(() => Response.json({
      error: { message: secret, code: failure.code, type: "test_error" }
    }, { status: failure.status }));
    const state = configuredState();
    await withRefreshTelemetry(state, async () => {
      for (let index = 0; index < 12; index += 1) {
        await assert.rejects(askJson(transport.client, [...messages]));
      }
    });
    const warnings = getOpenAiWarnings(state);
    const run = buildRefreshRunMetadata(state, warnings.length);
    assert.equal(transport.requestCount(), 1, "SDK retries must not multiply permanent errors");
    assert.equal(run.openaiAttempts, 1);
    assert.equal(run.openaiFailures, 1);
    assert.equal(run.openaiSkipped, 11);
    assert.equal(run.openaiCalls, 0);
    assert.equal(run.estimatedOpenAiCostUsd, 0);
    assert.equal(run.openaiStatus, "unavailable");
    assert.deepEqual(run.openaiErrors, [{ category: failure.category, status: failure.status, count: 1 }]);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify({ run, warnings }), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify({ run, warnings }), /synthetic-test-key/);
  });
}

test("a new refresh can recover after credits are restored; concurrent runs remain isolated", async () => {
  const failing = fakeClient(() => Response.json({ error: {
    code: "project_spend_limit_exceeded", type: "insufficient_quota", message: "private"
  } }, { status: 429 }));
  const healthy = fakeClient(() => completion('{"ok":true}'));
  const failedState = configuredState();
  const healthyState = configuredState();
  await Promise.all([
    withRefreshTelemetry(failedState, async () => {
      await assert.rejects(askJson(failing.client, [...messages]));
      await assert.rejects(askJson(failing.client, [...messages]));
    }),
    withRefreshTelemetry(healthyState, async () => {
      assert.deepEqual(await askJson(healthy.client, [...messages]), { ok: true });
      recordOpenAiCacheHit();
    })
  ]);
  assert.equal(buildRefreshRunMetadata(failedState, 1).openaiStatus, "unavailable");
  const healthyRun = buildRefreshRunMetadata(healthyState, 0);
  assert.equal(healthyRun.openaiStatus, "ok");
  assert.equal(healthyRun.openaiAttempts, 1);
  assert.equal(healthyRun.openaiCalls, 1);
  assert.equal(healthyRun.openaiCacheHits, 1);
  assert.equal(healthyRun.openaiFailures, 0);
  const recoveredState = configuredState();
  await withRefreshTelemetry(recoveredState, () => askJson(healthy.client, [...messages]));
  assert.equal(buildRefreshRunMetadata(recoveredState, 0).openaiStatus, "ok");
});

test("invalid or truncated model JSON is a visible failure while consumed tokens are retained", async () => {
  for (const [content, finishReason] of [["{}", "stop"], ["not JSON", "stop"], ['{"ok":true}', "length"]]) {
    const transport = fakeClient(() => completion(content, finishReason));
    const state = configuredState();
    await withRefreshTelemetry(state, () => assert.rejects(askJson(transport.client, [...messages])));
    const run = buildRefreshRunMetadata(state, 1);
    assert.equal(run.openaiCalls, 0);
    assert.equal(run.openaiFailures, 1);
    assert.equal(run.openaiErrors?.[0].category, "invalid_response");
    assert.equal(run.openaiInputTokens, 20);
    assert.equal(run.openaiOutputTokens, 10);
    assert.ok(run.estimatedOpenAiCostUsd > 0);
  }
});

test("malformed schemas are rejected, and repeated transient errors have a bounded request budget", async () => {
  const transport = fakeClient(() => completion('{"summary":42}'));
  const state = configuredState();
  await withRefreshTelemetry(state, async () => {
    for (let index = 0; index < 9; index += 1) {
      await assert.rejects(askJson(transport.client, [...messages], {
        validate: (input) => typeof input.summary === "string"
      }));
    }
  });
  const run = buildRefreshRunMetadata(state, 1);
  assert.equal(transport.requestCount(), 3);
  assert.equal(run.openaiAttempts, 3);
  assert.equal(run.openaiFailures, 3);
  assert.equal(run.openaiSkipped, 6);
});

test("unavailable AI cannot infer framing or overturn topic matches from unequal body lengths", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const cn: Article = {
      id: "synthetic-cn", source: "CN", title: "演習開始", url: "https://example.test/cn",
      body: "演習の詳細。".repeat(3000), summary: "中国語の原文要約", keywords: ["演习", "海军"]
    };
    const jp: Article = {
      id: "synthetic-jp", source: "JP", title: "演習開始", url: "https://example.test/jp",
      body: "演習を開始。", summary: "日本語の原文要約", keywords: ["演習", "海軍"]
    };
    const analysis = await analyzeDifference(cn, jp);
    assert.equal(analysis.analysisStatus, "unavailable");
    assert.equal(analysis.sameTopic, undefined);
    assert.equal(analysis.matchConfidence, undefined);
    assert.equal(analysis.bodyDifferenceScore, 0);
    assert.equal(analysis.framingShiftScore, 0);
    assert.deepEqual(analysis.missingPoints, []);
    assert.deepEqual(analysis.emphasizedPoints, []);
    assert.match(analysis.toneDifference, /未分析/);
    assert.equal((await enrichArticle(cn)).enrichmentStatus, "heuristic");
    const state = createRefreshTelemetryState();
    assert.equal(buildRefreshRunMetadata(state, 1).openaiStatus, "disabled");
    assert.match(getOpenAiWarnings(state)[0], /未分析/);
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("provider error messages are never used as diagnostic categories", () => {
  assert.deepEqual(classifyOpenAiError({ status: 429, type: "insufficient_quota", message: "secret" }), {
    category: "quota", status: 429
  });
  assert.deepEqual(classifyOpenAiError({ status: 500, code: "secret", message: "secret" }), {
    category: "server", status: 500
  });
});
