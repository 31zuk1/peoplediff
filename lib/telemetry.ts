import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RefreshResult, RefreshRunMetadata } from "./types";

const OPENAI_PRICE_USD_PER_1M: Record<string, { input: number; output: number }> = {
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 }
};

type OpenAiUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
};

export type OpenAiErrorCategory =
  | "authentication"
  | "quota"
  | "rate_limit"
  | "configuration"
  | "timeout"
  | "network"
  | "server"
  | "invalid_response"
  | "unknown";

type OpenAiFailure = { category: OpenAiErrorCategory; status?: number };

const OPENAI_FAILURE_MESSAGES: Record<OpenAiErrorCategory, string> = {
  authentication: "認証に失敗しました。管理者によるAPI設定の確認が必要です。",
  quota: "利用クレジットまたは利用上限に達しています。管理者による残高・利用上限の確認が必要です。",
  rate_limit: "リクエスト上限に達したため、この更新でのAI処理を停止しました。",
  configuration: "モデルまたはリクエストの設定に問題があります。管理者による設定の確認が必要です。",
  timeout: "応答が制限時間内に返りませんでした。",
  network: "APIへの接続に失敗しました。",
  server: "APIサービスで一時的なエラーが発生しました。",
  invalid_response: "分析に必要な形式の応答を取得できませんでした。",
  unknown: "AI処理でエラーが発生しました。"
};

type RefreshTelemetryState = {
  runId: string;
  startedAt: number;
  openaiCalls: number;
  openaiConfigured: boolean;
  openaiAttempts: number;
  openaiFailures: number;
  openaiCacheHits: number;
  openaiSkipped: number;
  openaiCircuitOpen: boolean;
  openaiConsecutiveFailures: number;
  openaiErrors: Map<string, OpenAiFailure & { count: number }>;
  openaiInputTokens: number;
  openaiOutputTokens: number;
  openaiModelUsage: Map<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
};

const refreshTelemetry = new AsyncLocalStorage<RefreshTelemetryState>();

export function createRefreshTelemetryState(): RefreshTelemetryState {
  return {
    runId: randomUUID(),
    startedAt: Date.now(),
    openaiCalls: 0,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    openaiAttempts: 0,
    openaiFailures: 0,
    openaiCacheHits: 0,
    openaiSkipped: 0,
    openaiCircuitOpen: false,
    openaiConsecutiveFailures: 0,
    openaiErrors: new Map(),
    openaiInputTokens: 0,
    openaiOutputTokens: 0,
    openaiModelUsage: new Map()
  };
}

// The circuit is scoped to one refresh, so a fixed credential or renewed credit
// balance is automatically tried again on the next refresh.
export function beginOpenAiAttempt() {
  const state = refreshTelemetry.getStore();
  if (!state) return true;
  if (state.openaiCircuitOpen) {
    state.openaiSkipped += 1;
    return false;
  }
  state.openaiAttempts += 1;
  return true;
}

export function recordOpenAiSuccess() {
  const state = refreshTelemetry.getStore();
  if (!state) return;
  state.openaiCalls += 1;
  state.openaiConsecutiveFailures = 0;
}

export function recordOpenAiCacheHit() {
  const state = refreshTelemetry.getStore();
  if (state) state.openaiCacheHits += 1;
}

export function recordOpenAiFailure(error: unknown) {
  const failure = classifyOpenAiError(error);
  const state = refreshTelemetry.getStore();
  if (!state) return failure;
  state.openaiFailures += 1;
  state.openaiConsecutiveFailures += 1;
  const key = `${failure.category}:${failure.status ?? ""}`;
  const previous = state.openaiErrors.get(key);
  state.openaiErrors.set(key, { ...failure, count: (previous?.count ?? 0) + 1 });
  if (
    ["authentication", "quota", "rate_limit", "configuration"].includes(failure.category) ||
    state.openaiConsecutiveFailures >= 3
  ) state.openaiCircuitOpen = true;
  return failure;
}

// Never publish error.message, headers, request bodies or provider-supplied text:
// authentication errors can contain a fragment of the API key.
export function classifyOpenAiError(error: unknown): OpenAiFailure {
  const details = error && typeof error === "object"
    ? error as { status?: unknown; code?: unknown; type?: unknown; name?: unknown }
    : {};
  const status = typeof details.status === "number" && Number.isInteger(details.status) &&
    details.status >= 400 && details.status <= 599 ? details.status : undefined;
  const code = typeof details.code === "string" ? details.code : "";
  const quotaCodes = new Set([
    "insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded", "organization_usage_limit_exceeded"
  ]);
  let category: OpenAiErrorCategory = "unknown";
  if (status === 401 || status === 403) category = "authentication";
  else if (quotaCodes.has(code) || details.type === "insufficient_quota") category = "quota";
  else if (status === 429) category = "rate_limit";
  else if (status === 400 || status === 404 || status === 422) category = "configuration";
  else if (status === 408 || details.name === "APIConnectionTimeoutError" || details.name === "TimeoutError") category = "timeout";
  else if (details.name === "APIConnectionError") category = "network";
  else if (status && status >= 500) category = "server";
  else if (details.name === "SyntaxError" || details.name === "InvalidOpenAiResponseError") category = "invalid_response";
  return { category, ...(status ? { status } : {}) };
}

