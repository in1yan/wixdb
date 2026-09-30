import { fetchStats } from "@/lib/cache-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await fetchStats();
  const anyOnline = stats.lru.status === "ok" || stats.lfu.status === "ok";
  return Response.json(stats, { status: anyOnline ? 200 : 503 });
}
