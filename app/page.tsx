import AnchoredDashboard from "@/components/AnchoredDashboard";
import Dashboard from "@/components/Dashboard";
import { isLocalDevelopmentWithoutAdminToken } from "@/lib/auth";
import { readSnapshot } from "@/lib/cache";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialData = await readSnapshot(undefined, { mode: defaultCollectionMode() });
  const allowRefresh = isLocalDevelopmentWithoutAdminToken();
  if (initialData.collectionMode === "jp-major") {
    return <AnchoredDashboard initialData={initialData} />;
  }
  return <Dashboard initialData={initialData} allowRefresh={allowRefresh} />;
}

function defaultCollectionMode() {
  return process.env.PEOPLEDIFF_DEFAULT_MODE || "jp-major";
}
