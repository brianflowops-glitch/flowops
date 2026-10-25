import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { ADMIN_RESET_TTL_HOURS, createAdminResetLink } from "@/lib/server/reset-link";
import { canResetFor } from "@/lib/tenancy/team-rules";

/**
 * Owner/Admin generates a one-time password-reset link for a member of THEIR org, to share by
 * hand while email is simulated. Returned only in this response; never logged or stored in clear
 * beyond Better Auth's own verification row (consumed on use, expires in 24h).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const [m] = await getDb()
    .select({ userId: schema.member.userId, role: schema.member.role, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.id, id), eq(schema.member.organizationId, ctx.org.id)))
    .limit(1);
  if (!m) return Response.json({ error: "Member not found" }, { status: 404 });
  if (!canResetFor({ id: ctx.user.id, role: ctx.role }, m)) return Response.json({ error: "You can't generate a reset link for this member" }, { status: 403 });
  const { link, expiresAt } = await createAdminResetLink(m.userId, req);
  return Response.json({ link, expiresAt, email: m.email, ttlHours: ADMIN_RESET_TTL_HOURS }, { headers: { "Cache-Control": "no-store" } });
}
