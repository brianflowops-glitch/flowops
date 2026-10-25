import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { publicOrg, requireApi } from "@/lib/server/context";
import { listServices, loadState, orgToday } from "@/lib/server/pipeline";
import { integrationStatus } from "@/lib/server/integrations/notify";

/** Team size for the onboarding checklist: members + invites ever sent (not revoked). */
async function teamCounts(orgId: string) {
  const db = getDb();
  const [[m], [i]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.member).where(eq(schema.member.organizationId, orgId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.teamInvite)
      .where(and(eq(schema.teamInvite.organizationId, orgId), isNull(schema.teamInvite.revokedAt))),
  ]);
  return { members: m?.n ?? 0, invites: i?.n ?? 0 };
}

export async function GET(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const [state, services, team] = await Promise.all([loadState(ctx.org.id), listServices(ctx.org.id), teamCounts(ctx.org.id)]);
  return Response.json(
    {
      user: ctx.user,
      role: ctx.role,
      org: { ...publicOrg(ctx.org), createdAt: ctx.org.createdAt },
      today: orgToday(ctx.org),
      state,
      services,
      team,
      integrations: integrationStatus(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
