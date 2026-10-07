// Reprocess an exported snapshot without scraping, charging for AI, or writing
// to the production archive. Outputs are deliberately explicit local paths.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RefreshResult } from "../lib/types";

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath)) {
    throw new Error("Usage: node --import tsx scripts/reanalyze-snapshot.ts <input.json> <different-output.json>");
  }
  process.env.OPENAI_API_KEY = "";
  const { matchArticlePairs, calculateStats } = await import("../lib/compare");
  const { analyzeDifference } = await import("../lib/openai");
  const { createRefreshTelemetryState, withRefreshTelemetry, buildRefreshRunMetadata } = await import("../lib/telemetry");
  const { snapshotHealth } = await import("../lib/health");
  const original: RefreshResult = JSON.parse(await readFile(inputPath, "utf8"));
  if (original.collectionMode === "jp-major") throw new Error("This recovery command accepts broad snapshots only.");
  const base = original.baseArticles ?? original.cnArticles;
  const target = original.targetArticles ?? original.jpArticles;
  if (!Array.isArray(base) || !Array.isArray(target)) throw new Error("Snapshot article arrays are required.");
  const telemetry = createRefreshTelemetryState();
  const result = await withRefreshTelemetry(telemetry, async () => {
    const pairs = await matchArticlePairs(base, target, 0);
    for (const pair of pairs) if (pair.base && pair.target) pair.analysis = await analyzeDifference(pair.base, pair.target);
    const snapshot: RefreshResult = {
      ...original, collectionMode: "broad", pairs,
      generatedAt: new Date().toISOString(), model: "local-heuristic",
      run: buildRefreshRunMetadata(telemetry, 1, "local-export"),
      baseArticles: base, targetArticles: target, cnArticles: base,
      targetDateScope: original.dateScope ?? original.targetDateScope,
      stats: calculateStats(pairs, base.length, target.length, original.baseLanguage ?? "CN", original.targetLanguage ?? "JP"),
      warnings: ["保存済み記事の再照合結果です。記事の再取得とAI差分分析は行っていません。"],
      activeDate: undefined, archiveDates: undefined, refreshSignature: undefined,
      anchoredPairs: undefined
    };
    snapshot.health = snapshotHealth(snapshot);
    return snapshot;
  });
  await writeFile(outputPath, JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ before: original.stats.matched, after: result.stats.matched, output: resolve(outputPath), aiCalls: result.run?.openaiCalls }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Reanalysis failed."); process.exitCode = 1; });
