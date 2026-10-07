import type { RefreshResult } from "@/lib/types";
import { snapshotHealth } from "@/lib/health";

export default function SnapshotStatus({ data }: { data: RefreshResult }) {
  const health = data.health ?? snapshotHealth(data, { historical: Boolean(data.activeDate) });
  const dates = [...new Set([...(data.dateScope ?? []), ...health.missingDates])].sort().reverse();
  const target = data.targetLanguage ?? "JP";
  const run = data.run;
  const aiLabel = run?.openaiStatus === "ok" ? "AI分析あり"
    : run?.openaiStatus === "disabled" ? "AI分析無効"
    : run?.openaiStatus === "unused" ? "AI処理なし"
    : run?.openaiStatus === "unavailable" || (run?.openaiFailures ?? 0) > 0 ? "AI分析に失敗あり"
    : run?.openaiStatus === "degraded" ? "AI状態に未確認あり"
    : (run?.openaiCalls ?? 0) > 0 ? "AI成功記録あり" : "AI状態未確認";
  return (
    <section aria-label="収集と分析の状態" className="rounded border border-white/10 bg-white/[0.025] px-4 py-3 text-sm">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-slate-300">
        <span className="font-semibold">{health.status === "empty" ? "保存データなし" : health.status === "degraded" ? "確認が必要" : "収集状態に警告なし"}</span>
        <span>最新記事 {health.latestArticleDate ?? "なし"}</span>
        <span>{aiLabel}</span>
        {run?.openaiAttempts !== undefined ? <span>試行 {run.openaiAttempts} / 成功 {run.openaiCalls} / 失敗 {run.openaiFailures ?? 0} / 再利用 {run.openaiCacheHits ?? 0}</span> : null}
      </div>
      {health.issues.length ? <ul className="mt-2 space-y-1 text-amber-200" role="status">
        {health.issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}
      </ul> : null}
      {dates.length ? <details className="mt-3 text-slate-400">
        <summary className="cursor-pointer text-xs">日別の収集件数・保存日時（日本時間）</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead><tr className="border-b border-white/10"><th className="py-2">記事の日付</th><th>CN</th><th>{target}</th><th>保存日時</th></tr></thead>
            <tbody>{dates.map((date) => <tr key={date} className="border-b border-white/5">
              <td className="py-2">{date}</td>
              <td>{health.missingDates.includes(date) ? "—" : data.stats.cnDateCounts[date] ?? 0}</td>
              <td>{health.missingDates.includes(date) ? "—" : (data.stats.dateCountsBySource?.[target] ?? data.stats.jpDateCounts)[date] ?? 0}</td>
              <td>{health.missingDates.includes(date) ? "未保存" : formatSaved(data.dailyUpdates?.[date] ?? data.generatedAt)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="mt-2 text-xs">件数は取得範囲内の値です。CN ONLY / {target === "JP" ? "JP ONLY" : "TARGET ONLY"} は収集範囲内で対応を検出できていない状態で、非掲載や削除の証拠ではありません。</p>
      </details> : null}
    </section>
  );
}

function formatSaved(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date) : "不明";
}
