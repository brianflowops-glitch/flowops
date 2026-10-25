import { publicOrg, requireApi } from "@/lib/server/context";
import { listServices, loadState, orgToday } from "@/lib/server/pipeline";
import { integrationStatus } from "@/lib/server/integrations/notify";

export async function GET(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const [state, services] = await Promise.all([loadState(ctx.org.id), listServices(ctx.org.id)]);
  return Response.json(
    { user: ctx.user, role: ctx.role, org: publicOrg(ctx.org), today: orgToday(ctx.org), state, services, integrations: integrationStatus() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
