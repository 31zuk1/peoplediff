import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { isAuthorizedAdminRequest } from "@/lib/auth";
import { readSnapshot, writeSnapshot } from "@/lib/cache";
import { refreshOptionsSignature, refreshSnapshot } from "@/lib/compare";
import { jpMajorRefreshSignature, refreshJapaneseMajorSnapshot } from "@/lib/jp-major";
import { resolveCompareLanguages } from "@/lib/languages";
import { acquireSnapshotLock } from "@/lib/snapshot-store";
import { collectionMode, defaultCollectionMode } from "@/lib/collection-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_REFRESH_INFLIGHT__:
    | Map<
        string,
        {
          signature: string;
          promise: Promise<
            Awaited<
              ReturnType<typeof refreshSnapshot> | ReturnType<typeof refreshJapaneseMajorSnapshot>
            >
          >;
        }
      >
    | undefined;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const snapshot = await readSnapshot(dateValue(searchParams.get("date")), {
      sourceLanguage: searchParams.get("sourceLanguage") ?? searchParams.get("source"),
      targetLanguage: searchParams.get("targetLanguage") ?? searchParams.get("target"),
      mode: collectionModeValue(searchParams.get("mode") ?? searchParams.get("collectionMode")),
      dateFrom: dateValue(searchParams.get("dateFrom")),
      dateTo: dateValue(searchParams.get("dateTo")),
      windowDays: searchParams.get("windowDays") ?? undefined
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const body = asRecord(await request.json().catch(() => ({})));
    const aiArticleLimit = firstValue(body.aiArticleLimit, searchParams.get("aiArticleLimit"));
    const mode = collectionModeValue(
      firstValue(
        body.mode,
        body.collectionMode,
        searchParams.get("mode"),
        searchParams.get("collectionMode")
      )
    );
    const refreshOptions = {
      limit: numberValue(firstValue(body.limit, searchParams.get("limit"))),
      dates: dateList(firstValue(body.dates, searchParams.get("dates"))),
      sourceDates: dateList(firstValue(body.sourceDates, searchParams.get("sourceDates"))),
      targetDates: dateList(firstValue(body.targetDates, searchParams.get("targetDates"))),
      dateFrom: dateValue(firstValue(body.dateFrom, searchParams.get("dateFrom"))),
      dateTo: dateValue(firstValue(body.dateTo, searchParams.get("dateTo"))),
      sourceDateFrom: dateValue(
        firstValue(body.sourceDateFrom, searchParams.get("sourceDateFrom"))
      ),
      sourceDateTo: dateValue(firstValue(body.sourceDateTo, searchParams.get("sourceDateTo"))),
      targetDateFrom: dateValue(
        firstValue(body.targetDateFrom, searchParams.get("targetDateFrom"))
      ),
      targetDateTo: dateValue(firstValue(body.targetDateTo, searchParams.get("targetDateTo"))),
      sourceLookbackDays: numberValue(
        firstValue(body.sourceLookbackDays, searchParams.get("sourceLookbackDays")),
        7
      ),
      maxPages: numberValue(firstValue(body.maxPages, searchParams.get("maxPages")), 12),
      maxArticles: numberValue(firstValue(body.maxArticles, searchParams.get("maxArticles")), 480),
      aiArticleLimit: numberValue(aiArticleLimit, 120),
      useAi: !explicitFalse(firstValue(body.useAi, body.ai, searchParams.get("useAi"), searchParams.get("ai"))),
      sourceLanguage: firstValue(
        body.sourceLanguage,
        body.source,
        searchParams.get("sourceLanguage"),
        searchParams.get("source")
      ),
      targetLanguage: firstValue(
        body.targetLanguage,
        body.target,
        searchParams.get("targetLanguage"),
        searchParams.get("target")
      )
    };
    const jpMajorOptions = {
      dates: refreshOptions.dates ?? refreshOptions.targetDates,
      dateFrom: refreshOptions.dateFrom ?? refreshOptions.targetDateFrom,
      dateTo: refreshOptions.dateTo ?? refreshOptions.targetDateTo,
      maxPages: refreshOptions.maxPages,
      maxArticles: refreshOptions.maxArticles,
      aiArticleLimit: refreshOptions.aiArticleLimit,
      maxQueries: numberValue(firstValue(body.maxQueries, searchParams.get("maxQueries")), 12),
      candidatesPerQuery: numberValue(
        firstValue(body.candidatesPerQuery, searchParams.get("candidatesPerQuery")),
        20
      ),
      useAi: refreshOptions.useAi
    };
    const cacheTtlSeconds =
      numberValue(firstValue(body.cacheTtlSeconds, searchParams.get("cacheTtlSeconds"))) ?? 900;
    const forceRefresh = booleanValue(firstValue(body.forceRefresh, searchParams.get("forceRefresh")));
    const cacheSourceLanguage = mode === "jp-major" ? "CN" : refreshOptions.sourceLanguage;
    const cacheTargetLanguage = mode === "jp-major" ? "JP" : refreshOptions.targetLanguage;
    const signature =
      mode === "jp-major"
        ? jpMajorRefreshSignature(jpMajorOptions)
        : refreshOptionsSignature(refreshOptions);
    const outputLockKey = refreshOutputLockKey(cacheSourceLanguage, cacheTargetLanguage, mode);

    if (!forceRefresh && cacheTtlSeconds > 0) {
      const cached = await readSnapshot(undefined, {
        sourceLanguage: cacheSourceLanguage,
        targetLanguage: cacheTargetLanguage,
        mode
      });
      if (isFreshMatchingSnapshot(cached, signature, cacheTtlSeconds)) {
        return NextResponse.json(cached, {
          headers: {
            "x-peoplediff-cache": "hit"
          }
        });
      }
    }

    const inFlight = refreshInFlight();
    const running = inFlight.get(outputLockKey);
    if (running) {
      if (running.signature !== signature) {
        return NextResponse.json(
          {
            error: "Refresh already running for this language pair",
            refreshSignature: signature
          },
          {
            status: 409,
            headers: {
              "x-peoplediff-cache": "inflight"
            }
          }
        );
      }
      const snapshot = await running.promise;
      return NextResponse.json(snapshot, {
        headers: {
          "x-peoplediff-cache": "inflight"
        }
      });
    }

    const lock = await acquireSnapshotLock(refreshLockName(outputLockKey), refreshLockTtlMs());
    if (!lock) {
      return NextResponse.json(
        { error: "Refresh already running", refreshSignature: signature },
        {
          status: 409,
          headers: {
            "x-peoplediff-cache": "locked"
          }
        }
      );
    }

    const refreshTask = (mode === "jp-major"
      ? refreshJapaneseMajorSnapshot(jpMajorOptions)
      : refreshSnapshot(refreshOptions)
    )
      .then((snapshot) => writeSnapshot(snapshot))
      .finally(async () => {
        inFlight.delete(outputLockKey);
        await lock.release();
      });
    inFlight.set(outputLockKey, { signature, promise: refreshTask });
    const archivedSnapshot = await refreshTask;
    return NextResponse.json(archivedSnapshot, {
      headers: {
        "x-peoplediff-cache": "miss"
      }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstValue(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function dateValue(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidRequestError("日付はYYYY-MM-DD形式で指定してください。");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidRequestError("実在する日付を指定してください。");
  }
  return value;
}

function numberValue(value: unknown, max?: number) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const rounded = Math.max(0, Math.round(number));
  return typeof max === "number" ? Math.min(max, rounded) : rounded;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function explicitFalse(value: unknown) {
  if (value === false) return true;
  if (typeof value !== "string") return false;
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

function collectionModeValue(value: unknown): "broad" | "jp-major" {
  return collectionMode(value, defaultCollectionMode());
}

function dateList(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((item) => item.trim()) : undefined;
  if (!list) throw new InvalidRequestError("日付リストの形式が不正です。");
  return list.map(dateValue).filter((date): date is string => Boolean(date));
}

class InvalidRequestError extends Error {}

function errorResponse(error: unknown) {
  if (error instanceof InvalidRequestError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // Provider errors may embed API credentials or storage URLs. Never return
  // raw exception text to the public endpoint.
  return NextResponse.json({ error: "データの読込または更新に失敗しました。保存先・収集元の状態を確認してください。" }, { status: 500 });
}

function isFreshMatchingSnapshot(
  snapshot: Awaited<ReturnType<typeof readSnapshot>>,
  signature: string,
  ttlSeconds: number
) {
  if (snapshot.mode !== "live") return false;
  if (snapshot.refreshSignature !== signature) return false;
  const generatedAt = new Date(snapshot.generatedAt).getTime();
  if (!Number.isFinite(generatedAt)) return false;
  return Date.now() - generatedAt <= ttlSeconds * 1000;
}

function refreshInFlight() {
  globalThis.__PEOPLEDIFF_REFRESH_INFLIGHT__ ??= new Map();
  return globalThis.__PEOPLEDIFF_REFRESH_INFLIGHT__;
}

function refreshLockName(signature: string) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 32);
}

function refreshOutputLockKey(
  sourceLanguage: unknown,
  targetLanguage: unknown,
  mode: "broad" | "jp-major" = "broad"
) {
  const selection = resolveCompareLanguages({ sourceLanguage, targetLanguage });
  return `${mode}:${selection.sourceLanguage}-${selection.targetLanguage}`;
}

function refreshLockTtlMs() {
  const configured = Number(process.env.PEOPLEDIFF_REFRESH_LOCK_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return 10 * 60 * 1000;
  return Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.round(configured) * 1000));
}
