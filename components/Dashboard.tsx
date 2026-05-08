"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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

type StatusFilter = "ALL" | "BASE_ONLY" | "TARGET_ONLY" | "MATCHED";
type LanguageRole = "base" | "target";

type LanguageOption = {
  code: Source;
  name: string;
  nativeName: string;
  editionLabel: string;
  group: "base" | "foreign" | "ethnic";
  source: Source;
  enabled: boolean;
};

type LanguagePairConfig = {
  id: string;
  base: LanguageOption;
  target: LanguageOption;
};

const statusOrder: StatusFilter[] = [
  "ALL",
  "BASE_ONLY",
  "TARGET_ONLY",
  "MATCHED"
];

const controlBase =
  "h-11 w-full min-w-0 rounded-md border border-white/10 bg-white/[0.04] text-sm text-white outline-none transition focus:border-cyan-200/50 focus:bg-white/[0.055]";
const controlIconClass =
  "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500";

export default function Dashboard({ initialData }: Props) {
  const [data, setData] = useState(initialData);
  const [selectedId, setSelectedId] = useState(data.pairs[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [category, setCategory] = useState("ALL");
  const [targetLanguage, setTargetLanguage] = useState<Source>(
    initialData.targetLanguage ?? "JP"
  );
  const [selectedArchiveDate, setSelectedArchiveDate] = useState(initialData.activeDate ?? "LATEST");
  const [dateFrom, setDateFrom] = useState(() => dateRangeFromScope(initialData.dateScope).from);
  const [dateTo, setDateTo] = useState(() => dateRangeFromScope(initialData.dateScope).to);
  const [errorMessage, setErrorMessage] = useState("");
  const [cacheNotice, setCacheNotice] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [isPending, startTransition] = useTransition();
  const snapshotCacheRef = useRef<Map<string, RefreshResult>>(new Map());
  const languageOptions = useMemo(() => getLanguageOptions(data), [data]);
  const baseLanguage = data.baseLanguage ?? "CN";
  const languagePair = useMemo(
    () => makeLanguagePair(languageOptions, baseLanguage, targetLanguage),
    [baseLanguage, languageOptions, targetLanguage]
  );

  useEffect(() => {
    const saved = window.localStorage.getItem("peoplediff-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    rememberClientSnapshot(snapshotCacheRef.current, initialData);
  }, [initialData]);

  useEffect(() => {
    rememberClientSnapshot(snapshotCacheRef.current, data);
  }, [data]);

  useEffect(() => {
    if (!themeReady) return;
    window.localStorage.setItem("peoplediff-theme", theme);
  }, [theme, themeReady]);

  useEffect(() => {
    setSelectedArchiveDate(data.activeDate ?? "LATEST");
  }, [data.activeDate, data.generatedAt]);

  useEffect(() => {
    if (data.targetLanguage) setTargetLanguage(data.targetLanguage);
  }, [data.targetLanguage]);

  useEffect(() => {
    const nextRange = dateRangeFromScope(
      data.targetDateScope?.length ? data.targetDateScope : data.dateScope
    );
    setDateFrom(nextRange.from);
    setDateTo(nextRange.to);
  }, [data.dateScope, data.generatedAt, data.targetDateScope]);

  const filteredPairs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.pairs.filter((pair) => {
      const baseArticle = getRoleArticle(pair, "base", languagePair);
      const targetArticle = getRoleArticle(pair, "target", languagePair);
      const haystack = [
        baseArticle?.title,
        baseArticle?.translatedTitle,
        targetArticle?.title,
        targetArticle?.translatedTitle,
        baseArticle?.summary,
        targetArticle?.summary,
        baseArticle?.category,
        targetArticle?.category,
        pair.highlights.join(" ")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const categoryHit =
        category === "ALL" ||
        baseArticle?.category === category ||
        targetArticle?.category === category;
      const statusHit = matchesStatusFilter(pair, status, languagePair);
      const queryHit = !q || haystack.includes(q);

      return Boolean(baseArticle || targetArticle) && categoryHit && statusHit && queryHit;
    });
  }, [category, data.pairs, languagePair, query, status]);

  useEffect(() => {
    if (!filteredPairs.length) return;
    if (!filteredPairs.some((pair) => pair.id === selectedId)) {
      setSelectedId(filteredPairs[0].id);
    }
  }, [filteredPairs, selectedId]);

  const categories = useMemo(() => {
    const values = new Set<string>();
    data.pairs.forEach((pair) => {
      const baseArticle = getRoleArticle(pair, "base", languagePair);
      const targetArticle = getRoleArticle(pair, "target", languagePair);
      if (baseArticle?.category) values.add(baseArticle.category);
      if (targetArticle?.category) values.add(targetArticle.category);
    });
    return ["ALL", ...[...values].sort((a, b) => a.localeCompare(b, "ja"))];
  }, [data.pairs, languagePair]);

  const archiveDates = useMemo(() => {
    const values = new Set<string>();
    data.archiveDates?.forEach((date) => {
      if (isArchiveDate(date)) values.add(date);
    });
    return [...values].sort((a, b) => b.localeCompare(a));
  }, [data.archiveDates]);

  const baseRows = filteredPairs.filter((pair) => getRoleArticle(pair, "base", languagePair));
  const targetRows = filteredPairs.filter((pair) =>
    getRoleArticle(pair, "target", languagePair)
  );
  const selected = filteredPairs.find((pair) => pair.id === selectedId) ?? filteredPairs[0];
  const activeLens = getLensCopy(status, languagePair);
  const selectedDateScope = useMemo(() => dateScopeFromRange(dateFrom, dateTo), [dateFrom, dateTo]);

  function showSnapshot(next: RefreshResult) {
    setData(next);
    setSelectedId(next.pairs[0]?.id ?? "");
  }

  function showCachedSnapshot(next: RefreshResult, nextTarget: Source, nextDate: string) {
    setErrorMessage("");
    setCacheNotice(`キャッシュから再表示: CN / ${nextTarget} ${snapshotScopeLabel(next, nextDate)}`);
    showSnapshot(next);
  }

  function refresh(nextTarget = targetLanguage) {
    const selectedDates = selectedDateScope;
    if (!selectedDates.length) return;
    startTransition(async () => {
      setErrorMessage("");
      setCacheNotice("");
      try {
        const response = await fetch("/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dates: selectedDates,
            targetDates: selectedDates,
            dateFrom,
            dateTo,
            sourceLookbackDays: 1,
            sourceLanguage: "CN",
            targetLanguage: nextTarget,
            maxPages: 8,
            maxArticles: 240,
            aiArticleLimit: 80,
            cacheTtlSeconds: 1800
          })
        });
        const next = await parseSnapshotResponse(response);
        if (response.headers.get("x-peoplediff-cache") === "hit") {
          setCacheNotice(`サーバーキャッシュから再表示: CN / ${nextTarget} ${snapshotScopeLabel(next, "LATEST")}`);
        }
        showSnapshot(next);
      } catch (error) {
        setErrorMessage(`更新に失敗しました: ${readableError(error)}`);
      }
    });
  }

  function loadArchiveDate(nextDate: string, nextTarget = targetLanguage) {
    setSelectedArchiveDate(nextDate);
    if (nextDate !== "LATEST") {
      setDateFrom(nextDate);
      setDateTo(nextDate);
    }

    const cached = findClientSnapshot(snapshotCacheRef.current, {
      sourceLanguage: "CN",
      targetLanguage: nextTarget,
      archiveDate: nextDate,
      dates: nextDate !== "LATEST" ? [nextDate] : selectedDateScope
    });
    if (cached) {
      showCachedSnapshot(cached, nextTarget, nextDate);
      return;
    }

    startTransition(async () => {
      setErrorMessage("");
      setCacheNotice("");
      try {
        const params = new URLSearchParams({
          sourceLanguage: "CN",
          targetLanguage: nextTarget
        });
        if (nextDate !== "LATEST") params.set("date", nextDate);
        const response = await fetch(`/api/refresh?${params.toString()}`, {
          method: "GET",
          cache: "no-store"
        });
        const next = await parseSnapshotResponse(response);
        showSnapshot(next);
      } catch (error) {
        setErrorMessage(`アーカイブの読み込みに失敗しました: ${readableError(error)}`);
      }
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
                  対象期間 {formatScopeRange(data.targetDateScope?.length ? data.targetDateScope : data.dateScope)}
                </span>
              ) : null}
            </div>
            <h1 className="text-balance text-3xl font-semibold tracking-normal text-white sm:text-5xl">
              PeopleDiff
            </h1>
            <p className="mt-3 max-w-none text-sm leading-6 text-slate-300 xl:whitespace-nowrap">
              人民網の基準言語版と対象言語版を接続し、記事選択、本文量、政治表現、対外向けフレーミングの差分を観測するPoC。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <label className="relative block h-11 min-w-[15rem]">
              <Languages className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-100/70" />
              <select
                value={targetLanguage}
                onChange={(event) => {
                  const nextTarget = event.target.value as Source;
                  setTargetLanguage(nextTarget);
                  setStatus("ALL");
                  setCategory("ALL");
                  loadArchiveDate(selectedArchiveDate, nextTarget);
                }}
                className={`${controlBase} appearance-none pl-10 pr-8 font-semibold`}
                aria-label="対象言語を選択"
              >
                {languageOptions
                  .filter((language) => language.source !== "CN")
                  .map((language) => (
                    <option
                      key={language.source}
                      value={language.source}
                      disabled={!language.enabled}
                      className="bg-slate-950"
                    >
                      CN / {language.source} - {language.nativeName}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
              className="theme-toggle inline-flex h-11 min-w-[6.5rem] items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.07]"
              aria-label={theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "White" : "Dark"}
            </button>
            <button
              type="button"
              onClick={() => refresh()}
              disabled={isPending || selectedDateScope.length === 0}
              className="inline-flex h-11 min-w-[10rem] items-center justify-center gap-2 rounded-md border border-emerald-300/30 bg-emerald-300/14 px-4 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-300/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className={clsx("h-4 w-4", isPending && "animate-spin")} />
              最新記事を更新
            </button>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric
            icon={Globe2}
            label={`Base ${languagePair.base.code}`}
            value={getSourceCount(data, languagePair.base.source)}
          />
          <Metric
            icon={Languages}
            label={`Target ${languagePair.target.code}`}
            value={getSourceCount(data, languagePair.target.source)}
          />
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

        {errorMessage ? (
          <div className="rounded border border-rose-300/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {errorMessage}
          </div>
        ) : null}

        {cacheNotice ? (
          <div className="rounded border border-cyan-300/25 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
            {cacheNotice}
          </div>
        ) : null}

        <section className="grid gap-2.5 border-y border-white/10 py-4 md:grid-cols-2 xl:grid-cols-[10.75rem_10.75rem_minmax(13rem,1fr)_18.75rem_10.5rem_11.5rem] xl:items-center">
          <label className="relative block min-w-0">
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setSelectedArchiveDate("LATEST");
                setCacheNotice("");
                setDateFrom(event.target.value);
              }}
              className={`${controlBase} px-3 font-medium`}
              aria-label="開始日"
            />
          </label>
          <label className="relative block min-w-0">
            <input
              type="date"
              value={dateTo}
              onChange={(event) => {
                setSelectedArchiveDate("LATEST");
                setCacheNotice("");
                setDateTo(event.target.value);
              }}
              className={`${controlBase} px-3 font-medium`}
              aria-label="終了日"
            />
          </label>
          <label className="relative block min-w-0">
            <Search className={controlIconClass} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="台湾、軍事、経済..."
              className={`${controlBase} pl-10 pr-3 placeholder:text-slate-500`}
            />
          </label>
          <div className="grid h-11 grid-cols-4 gap-1 rounded-md border border-white/10 bg-white/[0.035] p-1">
            {statusOrder.map((item) => (
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
                {getFilterLabel(item, languagePair)}
              </button>
            ))}
          </div>
          <label className="relative block min-w-0">
            <CalendarDays className={controlIconClass} />
            <select
              value={selectedArchiveDate}
              onChange={(event) => loadArchiveDate(event.target.value)}
              className={`${controlBase} appearance-none pl-10 pr-8 font-semibold`}
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
            <Filter className={controlIconClass} />
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className={`${controlBase} appearance-none pl-10 pr-8 font-semibold`}
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
              <FilterBadge status={status} languagePair={languagePair} />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-white">{activeLens.title}</h2>
                <p className="mt-1 text-sm leading-6 text-slate-400">{activeLens.description}</p>
              </div>
            </div>
          </section>
        ) : null}

        {data.pairs.length === 0 ? (
          <EmptyState isPending={isPending} onRefresh={() => refresh()} />
        ) : filteredPairs.length === 0 ? (
          <NoFilteredResults />
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <ArticleColumn
              title={`基準言語 ${languagePair.base.code}`}
              role="base"
              languagePair={languagePair}
              rows={baseRows}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
            <ArticleColumn
              title={`対象言語 ${languagePair.target.code}`}
              role="target"
              languagePair={languagePair}
              rows={targetRows}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
          </div>
        )}

        {selected ? <ComparisonPanel pair={selected} languagePair={languagePair} /> : null}
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

