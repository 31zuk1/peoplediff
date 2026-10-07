import type { RefreshResult, SnapshotHealth } from "./types";

export function snapshotHealth(
  snapshot: RefreshResult,
  options: { now?: Date; expectedDates?: string[]; historical?: boolean } = {}
): SnapshotHealth {
  const issues: SnapshotHealth["issues"] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  const articles = [
    ...(snapshot.baseArticles ?? snapshot.cnArticles ?? []),
    ...(snapshot.targetArticles ?? snapshot.jpArticles ?? [])
  ];
  const latestArticleDate = articles.map((a) => a.publishedDate ?? a.urlDate ?? "").sort().at(-1) || undefined;
  const available = new Set(snapshot.dateScope ?? []);
  const missingDates = (options.expectedDates ?? []).filter((date) => !available.has(date));
  if (missingDates.length) add("missing_dates", `未保存の日付: ${missingDates.join("、")}。記事0件の日とは区別してください。`);
  const generated = Date.parse(snapshot.generatedAt);
  if (!options.historical && snapshot.mode !== "empty" &&
      (!Number.isFinite(generated) || (options.now ?? new Date()).getTime() - generated > 36 * 3600_000)) {
    add("stale_snapshot", "保存データの更新が36時間以上ありません。定期取得の状態を確認してください。");
  }
  const run = snapshot.run;
  if (run?.openaiStatus === "unavailable" || (run?.openaiFailures ?? 0) > 0) {
    add("ai_failed", "AI処理に失敗しています。記事の照合は継続しますが、未分析の本文・フレーミングは判定できません。");
  } else if (run?.openaiStatus === "degraded") {
    add("ai_unverified", "過去データの一部はAI処理の状態を確認できません。本文・論調の分析状態は記事ごとに確認してください。");
  } else if (articles.length && (run?.openaiStatus === "disabled" || snapshot.model === "local-heuristic")) {
    add("ai_disabled", "AI分析は無効です。自動照合と原文の比較を利用できます。");
  } else if (articles.length && run && run.openaiCalls === 0 && !run.openaiStatus) {
    add("ai_unverified", "この保存データにはAIの成功応答が記録されていません。失敗理由は旧データから確認できません。");
  }
  const baseCount = snapshot.baseArticles?.length ?? snapshot.cnArticles?.length ?? 0;
  const targetCount = snapshot.targetArticles?.length ?? snapshot.jpArticles?.length ?? 0;
  if (baseCount && targetCount && snapshot.stats.matched === 0) {
    add("no_matches", "両言語の記事を取得していますが、対応関係は0件です。共通の話題がないとは限りません。");
  }
  for (const [source, coverage] of Object.entries(snapshot.collection ?? {})) {
    if (coverage.failedPages || coverage.listingParseFailureCount || coverage.bodyFailureCount) {
      add(`collection_failed_${source}`, `${source}: 一覧または本文の取得に失敗があり、収集範囲が不完全です。`);
    }
    if (coverage.pageLimitReached || coverage.articleLimitReached) {
      add(`collection_capped_${source}`, `${source}: 取得上限に達しました。期間内の全記事を取得したとは限りません。`);
    }
  }
  return { status: snapshot.mode === "empty" ? "empty" : issues.length ? "degraded" : "ok", issues, latestArticleDate, missingDates };
}

// An empty day can be legitimate. Only reject an empty result with evidence of a
// failed or incomplete collection, so a failed scrape cannot erase good archives.
export function assertUsableCollection(snapshot: RefreshResult) {
  for (const [source, c] of Object.entries(snapshot.collection ?? {})) {
    if (c.selectedCount > 0 && c.bodyFailureCount >= c.selectedCount) {
      throw new Error(`${source}の本文を取得できなかったため、既存アーカイブを維持しました。`);
    }
    if (c.articleCount === 0 && (c.failedPages > 0 || c.listingParseFailureCount > 0 ||
        c.bodyFailureCount > 0 || c.pageLimitReached || c.articleLimitReached)) {
      throw new Error(`${source}の収集が不完全なため、空の結果でアーカイブを上書きしませんでした。`);
    }
  }
}
