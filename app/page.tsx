import Dashboard from "@/components/Dashboard";
import { isLocalDevelopmentWithoutAdminToken } from "@/lib/auth";
import { readSnapshot } from "@/lib/cache";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialData = await readSnapshot();
  const allowRefresh = isLocalDevelopmentWithoutAdminToken();
  return <Dashboard initialData={initialData} allowRefresh={allowRefresh} />;
}
