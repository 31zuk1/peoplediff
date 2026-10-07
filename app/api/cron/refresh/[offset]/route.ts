import { handleCronRefresh } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = {
  params: Promise<{ offset: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const params = await context.params;
  return handleCronRefresh(request, params.offset);
}
