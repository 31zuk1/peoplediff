import { NextResponse } from "next/server";
import { readSnapshot, writeSnapshot } from "@/lib/cache";
import { refreshSnapshot } from "@/lib/compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const snapshot = await readSnapshot(searchParams.get("date") ?? undefined);
  return NextResponse.json(snapshot);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const snapshot = await refreshSnapshot({
    limit: Number(body.limit ?? 8),
    dates: Array.isArray(body.dates) ? body.dates : undefined,
    maxPages: Number(body.maxPages ?? 8),
    maxArticles: Number(body.maxArticles ?? 240)
  });
  const archivedSnapshot = await writeSnapshot(snapshot);
  return NextResponse.json(archivedSnapshot);
}
