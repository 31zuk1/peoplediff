import Dashboard from "@/components/Dashboard";
import { readSnapshot } from "@/lib/cache";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialData = await readSnapshot();
  const allowRefresh =
    process.env.PEOPLEDIFF_PUBLIC_REFRESH === "true" ||
    (!process.env.VERCEL && !process.env.PEOPLEDIFF_ADMIN_TOKEN);
  return <Dashboard initialData={initialData} allowRefresh={allowRefresh} />;
}
