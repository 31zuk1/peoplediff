import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { isAuthorizedBearer } from "@/lib/auth";
import { writeSnapshot } from "@/lib/cache";
import { refreshSnapshot } from "@/lib/compare";
import { refreshJapaneseMajorSnapshot } from "@/lib/jp-major";
import { DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGE_CODES } from "@/lib/languages";
import { acquireSnapshotLock } from "@/lib/snapshot-store";
import { collectionMode, defaultCollectionMode } from "@/lib/collection-mode";
import { assertUsableCollection, snapshotHealth } from "@/lib/health";

const JST_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_ROLLING_DAYS = 7;
type TargetLanguage = (typeof TARGET_LANGUAGE_CODES)[number];

const defaultDependencies = {
  refreshSnapshot,
  refreshJapaneseMajorSnapshot,
  writeSnapshot,
  acquireSnapshotLock,
  now: () => new Date()
};

export function createCronRefreshHandler(overrides: Partial<typeof defaultDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function handleCronRefresh(request: Request, offsetInput?: unknown) {
    if (!isAuthorizedBearer(request, process.env.CRON_SECRET)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const mode = cronCollectionMode(searchParams.get("mode"));
    const configuredTargetPlan = cronTargets(process.env.PEOPLEDIFF_CRON_TARGETS);
    const ignoredTargets =
      mode === "jp-major"
        ? configuredTargetPlan.targets.filter((target) => target !== "JP")
        : [];
    const targetPlan =
      mode === "jp-major"
        ? {
            targets: ["JP" as TargetLanguage],
            invalidTargets: configuredTargetPlan.invalidTargets,
            ignoredTargets
          }
        : { ...configuredTargetPlan, ignoredTargets: [] as TargetLanguage[] };

    if (!targetPlan.targets.length) {
      return NextResponse.json(
        {
          error: "No valid cron targets configured",
          invalidTargets: targetPlan.invalidTargets,
          collectionMode: mode
        },
        { status: 400 }
      );
    }

    const offset = rollingOffset(offsetInput ?? searchParams.get("offset"));
    // Each job collects a completed publication day: offset 0 is yesterday.
    const targetDate = dateInJst(offset + 1, dependencies.now());
    const updateLatest = offset === latestOffset();
    const results = [];

    for (const targetLanguage of targetPlan.targets) {
      const lockKey = `${mode}:CN-${targetLanguage}`;
      let lock: Awaited<ReturnType<typeof acquireSnapshotLock>> | undefined;
      try {
        lock = await dependencies.acquireSnapshotLock(refreshLockName(lockKey), refreshLockTtlMs());
        if (!lock) {
          results.push({
            targetLanguage,
            collectionMode: mode,
            ok: false,
            locked: true,
            error: "Refresh already running"
          });
          continue;
        }

        const snapshot =
          mode === "jp-major"
            ? await dependencies.refreshJapaneseMajorSnapshot({
                dates: [targetDate],
                maxPages:
                  numberFromEnv("PEOPLEDIFF_JP_MAJOR_MAX_PAGES") ??
                  numberFromEnv("PEOPLEDIFF_CRON_MAX_PAGES"),
                maxArticles:
                  numberFromEnv("PEOPLEDIFF_JP_MAJOR_MAX_ARTICLES") ??
                  numberFromEnv("PEOPLEDIFF_CRON_MAX_ARTICLES"),
                aiArticleLimit:
                  numberFromEnv("PEOPLEDIFF_CRON_AI_ARTICLE_LIMIT", { allowZero: true }) ??
                  numberFromEnv("PEOPLEDIFF_AI_ARTICLE_LIMIT", { allowZero: true }),
                maxQueries: numberFromEnv("PEOPLEDIFF_JP_MAJOR_SEARCH_QUERIES"),
                candidatesPerQuery: numberFromEnv("PEOPLEDIFF_JP_MAJOR_CANDIDATES_PER_QUERY")
              })
            : await dependencies.refreshSnapshot({
                targetLanguage,
                dates: [targetDate],
                targetDates: [targetDate],
                sourceLookbackDays: numberFromEnv("PEOPLEDIFF_CRON_SOURCE_LOOKBACK_DAYS") ?? 3,
                limit: numberFromEnv("PEOPLEDIFF_CRON_LIMIT"),
                maxPages: numberFromEnv("PEOPLEDIFF_CRON_MAX_PAGES"),
                maxArticles: numberFromEnv("PEOPLEDIFF_CRON_MAX_ARTICLES"),
                aiArticleLimit: numberFromEnv("PEOPLEDIFF_CRON_AI_ARTICLE_LIMIT", {
                  allowZero: true
                })
              });
        assertUsableCollection(snapshot);
        const archived = await dependencies.writeSnapshot(snapshot, { updateLatest });
        const health = snapshotHealth(archived, { now: dependencies.now(), historical: true });
        if (health.status === "ok" && archived.warnings.length) {
          health.status = "degraded";
          health.issues.push({ code: "refresh_warnings", message: "取得または分析に警告があります。警告の内容を確認してください。" });
        }
        results.push({
          targetLanguage,
          collectionMode: mode,
          ok: true,
          degraded: health.status !== "ok",
          health,
          aiStatus: archived.run?.openaiStatus ?? "unknown",
          collection: archived.collection,
          generatedAt: archived.generatedAt,
          archiveDates: archived.archiveDates,
          stats: archived.stats,
          warnings: archived.warnings
        });
      } catch {
        results.push({
          targetLanguage,
          collectionMode: mode,
          ok: false,
          error: "収集または保存に失敗しました。収集元・保存先・サービス設定を確認してください。"
        });
      } finally {
        if (lock) {
          try {
            await lock.release();
          } catch {
            results.push({ targetLanguage, collectionMode: mode, ok: false, error: "更新ロックの解除に失敗しました。" });
          }
        }
      }
    }

    const hasFailure = results.some((result) => !result.ok);
    const degraded = results.some((result) => "degraded" in result && result.degraded);
    return NextResponse.json(
      {
        refreshedAt: dependencies.now().toISOString(),
        status: hasFailure ? "failed" : degraded ? "degraded" : "ok",
        degraded,
        timeZone: JST_TIME_ZONE,
        collectionMode: mode,
        rollingDayOffset: offset,
        targetDate,
        updateLatest,
        targets: targetPlan.targets,
        invalidTargets: targetPlan.invalidTargets,
        ignoredTargets: targetPlan.ignoredTargets,
        results
      },
      { status: hasFailure ? 500 : 200 }
    );
  };
}

export const handleCronRefresh = createCronRefreshHandler();

function cronCollectionMode(input: string | null): "broad" | "jp-major" {
  const configured = input ?? process.env.PEOPLEDIFF_CRON_MODE;
  return collectionMode(configured, defaultCollectionMode());
}

function cronTargets(input: string | undefined) {
  const rawTargets = input
    ? input
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [DEFAULT_TARGET_LANGUAGE];

  const targets: TargetLanguage[] = [];
  const invalidTargets: string[] = [];

  rawTargets.forEach((rawTarget) => {
    const normalized = rawTarget.normalize("NFKC").replace(/-/g, "_").toUpperCase();
    if (isTargetLanguage(normalized)) {
      if (!targets.includes(normalized)) targets.push(normalized);
    } else {
      invalidTargets.push(rawTarget);
    }
  });

  return { targets, invalidTargets };
}

function isTargetLanguage(input: string): input is TargetLanguage {
  return (TARGET_LANGUAGE_CODES as readonly string[]).includes(input);
}

function rollingOffset(input: unknown) {
  const configured = Number(input);
  if (!Number.isFinite(configured) || configured < 0) return 0;
  return Math.min(rollingDays() - 1, Math.round(configured));
}

function rollingDays() {
  const configured = numberFromEnv("PEOPLEDIFF_CRON_ROLLING_DAYS") ?? DEFAULT_ROLLING_DAYS;
  return Math.min(14, Math.max(1, configured));
}

function latestOffset() {
  const configured = numberFromEnv("PEOPLEDIFF_CRON_LATEST_OFFSET") ?? 0;
  return Math.min(rollingDays() - 1, Math.max(0, configured));
}

function dateInJst(offset: number, now: Date) {
  return addDays(formatJstDate(now), -offset);
}

function formatJstDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function numberFromEnv(name: string, options: { allowZero?: boolean } = {}) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  const minimum = options.allowZero ? 0 : 1;
  return Number.isFinite(value) && value >= minimum ? Math.round(value) : undefined;
}

function refreshLockName(signature: string) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 32);
}

function refreshLockTtlMs() {
  const configured = Number(process.env.PEOPLEDIFF_REFRESH_LOCK_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return 10 * 60 * 1000;
  return Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.round(configured) * 1000));
}
