import Dashboard from "@/components/Dashboard";
import { readSnapshot } from "@/lib/cache";

export default async function Home() {
  const initialData = await readSnapshot();
  return <Dashboard initialData={initialData} />;
}
