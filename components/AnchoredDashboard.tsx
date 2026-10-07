"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleOff,
  FileText,
  Filter,
  Gauge,
  Languages,
  Moon,
  Search,
  Sun
} from "lucide-react";
import type {
  AnchoredArticlePair as RefreshAnchoredArticlePair,
  Article,
  ArticlePair,
  DifferenceAnalysis,
  PairStatus,
  RefreshResult,
  Source
} from "@/lib/types";
import StatusBadge from "./StatusBadge";
import SnapshotStatus from "./SnapshotStatus";
import CollectionModeLinks from "./CollectionModeLinks";

type AnchorStatusFilter = "ALL" | "MATCHED" | "UNMATCHED" | "DIFF";

type AnchoredMatchState = "matched" | "unmatched";

type LegacyPairExtension = {
  anchor?: Article;
  anchorArticle?: Article;
  jpArticle?: Article;
  cnArticle?: Article;
  matchedArticle?: Article;
  matched?: boolean;
  matchReason?: string;
  reason?: string;
  scoreReason?: string;
  match?: {
    score?: number;
    reason?: string;
    status?: AnchoredMatchState | "MATCHED" | "UNMATCHED";
  };
};

type LegacyAnchoredArticlePair = ArticlePair & LegacyPairExtension;

export type AnchoredSnapshot = {
  generatedAt?: string;
  mode?: RefreshResult["mode"] | "anchored";
  model?: string;
  baseLanguage?: Source;
  targetLanguage?: Source;
  anchorLanguage?: Source;
  dateScope?: string[];
  targetDateScope?: string[];
  baseArticles?: Article[];
  targetArticles?: Article[];
  cnArticles?: Article[];
  jpArticles?: Article[];
  pairs?: LegacyAnchoredArticlePair[];
  anchoredPairs?: RefreshAnchoredArticlePair[];
  stats?: Partial<RefreshResult["stats"]>;
  warnings?: string[];
};

export type AnchoredDashboardProps = {
  initialData: RefreshResult | AnchoredSnapshot;
  anchorLanguage?: Source;
  baseLanguage?: Source;
  className?: string;
};

type AnchorRow = {
  id: string;
  pair?: LegacyAnchoredArticlePair;
  pairStatus?: PairStatus;
  anchor: Article;
  cn?: Article;
  status: AnchoredMatchState;
  score: number;
  reason: string;
  analysis?: DifferenceAnalysis;
  highlights: string[];
};

const statusFilters: AnchorStatusFilter[] = ["ALL", "MATCHED", "UNMATCHED", "DIFF"];

const controlBase =
  "h-11 w-full min-w-0 rounded-md border border-white/10 bg-white/[0.04] text-sm text-white outline-none transition focus:border-cyan-200/50 focus:bg-white/[0.055]";
const controlIconClass =
  "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500";