function FilterBadge({
  status,
  languagePair
}: {
  status: Exclude<StatusFilter, "ALL">;
  languagePair: LanguagePairConfig;
}) {
  return (
    <StatusBadge
      status={getBadgeStatus(status, languagePair)}
      label={getFilterBadgeLabel(status, languagePair)}
      className="h-7 w-28 justify-center"
    />
  );
}

function DifferenceMarkers({
  pair,
  languagePair
}: {
  pair: ArticlePair;
  languagePair: LanguagePairConfig;
}) {
  const kinds = getDifferenceKinds(pair, languagePair);
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
  role,
  languagePair,
  rows,
  selectedId,
  onSelect
}: {
  title: string;
  role: LanguageRole;
  languagePair: LanguagePairConfig;
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
        {rows.length ? (
          rows.map((pair) => {
            const article = getRoleArticle(pair, role, languagePair);
            if (!article) return null;
            return (
              <ArticleCard
                key={`${role}-${pair.id}`}
                article={article}
                pair={pair}
                languagePair={languagePair}
                selected={selectedId === pair.id}
                onSelect={() => onSelect(pair.id)}
              />
            );
          })
        ) : (
          <div className="rounded border border-dashed border-white/10 bg-white/[0.025] p-5 text-sm leading-6 text-slate-500">
            この条件に合う観測ノードはありません。
          </div>
        )}
      </div>
    </section>
  );
}

