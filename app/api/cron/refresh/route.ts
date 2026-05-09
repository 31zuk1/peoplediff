import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { isAuthorizedBearer } from "@/lib/auth";
import { writeSnapshot } from "@/lib/cache";
import { refreshSnapshot } from "@/lib/compare";
import { DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGE_CODES } from "@/lib/languages";
import { acquireSnapshotLock } from "@/lib/snapshot-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JST_TIME_ZONE = "Asia/Tokyo";
type TargetLanguage = (typeof TARGET_LANGUAGE_CODES)[number];

export async function GET(request: Request) {
  if (!isAuthorizedBearer(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const targetPlan = cronTargets(process.env.PEOPLEDIFF_CRON_TARGETS);
  if (!targetPlan.targets.length) {
    return NextResponse.json(
      {
        error: "No valid cron targets configured",
        invalidTargets: targetPlan.invalidTargets
      },
      { status: 400 }
    );
  }

  const dates = todayAndYesterdayInJst();
  const results = [];

  for (const targetLanguage of targetPlan.targets) {
    const refreshOptions = {
      targetLanguage,
      dates,
      sourceLookbackDays: 1,
      limit: numberFromEnv("PEOPLEDIFF_CRON_LIMIT"),
      maxPages: numberFromEnv("PEOPLEDIFF_CRON_MAX_PAGES"),
      maxArticles: numberFromEnv("PEOPLEDIFF_CRON_MAX_ARTICLES"),
      aiArticleLimit: numberFromEnv("PEOPLEDIFF_CRON_AI_ARTICLE_LIMIT")
    };
    const lock = await acquireSnapshotLock(refreshLockName(`CN-${targetLanguage}`), refreshLockTtlMs());
    if (!lock) {
      results.push({
        targetLanguage,
        ok: false,
        locked: true,
        error: "Refresh already running"
      });
      continue;
    }

    try {
      const snapshot = await refreshSnapshot(refreshOptions);
      const archived = await writeSnapshot(snapshot);
      results.push({
        targetLanguage,
        ok: true,
        generatedAt: archived.generatedAt,
        archiveDates: archived.archiveDates,
        stats: archived.stats,
        warnings: archived.warnings
      });
    } catch (error) {
      results.push({
        targetLanguage,
        ok: false,
        error: errorMessage(error)
      });
    } finally {
      await lock.release();
    }
  }

  const hasFailure = results.some((result) => !result.ok);
  return NextResponse.json(
    {
      refreshedAt: new Date().toISOString(),
      timeZone: JST_TIME_ZONE,
      dates,
      targets: targetPlan.targets,
      invalidTargets: targetPlan.invalidTargets,
      results
    },
    { status: hasFailure ? 500 : 200 }
  );
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

function todayAndYesterdayInJst() {
  const today = formatJstDate(new Date());
  return [today, addDays(today, -1)];
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

function numberFromEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function refreshLockName(signature: string) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 32);
}

function refreshLockTtlMs() {
  const configured = Number(process.env.PEOPLEDIFF_REFRESH_LOCK_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return 10 * 60 * 1000;
  return Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.round(configured) * 1000));
}
