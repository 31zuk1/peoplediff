import { NextResponse } from "next/server";
import { readSnapshot, writeSnapshot } from "@/lib/cache";
import { refreshOptionsSignature, refreshSnapshot } from "@/lib/compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_REFRESH_INFLIGHT__:
    | Map<string, Promise<Awaited<ReturnType<typeof refreshSnapshot>>>>
    | undefined;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const snapshot = await readSnapshot(searchParams.get("date") ?? undefined, {
      sourceLanguage: searchParams.get("sourceLanguage") ?? searchParams.get("source"),
      targetLanguage: searchParams.get("targetLanguage") ?? searchParams.get("target")
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const body = asRecord(await request.json().catch(() => ({})));
    const aiArticleLimit = firstValue(body.aiArticleLimit, searchParams.get("aiArticleLimit"));
    const refreshOptions = {
      limit: numberValue(firstValue(body.limit, searchParams.get("limit"))),
      dates: dateList(firstValue(body.dates, searchParams.get("dates"))),
      sourceDates: dateList(firstValue(body.sourceDates, searchParams.get("sourceDates"))),
      targetDates: dateList(firstValue(body.targetDates, searchParams.get("targetDates"))),
      dateFrom: stringValue(firstValue(body.dateFrom, searchParams.get("dateFrom"))),
      dateTo: stringValue(firstValue(body.dateTo, searchParams.get("dateTo"))),
      sourceDateFrom: stringValue(
        firstValue(body.sourceDateFrom, searchParams.get("sourceDateFrom"))
      ),
      sourceDateTo: stringValue(firstValue(body.sourceDateTo, searchParams.get("sourceDateTo"))),
      targetDateFrom: stringValue(
        firstValue(body.targetDateFrom, searchParams.get("targetDateFrom"))
      ),
      targetDateTo: stringValue(firstValue(body.targetDateTo, searchParams.get("targetDateTo"))),
      sourceLookbackDays: numberValue(
        firstValue(body.sourceLookbackDays, searchParams.get("sourceLookbackDays"))
      ),
      maxPages: numberValue(firstValue(body.maxPages, searchParams.get("maxPages"))),
      maxArticles: numberValue(firstValue(body.maxArticles, searchParams.get("maxArticles"))),
      aiArticleLimit: numberValue(aiArticleLimit),
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
    const cacheTtlSeconds =
      numberValue(firstValue(body.cacheTtlSeconds, searchParams.get("cacheTtlSeconds"))) ?? 900;
    const forceRefresh = booleanValue(firstValue(body.forceRefresh, searchParams.get("forceRefresh")));
    const signature = refreshOptionsSignature(refreshOptions);

    if (!forceRefresh && cacheTtlSeconds > 0) {
      const cached = await readSnapshot(undefined, {
        sourceLanguage: refreshOptions.sourceLanguage,
        targetLanguage: refreshOptions.targetLanguage
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
    const running = inFlight.get(signature);
    if (running) {
      const snapshot = await running;
      return NextResponse.json(snapshot, {
        headers: {
          "x-peoplediff-cache": "inflight"
        }
      });
    }

    const refreshTask = refreshSnapshot(refreshOptions)
      .then((snapshot) => writeSnapshot(snapshot))
      .finally(() => {
        inFlight.delete(signature);
      });
    inFlight.set(signature, refreshTask);
    const archivedSnapshot = await refreshTask;
    return NextResponse.json(archivedSnapshot, {
      headers: {
        "x-peoplediff-cache": "miss"
      }
    });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function dateList(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
