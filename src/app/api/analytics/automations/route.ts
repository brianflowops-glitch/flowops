import { requireApi } from "@/lib/server/context";
import { automationTrend } from "@/lib/server/analytics/automation-trend";

/** Automations executed per week (last 12 weeks) for the signed-in user's organization. */
export async function GET(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const trend = await automationTrend(ctx.org);
  return Response.json(trend, { headers: { "Cache-Control": "no-store" } });
}