function ArticleCard({
  article,
  pair,
  languagePair,
  selected,
  onSelect
}: {
  article: Article;
  pair: ArticlePair;
  languagePair: LanguagePairConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  const displayStatus = getDisplayStatus(pair, languagePair);
  const showGeneratedMeta = shouldShowGeneratedMeta(pair, languagePair);

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
        <StatusBadge status={displayStatus.status} label={displayStatus.label} />
        <DifferenceMarkers pair={pair} languagePair={languagePair} />
        <span className="rounded border border-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {article.category || "uncategorized"}
        </span>
      </div>
      <h3 className="line-clamp-3 text-base font-semibold leading-6 text-white">
        {article.title}
      </h3>
      {showGeneratedMeta && article.translatedTitle && article.translatedTitle !== article.title ? (
        <p className="mt-2 line-clamp-2 text-sm leading-5 text-cyan-100/80">
          {article.translatedTitle}
        </p>
      ) : null}
      {shouldShowSummary(article, showGeneratedMeta) ? (
        <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-400">{article.summary}</p>
      ) : null}
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

function ComparisonPanel({
  pair,
  languagePair
}: {
  pair: ArticlePair;
  languagePair: LanguagePairConfig;
}) {
  const analysis = pair.analysis;
  const terms = pair.highlights.slice(0, 10);
  const baseArticle = getRoleArticle(pair, "base", languagePair);
  const targetArticle = getRoleArticle(pair, "target", languagePair);
  const displayStatus = getDisplayStatus(pair, languagePair);
  const canShowAnalysis = Boolean(baseArticle && targetArticle && analysis);
  const showGeneratedMeta = shouldShowGeneratedMeta(pair, languagePair);

  return (
    <section className="rounded border border-white/10 bg-slate-950/70 shadow-glow">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={displayStatus.status} label={displayStatus.label} />
            <DifferenceMarkers pair={pair} languagePair={languagePair} />
            <span className="text-xs text-slate-500">
              {baseArticle && targetArticle
                ? `match ${Math.round(pair.matchScore * 100)}%`
                : "single-sided"}
            </span>
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
        <ArticlePane
          role="base"
          language={languagePair.base}
          article={baseArticle}
          terms={terms}
          showGeneratedMeta={showGeneratedMeta}
        />
        <ArticlePane
          role="target"
          language={languagePair.target}
          article={targetArticle}
          terms={terms}
          showGeneratedMeta={showGeneratedMeta}
        />
      </div>

      <div className="border-t border-white/10 p-4 sm:p-5">
        {canShowAnalysis && analysis ? (
          <div className="grid gap-4 lg:grid-cols-3">
            <AnalysisList title={`基準言語の要点 (${languagePair.base.code})`} items={analysis.cnPoints} />
            <AnalysisList title={`対象言語の要点 (${languagePair.target.code})`} items={analysis.jpPoints} />
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
            <NarrativeTile label={displayStatus.copy} value="このペアは未分析または片側のみの記事です。" />
            <NarrativeTile
              label="接続性"
              value={
                baseArticle && targetArticle
                  ? "本文比較の候補です。"
                  : "片側掲載または未接続の対象言語として観測されています。"
              }
            />
            <NarrativeTile label="キーワード" value={terms.join(" / ") || "n/a"} />
          </div>
        )}
      </div>
    </section>
  );
}

function ArticlePane({
  role,
  language,
  article,
  terms,
  showGeneratedMeta
}: {
  role: LanguageRole;
  language: LanguageOption;
  article?: Article;
  terms: string[];
  showGeneratedMeta: boolean;
}) {
  const roleLabel = role === "base" ? "BASE" : "TARGET";
  const label = `${roleLabel} / ${language.code}`;

  if (!article) {
    return (
      <div className="min-h-80 border-white/10 p-4 sm:p-5 lg:border-l">
        <span
          className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500"
          title={language.name}
        >
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
        <span
          className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500"
          title={language.name}
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
      {showGeneratedMeta && article.translatedTitle && article.translatedTitle !== article.title ? (
        <p className="mt-2 text-sm leading-6 text-cyan-100/80">{article.translatedTitle}</p>
      ) : null}
      {shouldShowSummary(article, showGeneratedMeta) ? (
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

function AnalysisList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
        {items.map((item) => (
          <li key={item}>{normalizeAnalysisText(item)}</li>
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
      <p className="mt-2 text-sm leading-6 text-slate-200">{normalizeAnalysisText(value)}</p>
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
          基準言語版と対象言語版のライブ取得待ちです。
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

function normalizeAnalysisText(input: string) {
  return input
    .replace(/“([^”]+)”/g, "「$1」")
    .replace(/"([^"]+)"/g, "「$1」")
    .replace(/（CN）|\(CN\)/g, "（中国語版）")
    .replace(/（JP）|\(JP\)/g, "（対象言語版）")
    .replace(/具体提及/g, "具体的に言及")
    .replace(/未提及/g, "言及していない")
    .replace(/中国强调/g, "中国語版は")
    .replace(/日本强调/g, "対象言語版は")
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

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function parseSnapshotResponse(response: Response): Promise<RefreshResult> {
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => undefined)
    : await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(apiErrorMessage(payload) || `${response.status} ${response.statusText}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("APIレスポンスを読み取れませんでした。");
  }

  return payload as RefreshResult;
}

function apiErrorMessage(payload: unknown) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const value = (payload as { error?: unknown; message?: unknown }).error ??
    (payload as { message?: unknown }).message;
  return typeof value === "string" ? value : "";
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rememberClientSnapshot(cache: Map<string, RefreshResult>, snapshot: RefreshResult) {
  const sourceLanguage = snapshot.baseLanguage ?? "CN";
  const targetLanguage = snapshot.targetLanguage ?? "JP";
  const dates = snapshotDates(snapshot);

  if (!snapshot.activeDate) {
    cache.set(latestSnapshotKey(sourceLanguage, targetLanguage), snapshot);
  }

  if (snapshot.activeDate && isArchiveDate(snapshot.activeDate)) {
    cache.set(datedSnapshotKey(sourceLanguage, targetLanguage, snapshot.activeDate), snapshot);
  }

  if (dates.length) {
    cache.set(rangeSnapshotKey(sourceLanguage, targetLanguage, dates), snapshot);
    if (dates.length === 1) {
      cache.set(datedSnapshotKey(sourceLanguage, targetLanguage, dates[0]), snapshot);
    }
  }
}

function findClientSnapshot(
  cache: Map<string, RefreshResult>,
  options: {
    sourceLanguage: Source;
    targetLanguage: Source;
    archiveDate: string;
    dates: string[];
  }
) {
  const dates = normalizeDateList(options.dates);
  const keys =
    options.archiveDate !== "LATEST"
      ? [
          datedSnapshotKey(options.sourceLanguage, options.targetLanguage, options.archiveDate),
          dates.length ? rangeSnapshotKey(options.sourceLanguage, options.targetLanguage, dates) : "",
          latestSnapshotKey(options.sourceLanguage, options.targetLanguage)
        ]
      : [
          dates.length ? rangeSnapshotKey(options.sourceLanguage, options.targetLanguage, dates) : "",
          latestSnapshotKey(options.sourceLanguage, options.targetLanguage)
        ];

  for (const key of keys) {
    const snapshot = key ? cache.get(key) : undefined;
    if (snapshot) return snapshot;
  }

  return undefined;
}

function snapshotDates(snapshot: RefreshResult) {
  return normalizeDateList(
    snapshot.targetDateScope?.length ? snapshot.targetDateScope : snapshot.dateScope
  );
}

function snapshotScopeLabel(snapshot: RefreshResult, archiveDate: string) {
  if (archiveDate !== "LATEST") return archiveDate;
  const dates = snapshotDates(snapshot);
  return dates.length ? formatScopeRange(dates) : "LATEST";
}

function latestSnapshotKey(sourceLanguage: Source, targetLanguage: Source) {
  return `latest:${sourceLanguage}:${targetLanguage}`;
}

function datedSnapshotKey(sourceLanguage: Source, targetLanguage: Source, date: string) {
  return `date:${sourceLanguage}:${targetLanguage}:${date}`;
}

function rangeSnapshotKey(sourceLanguage: Source, targetLanguage: Source, dates: string[]) {
  return `range:${sourceLanguage}:${targetLanguage}:${normalizeDateList(dates).join(",")}`;
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

function dateRangeFromScope(scope?: string[]) {
  const dates = normalizeDateList(scope);
  if (!dates.length) {
    const today = toLocalDate(new Date());
    return {
      from: today,
      to: today
    };
  }
  return {
    from: dates[dates.length - 1],
    to: dates[0]
  };
}

function dateScopeFromRange(fromInput: string, toInput: string) {
  const from = normalizeDateInput(fromInput);
  const to = normalizeDateInput(toInput);
  if (!from || !to) return [];

  const start = from <= to ? from : to;
  const end = from <= to ? to : from;
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end && dates.length < 31) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates.sort((a, b) => b.localeCompare(a));
}

function normalizeDateList(scope?: string[]) {
  return [...new Set((scope ?? []).map(normalizeDateInput).filter((date): date is string => Boolean(date)))]
    .sort((a, b) => b.localeCompare(a));
}

function normalizeDateInput(input?: string) {
  const match = input?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return isRealDate(normalized) ? normalized : undefined;
}

function addDays(date: string, offset: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function isRealDate(input: string) {
  const [year, month, day] = input.split("-").map(Number);
  if (!year || !month || !day) return false;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10) === input;
}

function formatScopeRange(scope?: string[]) {
  const range = dateRangeFromScope(scope);
  return range.from === range.to ? range.to : `${range.from} - ${range.to}`;
}

function getLanguageOptions(data: RefreshResult): LanguageOption[] {
  const values = data.availableLanguages?.length
    ? data.availableLanguages
    : [
        {
          code: "CN" as Source,
          label: "Chinese",
          nativeName: "中文",
          editionLabel: "中国語版",
          group: "base" as const,
          enabled: true
        },
        {
          code: "JP" as Source,
          label: "Japanese",
          nativeName: "日本語",
          editionLabel: "日本語版",
          group: "foreign" as const,
          enabled: true
        }
      ];

  return values.map((language) => ({
    code: language.code,
    source: language.code,
    name: language.label,
    nativeName: language.nativeName,
    editionLabel: language.editionLabel,
    group: language.group,
    enabled: language.enabled
  }));
}

function makeLanguagePair(
  languages: LanguageOption[],
  baseLanguage: Source,
  targetLanguage: Source
): LanguagePairConfig {
  const fallbackBase = languages.find((language) => language.source === "CN") ?? languages[0];
  const base =
    languages.find((language) => language.source === baseLanguage) ?? fallbackBase;
  const target =
    languages.find((language) => language.source === targetLanguage) ??
    languages.find((language) => language.source === "JP") ??
    languages.find((language) => language.source !== base.source) ??
    base;

  return {
    id: `${base.source}-${target.source}`,
    base,
    target
  };
}

function getSourceCount(data: RefreshResult, source?: Source) {
  if (!source) return 0;
  const direct = data.stats.countsBySource?.[source];
  if (typeof direct === "number") return direct;
  if (source === data.baseLanguage && typeof data.stats.baseCount === "number") {
    return data.stats.baseCount;
  }
  if (source === data.targetLanguage && typeof data.stats.targetCount === "number") {
    return data.stats.targetCount;
  }
  if (source === data.baseLanguage && data.baseArticles) return data.baseArticles.length;
  if (source === data.targetLanguage && data.targetArticles) return data.targetArticles.length;
  if (source === (data.baseLanguage ?? "CN")) return data.stats.cnCount;
  if (source === (data.targetLanguage ?? "JP")) return data.stats.jpCount;
  if (source === "CN") return data.stats.cnCount;
  return 0;
}

function getRoleArticle(
  pair: ArticlePair,
  role: LanguageRole,
  languagePair: LanguagePairConfig
) {
  const source = role === "base" ? languagePair.base.source : languagePair.target.source;
  if (!source) return undefined;
  return getSourceArticle(pair, source);
}

function getSourceArticle(pair: ArticlePair, source: Source) {
  return (
    pair.articlesBySource?.[source] ??
    (pair.base?.source === source ? pair.base : undefined) ??
    (pair.target?.source === source ? pair.target : undefined) ??
    (pair.cn?.source === source ? pair.cn : undefined) ??
    (pair.jp?.source === source ? pair.jp : undefined)
  );
}

function hasMatchedArticles(pair: ArticlePair, languagePair: LanguagePairConfig) {
  return Boolean(
    getRoleArticle(pair, "base", languagePair) &&
      getRoleArticle(pair, "target", languagePair)
  );
}

function shouldShowGeneratedMeta(pair: ArticlePair, languagePair: LanguagePairConfig) {
  return languagePair.target.source === "JP" || hasMatchedArticles(pair, languagePair);
}

function shouldShowSummary(article: Article, showGeneratedMeta: boolean) {
  return showGeneratedMeta || !hasGeneratedTranslation(article);
}

function hasGeneratedTranslation(article: Article) {
  return Boolean(article.translatedTitle && article.translatedTitle !== article.title);
}

function matchesStatusFilter(
  pair: ArticlePair,
  status: StatusFilter,
  languagePair: LanguagePairConfig
) {
  if (status === "ALL") return true;
  const hasBase = Boolean(getRoleArticle(pair, "base", languagePair));
  const hasTarget = Boolean(getRoleArticle(pair, "target", languagePair));
  if (status === "MATCHED") return hasBase && hasTarget;
  if (status === "BASE_ONLY") return hasBase && !hasTarget;
  return !hasBase && hasTarget;
}

function getFilterLabel(status: StatusFilter, languagePair: LanguagePairConfig) {
  switch (status) {
    case "BASE_ONLY":
      return languagePair.base.code;
    case "TARGET_ONLY":
      return languagePair.target.code;
    default:
      return status;
  }
}

function getFilterBadgeLabel(
  status: Exclude<StatusFilter, "ALL">,
  languagePair: LanguagePairConfig
) {
  if (status === "BASE_ONLY") return `${languagePair.base.code} ONLY`;
  if (status === "TARGET_ONLY") return `${languagePair.target.code} ONLY`;
  return "MATCHED";
}

function getBadgeStatus(
  status: Exclude<StatusFilter, "ALL">,
  languagePair: LanguagePairConfig
): PairStatus {
  if (status === "MATCHED") return "MATCHED";
  if (status === "BASE_ONLY") return "CN ONLY";
  return languagePair.target.source === "JP" ? "JP ONLY" : "TARGET ONLY";
}

function getDisplayStatus(pair: ArticlePair, languagePair: LanguagePairConfig) {
  const hasBase = Boolean(getRoleArticle(pair, "base", languagePair));
  const hasTarget = Boolean(getRoleArticle(pair, "target", languagePair));

  if (hasBase && hasTarget) {
    return {
      status: "MATCHED" as PairStatus,
      label: "MATCHED",
      copy: "対応あり"
    };
  }

  if (hasBase) {
    return {
      status: getBadgeStatus("BASE_ONLY", languagePair),
      label: `${languagePair.base.code} ONLY`,
      copy: "基準言語のみ"
    };
  }

  if (hasTarget) {
    return {
      status: getBadgeStatus("TARGET_ONLY", languagePair),
      label: `${languagePair.target.code} ONLY`,
      copy: "対象言語のみ"
    };
  }

  return {
    status: pair.status,
    label: pair.status,
    copy: "未接続"
  };
}

function getDifferenceKinds(pair: ArticlePair, languagePair: LanguagePairConfig) {
  const baseArticle = getRoleArticle(pair, "base", languagePair);
  const targetArticle = getRoleArticle(pair, "target", languagePair);
  if (!baseArticle || !targetArticle) return [];

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
    Math.abs(baseArticle.body.length - targetArticle.body.length) > 1800;
  const hasFramingDiff = pair.status === "FRAMING SHIFT" || framingScore >= 55;

  return [
    ...(hasBodyDiff ? ["BODY DIFF"] : []),
    ...(hasFramingDiff ? ["FRAMING"] : [])
  ];
}

function getLensCopy(status: StatusFilter, languagePair: LanguagePairConfig) {
  switch (status) {
    case "BASE_ONLY":
      return {
        title: "基準言語にのみ存在する記事",
        description:
          `${languagePair.base.code} には出ているが、${languagePair.target.code} では対応記事が見つからない記事です。対象言語へ出さない話題の候補として見ます。`
      };
    case "TARGET_ONLY":
      return {
        title: "対象言語にのみ存在する記事",
        description:
          `${languagePair.target.code} には出ているが、${languagePair.base.code} の取得範囲で対応記事が見つからない記事です。対象言語向けに選ばれた話題の候補として見ます。`
      };
    case "MATCHED":
      return {
        title: "同じ話題として対応した記事",
        description:
          "本文差分や論調差分の有無に関係なく、基準言語版と対象言語版が同じ話題を扱っている記事ペアです。差分がある場合はカード上に BODY DIFF / FRAMING が追加表示されます。"
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
