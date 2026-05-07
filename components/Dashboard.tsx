"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import {
  Activity,
  ArrowUpRight,
  CalendarDays,
  Filter,
  Gauge,
  Globe2,
  Languages,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun
} from "lucide-react";
import type { Article, ArticlePair, PairStatus, RefreshResult, Source } from "@/lib/types";
import StatusBadge from "./StatusBadge";

type Props = {
  initialData: RefreshResult;
};

type StatusFilter = "ALL" | "CN ONLY" | "JP ONLY" | "MATCHED";

const statusOrder: StatusFilter[] = [
  "ALL",
  "CN ONLY",
  "JP ONLY",
  "MATCHED"
];

const statusCopy: Record<PairStatus, string> = {
  MATCHED: "対応あり",
  "CN ONLY": "中国語版のみ",
  "JP ONLY": "日本語版のみ",
  "FRAMING SHIFT": "論調差分",
  "BODY DIFFERENCE": "本文差分"
};

export default function Dashboard({ initialData }: Props) {
  const [data, setData] = useState(initialData);
  const [selectedId, setSelectedId] = useState(data.pairs[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [category, setCategory] = useState("ALL");
  const [selectedArchiveDate, setSelectedArchiveDate] = useState(initialData.activeDate ?? "LATEST");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const saved = window.localStorage.getItem("peoplediff-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    window.localStorage.setItem("peoplediff-theme", theme);
  }, [theme, themeReady]);

  useEffect(() => {
    setSelectedArchiveDate(data.activeDate ?? "LATEST");
  }, [data.activeDate, data.generatedAt]);

  const filteredPairs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.pairs.filter((pair) => {
      const haystack = [
        pair.cn?.title,
        pair.cn?.translatedTitle,
        pair.jp?.title,
        pair.cn?.summary,
        pair.jp?.summary,
        pair.cn?.category,
        pair.jp?.category,
        pair.highlights.join(" ")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const categoryHit =
        category === "ALL" || pair.cn?.category === category || pair.jp?.category === category;
      const statusHit = matchesStatusFilter(pair, status);
      const queryHit = !q || haystack.includes(q);

      return categoryHit && statusHit && queryHit;
    });
  }, [category, data.pairs, query, status]);

  useEffect(() => {
    if (!filteredPairs.length) return;
    if (!filteredPairs.some((pair) => pair.id === selectedId)) {
      setSelectedId(filteredPairs[0].id);
    }
  }, [filteredPairs, selectedId]);

  const categories = useMemo(() => {
    const values = new Set<string>();
    data.pairs.forEach((pair) => {
      if (pair.cn?.category) values.add(pair.cn.category);
      if (pair.jp?.category) values.add(pair.jp.category);
    });
    return ["ALL", ...[...values].sort((a, b) => a.localeCompare(b, "ja"))];
  }, [data.pairs]);

  const archiveDates = useMemo(() => {
    const values = new Set<string>();
    data.archiveDates?.forEach((date) => {
      if (isArchiveDate(date)) values.add(date);
    });
    return [...values].sort((a, b) => b.localeCompare(a));
  }, [data.archiveDates]);

  const cnRows = filteredPairs.filter((pair) => pair.cn);
  const jpRows = filteredPairs.filter((pair) => pair.jp);
  const selected = filteredPairs.find((pair) => pair.id === selectedId) ?? filteredPairs[0];
  const activeLens = getLensCopy(status);

  function refresh() {
    startTransition(async () => {
      const response = await fetch("/api/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dates: recentDateScope(),
          maxPages: 8,
          maxArticles: 240
        })
      });
      const next = (await response.json()) as RefreshResult;
      setData(next);
      setSelectedId(next.pairs[0]?.id ?? "");
    });
  }

  function loadArchiveDate(nextDate: string) {
    setSelectedArchiveDate(nextDate);
    startTransition(async () => {
      const queryString = nextDate === "LATEST" ? "" : `?date=${encodeURIComponent(nextDate)}`;
      const response = await fetch(`/api/refresh${queryString}`, {
        method: "GET",
        cache: "no-store"
      });
      const next = (await response.json()) as RefreshResult;
      setData(next);
      setSelectedId(next.pairs[0]?.id ?? "");
    });
  }

  return (
    <main
      className={clsx(
        "app-root min-h-screen px-4 py-5 text-slate-100 sm:px-6 lg:px-8",
        theme === "light" ? "theme-light" : "theme-dark"
      )}
    >
      <div className="mx-auto flex max-w-[1540px] flex-col gap-5">
        <header className="grid gap-4 border-b border-white/10 pb-5 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">
              <span className="inline-flex items-center gap-2 rounded border border-cyan-200/20 bg-cyan-300/10 px-2.5 py-1">
                <Activity className="h-3.5 w-3.5" />
                Media Observation
              </span>
              <span className="rounded border border-white/10 bg-white/[0.03] px-2.5 py-1">
                {data.model}
              </span>
              <span className="rounded border border-white/10 bg-white/[0.03] px-2.5 py-1">
                {formatDate(data.generatedAt)}
              </span>
              {data.dateScope?.length ? (
                <span className="rounded border border-emerald-200/20 bg-emerald-300/10 px-2.5 py-1 text-emerald-100/80">
                  {data.dateScope.join(" / ")}
                </span>
              ) : null}
            </div>
            <h1 className="text-balance text-3xl font-semibold tracking-normal text-white sm:text-5xl">
              PeopleDiff
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              人民網の中国語版と日本語版を接続し、記事選択、本文量、政治表現、対外向けフレーミングの差分を観測するPoC。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <button
              type="button"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
              className="theme-toggle inline-flex h-11 items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.07]"
              aria-label={theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "White" : "Dark"}
            </button>
            <button
              type="button"
              onClick={refresh}
              disabled={isPending}
              className="inline-flex h-11 items-center gap-2 rounded border border-emerald-300/30 bg-emerald-300/14 px-4 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-300/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className={clsx("h-4 w-4", isPending && "animate-spin")} />
              最新記事を更新
            </button>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric icon={Globe2} label="CN articles" value={data.stats.cnCount} />
          <Metric icon={Languages} label="JP articles" value={data.stats.jpCount} />
          <Metric icon={ShieldCheck} label="Coverage" value={`${data.stats.coverageRatio}%`} />
          <Metric
            icon={Sparkles}
            label="Diff pairs"
            value={data.stats.framingShift + data.stats.bodyDifference}
          />
          <Metric icon={Gauge} label="Date drift" value={data.stats.dateMismatches ?? 0} />
        </section>

        {data.warnings.length > 0 ? (
          <div className="rounded border border-amber-300/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            {data.warnings.join(" / ")}
          </div>
        ) : null}

        <section className="grid gap-3 border-y border-white/10 py-4 xl:grid-cols-[minmax(220px,1fr)_minmax(280px,24rem)_minmax(10rem,12rem)_minmax(11rem,13rem)] xl:items-center">
          <label className="relative block min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="台湾、軍事、経済..."
              className="h-10 w-full rounded border border-white/10 bg-white/[0.04] pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-200/50"
            />
          </label>
          <div className="grid grid-cols-4 gap-2">
            {statusOrder.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setStatus(item)}
                className={clsx(
                  "inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded border px-1 text-[10px] font-semibold uppercase tracking-[0.08em] transition sm:px-2 sm:text-[11px] sm:tracking-[0.12em]",
                  status === item
                    ? "border-cyan-200/50 bg-cyan-300/15 text-cyan-50"
                    : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-100"
                )}
              >
                {getFilterLabel(item)}
              </button>
            ))}
          </div>
          <label className="relative block min-w-0">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <select
              value={selectedArchiveDate}
              onChange={(event) => loadArchiveDate(event.target.value)}
              className="h-10 w-full min-w-0 appearance-none rounded border border-white/10 bg-white/[0.04] pl-10 pr-8 text-sm text-white outline-none transition focus:border-cyan-200/50"
            >
              <option value="LATEST" className="bg-slate-950">
                最新
              </option>
              {archiveDates.map((date) => (
                <option key={date} value={date} className="bg-slate-950">
                  {date}
                </option>
              ))}
            </select>
          </label>
          <label className="relative block min-w-0">
            <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="h-10 w-full min-w-0 appearance-none rounded border border-white/10 bg-white/[0.04] pl-10 pr-8 text-sm text-white outline-none transition focus:border-cyan-200/50"
            >
              {categories.map((item) => (
                <option key={item} value={item} className="bg-slate-950">
                  {item === "ALL" ? "全カテゴリ" : item}
                </option>
              ))}
            </select>
          </label>
        </section>

        {status !== "ALL" ? (
          <section className="rounded border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start">
              <FilterBadge status={status} />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-white">{activeLens.title}</h2>
                <p className="mt-1 text-sm leading-6 text-slate-400">{activeLens.description}</p>
              </div>
            </div>
          </section>
        ) : null}

        {data.pairs.length === 0 ? (
          <EmptyState isPending={isPending} onRefresh={refresh} />
        ) : filteredPairs.length === 0 ? (
          <NoFilteredResults />
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <ArticleColumn
              title="中国語版新着"
              source="CN"
              rows={cnRows}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
            <ArticleColumn
              title="日本語版新着"
              source="JP"
              rows={jpRows}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
          </div>
        )}

        {selected ? <ComparisonPanel pair={selected} /> : null}
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

