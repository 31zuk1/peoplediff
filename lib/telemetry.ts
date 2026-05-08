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

type RefreshTelemetryState = {
  runId: string;
  startedAt: number;
  openaiCalls: number;
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
    openaiInputTokens: 0,
    openaiOutputTokens: 0,
    openaiModelUsage: new Map()
  };
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
  state.openaiCalls += 1;
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
