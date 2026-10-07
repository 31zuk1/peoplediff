import assert from "node:assert/strict";
import test from "node:test";
import { createCronRefreshHandler } from "../app/api/cron/refresh/handler";
import { GET, POST } from "../app/api/refresh/route";
import { emptySnapshot, refreshOptionsSignature } from "../lib/compare";
import { refreshJapaneseMajorSnapshot } from "../lib/jp-major";
import type { RefreshResult, ScrapeCoverage } from "../lib/types";

async function withEnv(values: Record<string, string | undefined>, work: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await work();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const cronEnv = {
  CRON_SECRET: "synthetic-cron-secret",
  PEOPLEDIFF_CRON_MODE: undefined,
  PEOPLEDIFF_DEFAULT_MODE: undefined,
  PEOPLEDIFF_CRON_TARGETS: undefined,
  PEOPLEDIFF_CRON_ROLLING_DAYS: undefined,
  PEOPLEDIFF_CRON_LATEST_OFFSET: undefined
};

function cronRequest(query = "", authorized = true) {
  return new Request(`https://example.test/api/cron/refresh${query}`, {
    headers: authorized ? { authorization: `Bearer ${cronEnv.CRON_SECRET}` } : {}
  });
}

function snapshot(): RefreshResult {
  const result = emptySnapshot();
  return {
    ...result,
    mode: "live",
    model: "gpt-4.1-nano",
    generatedAt: "2026-10-06T16:08:00.000Z",
    collectionMode: "broad",
    dateScope: ["2026-10-06"],
    run: { ...result.run!, openaiStatus: "ok", openaiCalls: 1 }
  };
}

function coverage(overrides: Partial<ScrapeCoverage> = {}): ScrapeCoverage {
  return {
    attemptedPages: 1, successfulPages: 1, failedPages: 0, listingParseFailureCount: 0,
    candidateCount: 0, selectedCount: 0, articleCount: 0, bodyFailureCount: 0,
    pageLimitReached: false, articleLimitReached: false, requestedDates: ["2026-10-06"],
    datesWithArticles: [], emptyDates: ["2026-10-06"], ...overrides
  };
}

function cronHarness(result = snapshot()) {
  const calls: Array<{ mode: string; options: unknown }> = [];
  const writes: Array<{ updateLatest?: boolean }> = [];
  let releases = 0;
  const handler = createCronRefreshHandler({
    refreshSnapshot: async (options) => { calls.push({ mode: "broad", options }); return result; },
    refreshJapaneseMajorSnapshot: async (options) => { calls.push({ mode: "jp-major", options }); return result; },
    writeSnapshot: async (value, options) => { writes.push(options ?? {}); return value; },
    acquireSnapshotLock: async (name) => ({ name, release: async () => { releases += 1; } }),
    now: () => new Date("2026-10-06T16:08:00.000Z")
  });
  return { handler, calls, writes, releases: () => releases };
}

test("cron keeps broad as default and collects yesterday through seven days ago in JST", async () => {
  await withEnv(cronEnv, async () => {
    const harness = cronHarness();
    for (let offset = 0; offset < 7; offset += 1) {
      const response = await harness.handler(cronRequest(), offset);
      const body = await response.json();
      const expected = new Date(Date.UTC(2026, 9, 6 - offset)).toISOString().slice(0, 10);
      assert.equal(response.status, 200);
      assert.equal(body.collectionMode, "broad");
      assert.equal(body.targetDate, expected);
      assert.equal(body.updateLatest, offset === 0);
      assert.deepEqual((harness.calls[offset].options as { dates: string[] }).dates, [expected]);
    }
    assert.equal(harness.releases(), 7);
    assert.equal(harness.writes.filter((write) => write.updateLatest).length, 1);
  });
});

test("cron authentication blocks every refresh and explicit JP-major mode remains available", async () => {
  await withEnv({ ...cronEnv, PEOPLEDIFF_CRON_TARGETS: "JP,EN" }, async () => {
    const harness = cronHarness();
    assert.equal((await harness.handler(cronRequest("", false))).status, 401);
    assert.equal(harness.calls.length, 0);
    const response = await harness.handler(cronRequest("?mode=jp-major"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(harness.calls[0].mode, "jp-major");
    assert.deepEqual(body.targets, ["JP"]);
    assert.deepEqual(body.ignoredTargets, ["EN"]);
  });
});

test("cron reports degraded AI explicitly while preserving useful scraped data", async () => {
  await withEnv({ ...cronEnv, PEOPLEDIFF_CRON_AI_ARTICLE_LIMIT: "0" }, async () => {
    const data = snapshot();
    data.run = { ...data.run!, openaiStatus: "unavailable", openaiCalls: 0, openaiFailures: 1 };
    const harness = cronHarness(data);
    const response = await harness.handler(cronRequest());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "degraded");
    assert.equal(body.degraded, true);
    assert.equal(body.results[0].aiStatus, "unavailable");
    assert.equal(harness.writes.length, 1);
    assert.equal((harness.calls[0].options as { aiArticleLimit: number }).aiArticleLimit, 0);
  });
});

test("failed empty collections cannot erase archives; real empty publication days can be stored", async () => {
  await withEnv(cronEnv, async () => {
    const data = snapshot();
    data.collection = { JP: coverage({ failedPages: 1, successfulPages: 0 }) };
    const failed = cronHarness(data);
    assert.equal((await failed.handler(cronRequest())).status, 500);
    assert.equal(failed.writes.length, 0);
    assert.equal(failed.releases(), 1);
    data.collection = { JP: coverage() };
    const empty = cronHarness(data);
    assert.equal((await empty.handler(cronRequest())).status, 200);
    assert.equal(empty.writes.length, 1);
  });
});

test("cron exceptions do not expose provider credentials", async () => {
  await withEnv(cronEnv, async () => {
    const handler = createCronRefreshHandler({
      acquireSnapshotLock: async () => { throw new Error("secret-test-provider-token"); }
    });
    const response = await handler(cronRequest());
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret-test-provider-token/);
  });
});

test("public GET rejects malformed and nonexistent dates before reading storage", async () => {
  for (const query of ["date=garbage", "date=2026-02-30", "dateFrom=2026-13-01", "dateTo=2026-01-00"]) {
    const response = await GET(new Request(`https://example.test/api/refresh?${query}`));
    assert.equal(response.status, 400);
  }
});

test("manual refresh preserves aiArticleLimit=0 and useAi=false in authorized in-flight requests", async () => {
  await withEnv({ PEOPLEDIFF_ADMIN_TOKEN: "synthetic-admin", PEOPLEDIFF_DEFAULT_MODE: undefined }, async () => {
    const existing = globalThis.__PEOPLEDIFF_REFRESH_INFLIGHT__;
    const data = snapshot();
    try {
      for (const options of [{ aiArticleLimit: 0 }, { useAi: false }]) {
        globalThis.__PEOPLEDIFF_REFRESH_INFLIGHT__ = new Map([[
          "broad:CN-JP", { signature: refreshOptionsSignature(options), promise: Promise.resolve(data) }
        ]]);
        const response = await POST(new Request("https://example.test/api/refresh", {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-admin" },
          body: JSON.stringify({ ...options, forceRefresh: true })
        }));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-peoplediff-cache"), "inflight");
      }
      const unauthorized = await POST(new Request("https://example.test/api/refresh", { method: "POST" }));
      assert.equal(unauthorized.status, 401);
    } finally {
      globalThis.__PEOPLEDIFF_REFRESH_INFLIGHT__ = existing;
    }
  });
});

test("JP-major keeps the requested empty date and respects explicit AI opt-out", async () => {
  await withEnv({ OPENAI_API_KEY: "synthetic-never-send", PEOPLEDIFF_AI_ARTICLE_LIMIT: undefined }, async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      assert.match(url, /^https:\/\/j\.people\.com\.cn\/95958\//);
      return new Response('<div class="j-d2tuwen"><div class="left"><div class="list"><h3><a href="/n3/2026/1005/c94474-99999999.html">取得日以前の記事タイトル</a></h3><div class="time">2026-10-05</div></div></div></div>', {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    };
    try {
      const result = await refreshJapaneseMajorSnapshot({ dates: ["2026-10-06"], useAi: false, maxPages: 1 });
      assert.deepEqual(result.dateScope, ["2026-10-06"]);
      assert.deepEqual(result.targetDateScope, ["2026-10-06"]);
      assert.equal(result.jpArticles.length, 0);
      assert.equal(result.run?.openaiAttempts, 0);
      assert.equal(result.run?.openaiStatus, "disabled");
      assert.equal(result.model, "local-heuristic");
      assert.equal(requests.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("JP-major does not enrich a collected article with AI when useAi is false", async () => {
  await withEnv({ OPENAI_API_KEY: "synthetic-never-send" }, async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.info;
    console.info = () => {};
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "search.people.cn") return Response.json({ data: { records: [] } });
      assert.equal(url.hostname, "j.people.com.cn");
      const html = url.pathname.includes("/95958/")
        ? '<div class="j-d2tuwen"><div class="left"><div class="list"><h3><a href="/n3/2026/1006/c94474-99999998.html">深圳港でコンテナ取扱記録</a></h3><div class="time">2026-10-06</div></div></div></div>'
        : '<h1>深圳港でコンテナ取扱記録</h1><article><p>深圳港では10月2日にコンテナ取扱量が過去最高となった。輸送効率の改善と航路の拡大を通じて港湾の輸送能力が拡大している。</p></article>';
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    };
    try {
      const result = await refreshJapaneseMajorSnapshot({ dates: ["2026-10-06"], useAi: false, maxPages: 1, maxQueries: 1 });
      assert.equal(result.jpArticles.length, 1);
      assert.equal(result.jpArticles[0].enrichmentStatus, "heuristic");
      assert.equal(result.run?.openaiAttempts, 0);
      assert.equal(result.run?.openaiStatus, "disabled");
    } finally {
      globalThis.fetch = originalFetch;
      console.info = originalLog;
    }
  });
});
