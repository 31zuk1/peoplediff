import AnchoredDashboard from "@/components/AnchoredDashboard";
import Dashboard from "@/components/Dashboard";
import { isLocalDevelopmentWithoutAdminToken } from "@/lib/auth";
import { readSnapshot } from "@/lib/cache";
import { collectionMode, defaultCollectionMode } from "@/lib/collection-mode";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const mode = collectionMode(params.mode, defaultCollectionMode());
  const date = typeof params.date === "string" ? params.date : undefined;
  const initialData = await readSnapshot(date, {
    mode,
    targetLanguage: mode === "jp-major" ? "JP" : params.targetLanguage,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo
  });
  const allowRefresh = isLocalDevelopmentWithoutAdminToken();
  if (initialData.collectionMode === "jp-major") {
    return <AnchoredDashboard initialData={initialData} />;
  }
  return <Dashboard initialData={initialData} allowRefresh={allowRefresh} />;
}