export default function AnchoredDashboard({
  initialData,
  anchorLanguage,
  baseLanguage,
  className
}: AnchoredDashboardProps) {
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<AnchorStatusFilter>("ALL");
  const [category, setCategory] = useState("ALL");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [themeReady, setThemeReady] = useState(false);

  const baseSource = baseLanguage ?? initialData.baseLanguage ?? "CN";
  const snapshotAnchorLanguage =
    "anchorLanguage" in initialData ? initialData.anchorLanguage : undefined;
  const anchorSource = anchorLanguage ?? snapshotAnchorLanguage ?? initialData.targetLanguage ?? "JP";

  const rows = useMemo(
    () => buildAnchorRows(initialData, anchorSource, baseSource),
    [anchorSource, baseSource, initialData]
  );

  useEffect(() => {
    const saved = window.localStorage.getItem("peoplediff-anchor-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    window.localStorage.setItem("peoplediff-anchor-theme", theme);
  }, [theme, themeReady]);

  useEffect(() => {
    if (!rows.length) {
      setSelectedId("");
      return;
    }
    setSelectedId((current) => (rows.some((row) => row.id === current) ? current : rows[0].id));
  }, [rows]);

  const categories = useMemo(() => {
    const values = new Set<string>();
    rows.forEach((row) => {
      if (row.anchor.category) values.add(row.anchor.category);
      if (row.cn?.category) values.add(row.cn.category);
    });
    return ["ALL", ...[...values].sort((a, b) => a.localeCompare(b, "ja"))];
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const queryHit =
        !q ||
        [
          row.anchor.title,
          row.anchor.translatedTitle,
          row.anchor.summary,
          row.anchor.category,
          row.cn?.title,
          row.cn?.translatedTitle,
          row.cn?.summary,
          row.reason,
          row.highlights.join(" ")
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q);
      const statusHit = matchesStatus(row, status);
      const categoryHit =
        category === "ALL" || row.anchor.category === category || row.cn?.category === category;

      return queryHit && statusHit && categoryHit;
    });
  }, [category, query, rows, status]);

  const selected = filteredRows.find((row) => row.id === selectedId) ?? filteredRows[0];
  const matchedCount = rows.filter((row) => row.status === "matched").length;
  const unmatchedCount = rows.length - matchedCount;
  const diffCount = rows.filter(hasNarrativeDiff).length;
  const coverage = rows.length ? Math.round((matchedCount / rows.length) * 100) : 0;

  return (
    <main
      className={clsx(
        "app-root min-h-screen px-4 py-5 text-slate-100 sm:px-6 lg:px-8",
        theme === "light" ? "theme-light" : "theme-dark",
        className
      )}
    >
      <div className="mx-auto flex max-w-[1540px] flex-col gap-5">
        <header className="grid gap-4 border-b border-white/10 pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">
              <span className="inline-flex items-center gap-2 rounded border border-cyan-200/20 bg-cyan-300/10 px-2.5 py-1">
                <Activity className="h-3.5 w-3.5" />
                JP Anchor View
              </span>
              <span className="rounded border border-white/10 bg-white/[0.03] px-2.5 py-1">
                {baseSource} / {anchorSource}
              </span>
              <span className="rounded border border-white/10 bg-white/[0.03] px-2.5 py-1">
                {initialData.model ?? "model n/a"}
              </span>
              {initialData.generatedAt ? (
                <span className="rounded border border-white/10 bg-white/[0.03] px-2.5 py-1">
                  {formatDate(initialData.generatedAt)}
                </span>
              ) : null}
              {initialData.dateScope?.length ? (
                <span className="rounded border border-emerald-200/20 bg-emerald-300/10 px-2.5 py-1 text-emerald-100/80">
                  対象期間 {formatScope(initialData.dateScope)}
                </span>
              ) : null}
            </div>
            <h1 className="text-balance text-3xl font-semibold tracking-normal text-white sm:text-5xl">
              PeopleDiff JP Anchor
            </h1>
            <p className="mt-3 max-w-5xl text-sm leading-6 text-slate-300">
              日本語版の記事を起点に、対応する中国語版、照合スコア、照合理由、本文差分とフレーミング差分を同じ観測ノードで確認します。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            className="theme-toggle inline-flex h-11 min-w-[6.5rem] items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.07]"
            aria-label={theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {theme === "dark" ? "White" : "Dark"}
          </button>
        </header>

        <CollectionModeLinks mode="jp-major" />
        {"run" in initialData ? <SnapshotStatus data={initialData as RefreshResult} /> : null}
        {"archiveDates" in initialData ? <form method="get" className="flex flex-wrap items-center gap-3 text-sm">
          <input type="hidden" name="mode" value="jp-major" />
          <label className="text-slate-400">保存日
            <select name="date" defaultValue={initialData.activeDate ?? ""} className="ml-3 h-11 rounded border border-white/10 bg-slate-950 px-3 text-slate-200">
              <option value="">直近7日</option>
              {initialData.archiveDates?.map((date) => <option key={date} value={date}>{date}</option>)}
            </select>
          </label>
          <button className="h-11 rounded border border-white/10 px-4 text-slate-200" type="submit">表示</button>
        </form> : null}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric icon={Languages} label={`${anchorSource} anchors`} value={rows.length} />
          <Metric icon={CheckCircle2} label="Matched" value={matchedCount} />
          <Metric icon={CircleOff} label="Unmatched" value={unmatchedCount} />
          <Metric icon={Gauge} label="Coverage" value={rows.length ? `${coverage}%` : "n/a"} />
          <Metric icon={FileText} label="Diff signals" value={diffCount} />
        </section>

        {initialData.warnings?.length ? (
          <details className="rounded border border-amber-300/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            <summary className="cursor-pointer font-semibold">
              取得警告 {initialData.warnings.length}件
            </summary>
            <ul className="mt-3 space-y-1 text-xs leading-5 text-amber-100/80">
              {initialData.warnings.slice(0, 6).map((warning) => (
                <li key={warning}>{truncateUiText(warning, 120)}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <section className="grid gap-2.5 border-y border-white/10 py-4 md:grid-cols-2 xl:grid-cols-[minmax(14rem,1fr)_19rem_12rem] xl:items-center">
          <label className="relative block min-w-0">
            <Search className={controlIconClass} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="日本語タイトル、CN見出し、照合理由..."
              className={`${controlBase} pl-10 pr-3 placeholder:text-slate-500`}
            />
          </label>
          <div className="grid h-11 grid-cols-4 gap-1 rounded-md border border-white/10 bg-white/[0.035] p-1">
            {statusFilters.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setStatus(item)}
                className={clsx(
                  "inline-flex h-9 w-full items-center justify-center whitespace-nowrap rounded px-2 text-[10px] font-semibold uppercase tracking-[0.08em] transition sm:text-[11px]",
                  status === item
                    ? "bg-cyan-300/16 text-cyan-50 shadow-[inset_0_0_0_1px_rgba(165,243,252,0.28)]"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
                )}
              >
                {filterLabel(item)}
              </button>
            ))}
          </div>
          <label className="relative block min-w-0">
            <Filter className={controlIconClass} />
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className={`${controlBase} appearance-none pl-10 pr-8 font-semibold`}
              aria-label="カテゴリで絞り込み"
            >
              {categories.map((item) => (
                <option key={item} value={item} className="bg-slate-950">
                  {item === "ALL" ? "全カテゴリ" : item}
                </option>
              ))}
            </select>
          </label>
        </section>

        {rows.length === 0 ? (
          <EmptyState anchorSource={anchorSource} />
        ) : filteredRows.length === 0 ? (
          <NoFilteredResults />
        ) : (
          <section className="grid gap-5 xl:grid-cols-[minmax(22rem,0.92fr)_minmax(0,1.35fr)]">
            <AnchorList
              rows={filteredRows}
              selectedId={selected?.id}
              anchorSource={anchorSource}
              baseSource={baseSource}
              onSelect={setSelectedId}
            />
            {selected ? (
              <AnchorDetail row={selected} anchorSource={anchorSource} baseSource={baseSource} />
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.035] px-4 py-3 shadow-glow">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          {label}
        </span>
        <Icon className="h-4 w-4 text-cyan-200/70" />
      </div>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

function AnchorList({
  rows,
  selectedId,
  anchorSource,
  baseSource,
  onSelect
}: {
  rows: AnchorRow[];
  selectedId?: string;
  anchorSource: Source;
  baseSource: Source;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">
          {anchorSource} anchored articles
        </h2>
        <span className="text-xs text-slate-500">{rows.length} articles</span>
      </div>
      <div className="grid max-h-[780px] gap-3 overflow-y-auto pr-1 scrollbar-thin">
        {rows.map((row) => (
          <AnchorCard
            key={row.id}
            row={row}
            selected={selectedId === row.id}
            baseSource={baseSource}
            onSelect={() => onSelect(row.id)}
          />
        ))}
      </div>
    </section>
  );
}

function AnchorCard({
  row,
  selected,
  baseSource,
  onSelect
}: {
  row: AnchorRow;
  selected: boolean;
  baseSource: Source;
  onSelect: () => void;
}) {
  const displayStatus = row.status === "matched" ? "MATCHED" : "UNMATCHED";
  const scoreLabel = row.status === "matched" ? `${row.score}/100` : "no CN";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        "group min-h-48 rounded border p-4 text-left transition",
        selected
          ? "border-cyan-200/45 bg-cyan-300/10"
          : "border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]"
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge
          status={row.status === "matched" ? "MATCHED" : "JP ONLY"}
          label={displayStatus}
        />
        <DifferenceMarkers row={row} />
        <span className="rounded border border-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          score {scoreLabel}
        </span>
        <span className="rounded border border-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {row.anchor.category || "uncategorized"}
        </span>
      </div>
      <h3 className="line-clamp-3 text-base font-semibold leading-6 text-white">
        {row.anchor.title}
      </h3>
      {row.anchor.translatedTitle && row.anchor.translatedTitle !== row.anchor.title ? (
        <p className="mt-2 line-clamp-2 text-sm leading-5 text-cyan-100/80">
          {row.anchor.translatedTitle}
        </p>
      ) : null}
      <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-400">{row.reason}</p>
      {row.cn ? (
        <div className="mt-3 rounded border border-white/10 bg-black/20 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {baseSource} article
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-300">{row.cn.title}</p>
        </div>
      ) : (
        <div className="mt-3 rounded border border-dashed border-violet-300/25 bg-violet-400/10 px-3 py-2 text-sm text-violet-100">
          対応する中国語版記事は、この取得範囲では見つかっていません。
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-500">
          {row.anchor.publishedAt || row.anchor.urlDate || "time n/a"}
          {row.anchor.dateMismatch ? " / date drift" : ""}
        </span>
        <ArrowUpRight className="h-4 w-4 text-slate-500 transition group-hover:text-cyan-200" />
      </div>
    </button>
  );
}

function DifferenceMarkers({ row }: { row: AnchorRow }) {
  const kinds = differenceKinds(row);
  if (!kinds.length) return null;

  return (
    <>
      {kinds.map((kind) => (
        <span
          key={kind}
          className={clsx(
            "inline-flex items-center rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
            kind === "BODY DIFF"
              ? "border-rose-300/30 bg-rose-400/10 text-rose-100"
              : "border-amber-300/35 bg-amber-400/10 text-amber-100"
          )}
        >
          {kind}
        </span>
      ))}
    </>
  );
}

function AnchorDetail({
  row,
  anchorSource,
  baseSource
}: {
  row: AnchorRow;
  anchorSource: Source;
  baseSource: Source;
}) {
  return (
    <section className="min-w-0 rounded border border-white/10 bg-slate-950/70 shadow-glow">
      <div className="border-b border-white/10 px-4 py-4 sm:px-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusBadge
            status={row.status === "matched" ? "MATCHED" : "JP ONLY"}
            label={row.status === "matched" ? "MATCHED" : "UNMATCHED"}
          />
          <DifferenceMarkers row={row} />
          <span className="rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300">
            score {row.status === "matched" ? `${row.score}/100` : "not found"}
          </span>
        </div>
        <h2 className="text-lg font-semibold leading-7 text-white">{row.anchor.title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">{row.reason}</p>
      </div>

      <div className="grid gap-0 lg:grid-cols-2">
        <ArticlePane
          label={`ANCHOR / ${anchorSource}`}
          article={row.anchor}
          terms={row.highlights}
          accent="cyan"
        />
        <ArticlePane
          label={`MATCHED CN / ${baseSource}`}
          article={row.cn}
          terms={row.highlights}
          accent="emerald"
        />
      </div>

      <AnalysisPanel row={row} anchorSource={anchorSource} baseSource={baseSource} />
    </section>
  );
}

function ArticlePane({
  label,
  article,
  terms,
  accent
}: {
  label: string;
  article?: Article;
  terms: string[];
  accent: "cyan" | "emerald";
}) {
  if (!article) {
    return (
      <div className="min-h-80 border-white/10 p-4 sm:p-5 lg:border-l">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          {label}
        </span>
        <div className="mt-12 rounded border border-dashed border-white/10 p-6 text-center text-sm leading-6 text-slate-500">
          対応記事なし。JP側で選択された話題、またはCN側取得範囲外の可能性として扱います。
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 border-white/10 p-4 sm:p-5 lg:border-l first:lg:border-l-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span
          className={clsx(
            "text-xs font-semibold uppercase tracking-[0.2em]",
            accent === "cyan" ? "text-cyan-100/70" : "text-emerald-100/80"
          )}
        >
          {label}
        </span>
        <a
          href={article.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-cyan-100/80 hover:text-cyan-100"
        >
          source <ArrowUpRight className="h-3 w-3" />
        </a>
      </div>
      <h3 className="text-lg font-semibold leading-7 text-white">{article.title}</h3>
      {article.translatedTitle && article.translatedTitle !== article.title ? (
        <p className="mt-2 text-sm leading-6 text-cyan-100/80">{article.translatedTitle}</p>
      ) : null}
      {article.summary ? (
        <p className="mt-3 text-sm leading-6 text-slate-400">{article.summary}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
        {article.urlDate ? <span>URL {article.urlDate}</span> : null}
        {article.publishedDate ? <span>BODY {article.publishedDate}</span> : null}
        {article.dateMismatch ? <span className="text-amber-200">date drift</span> : null}
      </div>
      <div className="mt-5 max-h-[440px] overflow-y-auto rounded border border-white/10 bg-black/20 p-4 text-sm leading-7 text-slate-300 scrollbar-thin">
        {highlightText(article.body || "本文を取得できませんでした。", terms)}
      </div>
    </div>
  );
}

function AnalysisPanel({
  row,
  anchorSource,
  baseSource
}: {
  row: AnchorRow;
  anchorSource: Source;
  baseSource: Source;
}) {
  const analysis = row.analysis;

  if (!analysis || analysis.analysisStatus === "unavailable" || row.status === "unmatched") {
    return (
      <div className="border-t border-white/10 p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <NarrativeTile
            label="接続状態"
            value={
              row.status === "matched"
                ? "対応記事はありますが、本文・論調は未分析です。差分なしという判定ではありません。"
                : "JP記事をアンカーとして残し、CN側の対応未検出として表示しています。"
            }
          />
          <NarrativeTile label="照合理由" value={row.reason} />
          <NarrativeTile
            label="キーワード"
            value={row.highlights.length ? row.highlights.join(" / ") : "n/a"}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-white/10 p-4 sm:p-5">
      <div className="grid gap-4 lg:grid-cols-3">
        <AnalysisList title={`CN要点 (${baseSource})`} items={analysis.cnPoints} />
        <AnalysisList title={`JP要点 (${anchorSource})`} items={analysis.jpPoints} />
        <div className="grid gap-3">
          <SignalBlock
            title="JP側で薄い / 消えた論点"
            items={analysis.missingPoints}
            emptyText="明確に消えた論点は見られません。"
            tone="minus"
          />
          <SignalBlock
            title="JP側で強調された論点"
            items={analysis.emphasizedPoints}
            emptyText="明確な追加強調は見られません。"
            tone="plus"
          />
        </div>
        <div className="grid gap-3 md:grid-cols-3 lg:col-span-3">
          <NarrativeTile
            label={`Match ${analysis.matchConfidence ?? row.score}/100`}
            value={analysis.sameTopic === false ? "同一話題としては弱い判定です。" : row.reason}
          />
          <NarrativeTile
            label={`Framing ${analysis.framingShiftScore ?? 0}/100`}
            value={analysis.toneDifference}
          />
          <NarrativeTile
            label={`Body ${analysis.bodyDifferenceScore ?? analysis.shiftScore}/100`}
            value={analysis.verdict}
          />
          <NarrativeTile label="政治表現" value={analysis.politicalLanguage} />
        </div>
      </div>
    </div>
  );
}

function AnalysisList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {items.length ? (
        <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
          {items.map((item) => (
            <li key={item}>{normalizeAnalysisText(item)}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm leading-6 text-slate-500">要点は抽出されていません。</p>
      )}
    </div>
  );
}

function SignalBlock({
  title,
  items,
  emptyText,
  tone
}: {
  title: string;
  items: string[];
  emptyText: string;
  tone: "minus" | "plus";
}) {
  const marker = tone === "minus" ? "-" : "+";

  return (
    <div className="overflow-hidden rounded border border-white/10 bg-white/[0.025]">
      <div className="border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <div className="diff-editor">
        {items.length ? (
          items.map((item) => (
            <div
              key={item}
              className={clsx("diff-row", tone === "minus" ? "diff-row-minus" : "diff-row-plus")}
            >
              <span className="diff-prefix">{marker}</span>
              <span>{normalizeAnalysisText(item)}</span>
            </div>
          ))
        ) : (
          <div className="diff-row diff-row-empty">
            <span className="diff-prefix">·</span>
            <span>{emptyText}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function NarrativeTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
        {label}
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-200">
        {normalizeAnalysisText(value || "n/a")}
      </p>
    </div>
  );
}

function EmptyState({ anchorSource }: { anchorSource: Source }) {
  return (
    <section className="grid min-h-[420px] place-items-center rounded border border-white/10 bg-white/[0.025]">
      <div className="max-w-md px-6 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded border border-cyan-200/20 bg-cyan-300/10">
          <Languages className="h-5 w-5 text-cyan-100" />
        </div>
        <h2 className="text-xl font-semibold text-white">No {anchorSource} anchors</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          日本語版記事をアンカーにできるスナップショットがありません。
        </p>
      </div>
    </section>
  );
}

function NoFilteredResults() {
  return (
    <section className="grid min-h-[320px] place-items-center rounded border border-white/10 bg-white/[0.025]">
      <div className="max-w-md px-6 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded border border-white/10 bg-white/[0.04]">
          <Search className="h-5 w-5 text-slate-500" />
        </div>
        <h2 className="text-xl font-semibold text-white">No matching anchors</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          ステータス、カテゴリ、検索語を変えてください。
        </p>
      </div>
    </section>
  );
}

function buildAnchorRows(
  snapshot: RefreshResult | AnchoredSnapshot,
  anchorSource: Source,
  baseSource: Source
): AnchorRow[] {
  const targetOrder = new Map(
    getOrderedAnchorArticles(snapshot, anchorSource).map((article, index) => [article.id, index])
  );
  const rows = new Map<string, AnchorRow>();

  getSnapshotAnchoredPairs(snapshot, anchorSource).forEach((pair) => {
    rows.set(pair.jp.id, {
      id: pair.id || pair.jp.id,
      anchor: pair.jp,
      cn: pair.cn,
      status: pair.status,
      pairStatus: pair.status === "matched" && pair.cn ? "MATCHED" : "JP ONLY",
      score: normalizedScore(pair.match_score),
      reason: pair.match_reason,
      analysis: pair.status === "matched" ? pair.analysis : undefined,
      highlights: cleanHighlights(pair.highlights, pair.jp, pair.cn)
    });
  });

  getFallbackPairs(snapshot).forEach((pair) => {
    const anchor = getAnchorArticle(pair, anchorSource);
    if (!anchor || rows.has(anchor.id)) return;

    const cn = getBaseArticle(pair, baseSource);
    rows.set(anchor.id, {
      id: pair.id || anchor.id,
      pair,
      pairStatus: pair.status,
      anchor,
      cn,
      status: cn ? "matched" : "unmatched",
      score: normalizedScore(pair.match?.score ?? pair.matchScore),
      reason: matchReason(pair, anchor, cn),
      analysis: cn ? pair.analysis : undefined,
      highlights: cleanHighlights(pair.highlights, anchor, cn)
    });
  });

  getSnapshotTargetArticles(snapshot, anchorSource).forEach((article) => {
    if (rows.has(article.id)) return;
    rows.set(article.id, {
      id: article.id,
      anchor: article,
      status: "unmatched",
      score: 0,
      reason: "JP記事一覧にはありますが、対応CN候補はまだ接続されていません。",
      highlights: cleanHighlights([], article)
    });
  });

  return [...rows.values()].sort((a, b) => {
    const orderA = targetOrder.get(a.anchor.id);
    const orderB = targetOrder.get(b.anchor.id);
    if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
    if (orderA !== undefined) return -1;
    if (orderB !== undefined) return 1;
    return articleTime(b.anchor) - articleTime(a.anchor);
  });
}

function getSnapshotTargetArticles(
  snapshot: RefreshResult | AnchoredSnapshot,
  anchorSource: Source
) {
  const direct =
    anchorSource === "JP"
      ? snapshot.jpArticles?.length
        ? snapshot.jpArticles
        : snapshot.targetArticles
      : snapshot.targetArticles;
  return dedupeArticles((direct ?? []).filter((article) => article.source === anchorSource));
}

function getOrderedAnchorArticles(snapshot: RefreshResult | AnchoredSnapshot, anchorSource: Source) {
  const anchoredArticles = getSnapshotAnchoredPairs(snapshot, anchorSource).map((pair) => pair.jp);
  if (anchoredArticles.length) return dedupeArticles(anchoredArticles);
  return getSnapshotTargetArticles(snapshot, anchorSource);
}

function getSnapshotAnchoredPairs(
  snapshot: RefreshResult | AnchoredSnapshot,
  anchorSource: Source
) {
  return (snapshot.anchoredPairs ?? []).filter((pair) => pair.jp.source === anchorSource);
}

function getFallbackPairs(snapshot: RefreshResult | AnchoredSnapshot): LegacyAnchoredArticlePair[] {
  return (snapshot.pairs ?? []) as LegacyAnchoredArticlePair[];
}

function getAnchorArticle(pair: LegacyAnchoredArticlePair, anchorSource: Source) {
  return (
    pair.anchor ??
    pair.anchorArticle ??
    pair.jpArticle ??
    getArticleBySource(pair, anchorSource) ??
    (anchorSource === "JP" ? pair.jp : undefined)
  );
}

function getBaseArticle(pair: LegacyAnchoredArticlePair, baseSource: Source) {
  return (
    pair.cnArticle ??
    pair.matchedArticle ??
    getArticleBySource(pair, baseSource) ??
    (baseSource === "CN" ? pair.cn : undefined)
  );
}

function getArticleBySource(pair: ArticlePair, source: Source) {
  return (
    pair.articlesBySource?.[source] ??
    (pair.base?.source === source ? pair.base : undefined) ??
    (pair.target?.source === source ? pair.target : undefined) ??
    (pair.cn?.source === source ? pair.cn : undefined) ??
    (pair.jp?.source === source ? pair.jp : undefined)
  );
}

function matchReason(pair: LegacyAnchoredArticlePair, anchor: Article, cn?: Article) {
  const explicit = pair.match?.reason ?? pair.matchReason ?? pair.scoreReason ?? pair.reason;
  if (explicit) return explicit;
  if (!cn) return "対応CN記事は未検出です。JP側で選ばれた話題として単独表示します。";

  const confidence = pair.analysis?.matchConfidence;
  const terms = cleanHighlights(pair.highlights, anchor, cn).slice(0, 4);
  const basis = terms.length ? `共有語: ${terms.join(" / ")}` : "タイトル、カテゴリ、本文特徴の近さ";
  if (typeof confidence === "number") {
    return `AI同一話題判定 ${Math.round(confidence)}%。${basis}から対応候補として接続。`;
  }
  return `${basis}から対応CN記事として接続。`;
}

function matchesStatus(row: AnchorRow, status: AnchorStatusFilter) {
  if (status === "ALL") return true;
  if (status === "MATCHED") return row.status === "matched";
  if (status === "UNMATCHED") return row.status === "unmatched";
  return hasNarrativeDiff(row);
}

function hasNarrativeDiff(row: AnchorRow) {
  return differenceKinds(row).length > 0;
}

function differenceKinds(row: AnchorRow) {
  if (row.status !== "matched") return [];
  const status = row.pairStatus ?? row.pair?.status;
  const analysis = row.analysis;
  if (!analysis || analysis.analysisStatus === "unavailable") return [];
  const bodyScore = analysis?.bodyDifferenceScore ?? 0;
  const framingScore = analysis?.framingShiftScore ?? 0;
  const pointDiff = Boolean(
    analysis && (analysis.missingPoints.length > 0 || analysis.emphasizedPoints.length > 0)
  );
  const bodyDiff = status === "BODY DIFFERENCE" || bodyScore >= 35 || pointDiff;
  const framingDiff = status === "FRAMING SHIFT" || framingScore >= 55;

  return [
    ...(bodyDiff ? ["BODY DIFF"] : []),
    ...(framingDiff ? ["FRAMING"] : [])
  ];
}

function filterLabel(status: AnchorStatusFilter) {
  switch (status) {
    case "MATCHED":
      return "MATCHED";
    case "UNMATCHED":
      return "UNMATCHED";
    case "DIFF":
      return "DIFF";
    default:
      return "ALL";
  }
}

function cleanHighlights(items: string[] | undefined, anchor: Article, cn?: Article) {
  return [
    ...(items ?? []),
    ...anchor.keywords,
    ...(cn?.keywords ?? [])
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 12);
}

function normalizedScore(score: number | undefined) {
  if (!Number.isFinite(score)) return 0;
  const value = score ?? 0;
  if (value <= 1) return Math.round(value * 100);
  return Math.round(Math.min(100, value));
}

function dedupeArticles(articles: Article[]) {
  const seen = new Set<string>();
  return articles.filter((article) => {
    const key = article.id || article.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function articleTime(article: Article) {
  const value = Date.parse(article.publishedAt ?? article.publishedDate ?? article.urlDate ?? "");
  return Number.isFinite(value) ? value : 0;
}

function highlightText(text: string, terms: string[]) {
  const cleanTerms = terms
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8);

  if (!cleanTerms.length) return text;

  const escaped = cleanTerms.map((term) => escapeRegExp(term));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, index) => {
    const hit = cleanTerms.some((term) => part.toLowerCase() === term.toLowerCase());
    if (!hit) return <span key={`${part}-${index}`}>{part}</span>;
    return (
      <mark key={`${part}-${index}`} className="rounded bg-amber-300/20 px-1 text-amber-100">
        {part}
      </mark>
    );
  });
}

function normalizeAnalysisText(input: string) {
  return input
    .replace(/“([^”]+)”/g, "「$1」")
    .replace(/"([^"]+)"/g, "「$1」")
    .replace(/（CN）|\(CN\)/g, "（中国語版）")
    .replace(/（JP）|\(JP\)/g, "（日本語版）")
    .replace(/具体提及/g, "具体的に言及")
    .replace(/未提及/g, "言及していない")
    .replace(/中国强调/g, "中国語版は")
    .replace(/日本强调/g, "日本語版は")
    .replace(/军演/g, "軍事演習")
    .replace(/细节/g, "詳細")
    .replace(/威胁/g, "脅威")
    .replace(/首次/g, "初使用")
    .replace(/具体时间/g, "具体的な時点")
    .replace(/导弹/g, "導弾")
    .replace(/再军事化/g, "再軍事化")
    .replace(/加速/g, "加速")
    .replace(/肩并肩/g, "肩を並べて")
    .replace(/新型军国主义/g, "新型軍国主義");
}

function truncateUiText(input: string, maxLength: number) {
  return input.length > maxLength ? `${input.slice(0, maxLength - 1)}...` : input;
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(input: string) {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(input));
  } catch {
    return input;
  }
}

function formatScope(scope?: string[]) {
  const dates = [...new Set(scope ?? [])].sort((a, b) => b.localeCompare(a));
  if (!dates.length) return "n/a";
  const from = dates[dates.length - 1];
  const to = dates[0];
  return from === to ? to : `${from} - ${to}`;
}