function FilterBadge({ status }: { status: Exclude<StatusFilter, "ALL"> }) {
  return <StatusBadge status={status} className="h-7 w-28 justify-center" />;
}

function DifferenceMarkers({ pair }: { pair: ArticlePair }) {
  const kinds = getDifferenceKinds(pair);
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

function ArticleColumn({
  title,
  source,
  rows,
  selectedId,
  onSelect
}: {
  title: string;
  source: Source;
  rows: ArticlePair[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">
          {title}
        </h2>
        <span className="text-xs text-slate-500">{rows.length} nodes</span>
      </div>
      <div className="grid max-h-[720px] gap-3 overflow-y-auto pr-1 scrollbar-thin">
        {rows.map((pair) => {
          const article = source === "CN" ? pair.cn : pair.jp;
          if (!article) return null;
          return (
            <ArticleCard
              key={`${source}-${pair.id}`}
              article={article}
              pair={pair}
              selected={selectedId === pair.id}
              onSelect={() => onSelect(pair.id)}
            />
          );
        })}
      </div>
    </section>
  );
}

function ArticleCard({
  article,
  pair,
  selected,
  onSelect
}: {
  article: Article;
  pair: ArticlePair;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        "group min-h-44 rounded border p-4 text-left transition",
        selected
          ? "border-cyan-200/45 bg-cyan-300/10"
          : "border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]"
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={getPrimaryStatus(pair)} />
        <DifferenceMarkers pair={pair} />
        <span className="rounded border border-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {article.category || "uncategorized"}
        </span>
      </div>
      <h3 className="line-clamp-3 text-base font-semibold leading-6 text-white">
        {article.title}
      </h3>
      {article.translatedTitle && article.translatedTitle !== article.title ? (
        <p className="mt-2 line-clamp-2 text-sm leading-5 text-cyan-100/80">
          {article.translatedTitle}
        </p>
      ) : null}
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-400">{article.summary}</p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-500">
          {article.publishedAt || article.urlDate || "time n/a"}
          {article.dateMismatch ? " / date drift" : ""}
        </span>
        <ArrowUpRight className="h-4 w-4 text-slate-500 transition group-hover:text-cyan-200" />
      </div>
    </button>
  );
}

function ComparisonPanel({ pair }: { pair: ArticlePair }) {
  const analysis = pair.analysis;
  const terms = pair.highlights.slice(0, 10);

  return (
    <section className="rounded border border-white/10 bg-slate-950/70 shadow-glow">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={getPrimaryStatus(pair)} />
            <DifferenceMarkers pair={pair} />
            <span className="text-xs text-slate-500">match {Math.round(pair.matchScore * 100)}%</span>
          </div>
          <h2 className="text-lg font-semibold text-white">比較パネル</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {terms.slice(0, 6).map((term) => (
            <span
              key={term}
              className="rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300"
            >
              {term}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-2">
        <ArticlePane label="CN" article={pair.cn} terms={terms} />
        <ArticlePane label="JP" article={pair.jp} terms={terms} />
      </div>

      <div className="border-t border-white/10 p-4 sm:p-5">
        {analysis ? (
          <div className="grid gap-4 lg:grid-cols-3">
            <AnalysisList title="中国語版の要点" items={analysis.cnPoints} />
            <AnalysisList title="日本語版の要点" items={analysis.jpPoints} />
            <div className="grid gap-3">
              <SignalBlock
                title="消えている論点"
                items={analysis.missingPoints}
                emptyText="明確な欠落は見られません。"
                tone="minus"
              />
              <SignalBlock
                title="強調されている論点"
                items={analysis.emphasizedPoints}
                emptyText="明確な追加強調は見られません。"
                tone="plus"
              />
            </div>
            <div className="lg:col-span-3 grid gap-3 md:grid-cols-3">
              <NarrativeTile
                label={`Framing ${analysis.framingShiftScore ?? 0}/100`}
                value={analysis.toneDifference}
              />
              <NarrativeTile label="政治表現" value={analysis.politicalLanguage} />
              <NarrativeTile
                label={`Body ${analysis.bodyDifferenceScore ?? analysis.shiftScore}/100`}
                value={analysis.verdict}
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <NarrativeTile label={statusCopy[getPrimaryStatus(pair)]} value="このペアは未分析または片側のみの記事です。" />
            <NarrativeTile label="接続性" value={pair.cn && pair.jp ? "本文比較の候補です。" : "片側掲載として観測されています。"} />
            <NarrativeTile label="キーワード" value={terms.join(" / ") || "n/a"} />
          </div>
        )}
      </div>
    </section>
  );
}

function ArticlePane({
  label,
  article,
  terms
}: {
  label: Source;
  article?: Article;
  terms: string[];
}) {
  if (!article) {
    return (
      <div className="min-h-80 border-white/10 p-4 sm:p-5 lg:border-l">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          {label}
        </span>
        <div className="mt-12 rounded border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">
          掲載なし
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 border-white/10 p-4 sm:p-5 lg:border-l first:lg:border-l-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
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
      <p className="mt-3 text-sm leading-6 text-slate-400">{article.summary}</p>
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

function AnalysisList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
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
              <span>{item}</span>
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
      <p className="mt-2 text-sm leading-6 text-slate-200">{value}</p>
    </div>
  );
}

function EmptyState({
  isPending,
  onRefresh
}: {
  isPending: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="grid min-h-[420px] place-items-center rounded border border-white/10 bg-white/[0.025]">
      <div className="max-w-md px-6 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded border border-cyan-200/20 bg-cyan-300/10">
          <RefreshCw className={clsx("h-5 w-5 text-cyan-100", isPending && "animate-spin")} />
        </div>
        <h2 className="text-xl font-semibold text-white">No snapshot</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          中国語版と日本語版のライブ取得待ちです。
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isPending}
          className="mt-5 inline-flex h-10 items-center gap-2 rounded border border-cyan-200/30 bg-cyan-300/12 px-4 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-300/20 disabled:opacity-60"
        >
          <RefreshCw className={clsx("h-4 w-4", isPending && "animate-spin")} />
          最新記事を更新
        </button>
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
        <h2 className="text-xl font-semibold text-white">No matching nodes</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          この条件に合う記事ペアはありません。ステータス、カテゴリ、検索語を変えてください。
        </p>
      </div>
    </section>
  );
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
      <mark
        key={`${part}-${index}`}
        className="rounded bg-amber-300/20 px-1 text-amber-100"
      >
        {part}
      </mark>
    );
  });
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isArchiveDate(input: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(input);
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

function recentDateScope() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return [toLocalDate(today), toLocalDate(yesterday)];
}

function matchesStatusFilter(pair: ArticlePair, status: StatusFilter) {
  if (status === "ALL") return true;
  if (status === "MATCHED") return Boolean(pair.cn && pair.jp);
  return pair.status === status;
}

function getFilterLabel(status: StatusFilter) {
  switch (status) {
    case "CN ONLY":
      return "CN";
    case "JP ONLY":
      return "JP";
    default:
      return status;
  }
}

function getPrimaryStatus(pair: ArticlePair): PairStatus {
  return pair.cn && pair.jp ? "MATCHED" : pair.status;
}

function getDifferenceKinds(pair: ArticlePair) {
  if (!pair.cn || !pair.jp) return [];

  const analysis = pair.analysis;
  const bodyScore = analysis?.bodyDifferenceScore ?? 0;
  const framingScore = analysis?.framingShiftScore ?? 0;
  const hasPointDiff = Boolean(
    analysis && (analysis.missingPoints.length > 0 || analysis.emphasizedPoints.length > 0)
  );
  const hasBodyDiff =
    pair.status === "BODY DIFFERENCE" ||
    bodyScore >= 35 ||
    hasPointDiff ||
    Math.abs(pair.cn.body.length - pair.jp.body.length) > 1800;
  const hasFramingDiff = pair.status === "FRAMING SHIFT" || framingScore >= 55;

  return [
    ...(hasBodyDiff ? ["BODY DIFF"] : []),
    ...(hasFramingDiff ? ["FRAMING"] : [])
  ];
}

function getLensCopy(status: StatusFilter) {
  switch (status) {
    case "CN ONLY":
      return {
        title: "中国語版にのみ存在する記事",
        description:
          "中国語版には出ているが、日本語版では対応記事が見つからない記事です。対外向けに出さない話題の候補として見ます。"
      };
    case "JP ONLY":
      return {
        title: "日本語版にのみ存在する記事",
        description:
          "日本語版には出ているが、中国語版トップ/日別取得範囲で対応記事が見つからない記事です。日本向けに選ばれた話題の候補として見ます。"
      };
    case "MATCHED":
      return {
        title: "同じ話題として対応した記事",
        description:
          "本文差分や論調差分の有無に関係なく、中国語版と日本語版が同じ話題を扱っている記事ペアです。差分がある場合はカード上に BODY DIFF / FRAMING が追加表示されます。"
      };
    default:
      return {
        title: "全記事",
        description: "取得した記事ペアをすべて表示します。"
      };
  }
}

function toLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