export function getOpenAiWarnings(state: RefreshTelemetryState): string[] {
  if (!state.openaiConfigured) {
    return ["AI分析は無効です。記事の照合はルールに基づく暫定判定で、本文・論調差分は未分析です。"];
  }
  return [...new Set([...state.openaiErrors.values()].map(({ category }) =>
    `AI分析: ${OPENAI_FAILURE_MESSAGES[category]} 未処理の記事は暫定照合になり、本文・論調差分は未分析です。`
  ))];
}

export function withRefreshTelemetry<T>(
  state: RefreshTelemetryState,
  callback: () => Promise<T>
): Promise<T> {
  return refreshTelemetry.run(state, callback);
}

export function recordOpenAiCompletionUsage(model: string, usage?: OpenAiUsage | null) {
  const state = refreshTelemetry.getStore();
  if (!state) return;

  const inputTokens = tokenCount(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = tokenCount(usage?.completion_tokens ?? usage?.output_tokens);
  state.openaiInputTokens += inputTokens;
  state.openaiOutputTokens += outputTokens;

  const existing = state.openaiModelUsage.get(model) ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0
  };
  state.openaiModelUsage.set(model, {
    calls: existing.calls + 1,
    inputTokens: existing.inputTokens + inputTokens,
    outputTokens: existing.outputTokens + outputTokens
  });
}

export function buildRefreshRunMetadata(
  state: RefreshTelemetryState,
  warningCount: number,
  storageBackend = storageBackendLabel()
): RefreshRunMetadata {
  const durationMs = Math.max(0, Date.now() - state.startedAt);

  const openaiModelUsage = [...state.openaiModelUsage.entries()].map(([model, usage]) => ({
    model,
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: estimateOpenAiCostUsd(model, usage.inputTokens, usage.outputTokens)
  }));

  return {
    runId: state.runId,
    durationMs,
    warningCount,
    openaiCalls: state.openaiCalls,
    openaiAttempts: state.openaiAttempts,
    openaiFailures: state.openaiFailures,
    openaiCacheHits: state.openaiCacheHits,
    openaiSkipped: state.openaiSkipped,
    openaiStatus: !state.openaiConfigured ? "disabled"
      : state.openaiFailures > 0 ? state.openaiCalls + state.openaiCacheHits > 0 ? "degraded" : "unavailable"
      : state.openaiCalls + state.openaiCacheHits > 0 ? "ok" : "unused",
    openaiErrors: [...state.openaiErrors.values()],
    openaiInputTokens: state.openaiInputTokens,
    openaiOutputTokens: state.openaiOutputTokens,
    openaiModelUsage,
    estimatedOpenAiCostUsd: Number(
      openaiModelUsage
        .reduce((sum, usage) => sum + usage.estimatedCostUsd, 0)
        .toFixed(6)
    ),
    storageBackend
  };
}

export function logRefreshRun(snapshot: RefreshResult) {
  if (!snapshot.run) return;

  console.info(
    JSON.stringify({
      event: "peoplediff.refresh",
      generatedAt: snapshot.generatedAt,
      refreshSignature: snapshot.refreshSignature,
      mode: snapshot.mode,
      model: snapshot.model,
      baseLanguage: snapshot.baseLanguage,
      targetLanguage: snapshot.targetLanguage,
      activeDate: snapshot.activeDate,
      run: snapshot.run
    })
  );
}

function estimateOpenAiCostUsd(model: string, inputTokens: number, outputTokens: number) {
  const price = OPENAI_PRICE_USD_PER_1M[model] ?? OPENAI_PRICE_USD_PER_1M["gpt-4.1-nano"];
  const cost =
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output;
  return Number(cost.toFixed(6));
}

function storageBackendLabel() {
  const configured = process.env.PEOPLEDIFF_STORAGE?.trim().toLowerCase();
  if (configured === "blob") return "vercel-blob";
  if (!configured && process.env.BLOB_READ_WRITE_TOKEN?.trim()) return "vercel-blob";
  return process.env.PEOPLEDIFF_DATA_DIR ? "file:PEOPLEDIFF_DATA_DIR" : "file:data/snapshots";
}

function tokenCount(input: number | null | undefined) {
  return typeof input === "number" && Number.isFinite(input) ? Math.max(0, Math.round(input)) : 0;
}
