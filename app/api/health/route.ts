import { NextResponse } from "next/server";
import { readSnapshot } from "@/lib/cache";
import { defaultCollectionMode } from "@/lib/collection-mode";
import { snapshotHealth } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await readSnapshot(undefined, { mode: defaultCollectionMode() });
    const health = snapshot.health ?? snapshotHealth(snapshot);
    const unavailable = health.status === "empty" || health.issues.some((issue) => issue.code === "stale_snapshot");
    return NextResponse.json({
      status: health.status,
      generatedAt: snapshot.generatedAt,
      latestArticleDate: health.latestArticleDate,
      collectionMode: snapshot.collectionMode,
      dateScope: snapshot.dateScope,
      dailyUpdates: snapshot.dailyUpdates,
      stats: snapshot.stats,
      aiStatus: snapshot.run?.openaiStatus ?? "unknown",
      issues: health.issues
    }, { status: unavailable ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unavailable", error: "保存データの状態を確認できませんでした。" }, { status: 503 });
  }
}
