import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { canInviteRole } from "@/lib/tenancy/team-rules";

/** Revoke an invite (kept for history; its link stops working immediately). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const db = getDb();
  const [inv] = await db.select().from(schema.teamInvite).where(and(eq(schema.teamInvite.id, id), eq(schema.teamInvite.organizationId, ctx.org.id))).limit(1);
  if (!inv) return Response.json({ error: "Invite not found" }, { status: 404 });
  if (!canInviteRole(ctx.role, inv.role)) return Response.json({ error: "Only the Owner can manage Admin invites" }, { status: 403 });
  if (inv.acceptedAt) return Response.json({ error: "That invite was already accepted" }, { status: 400 });
  await db
    .update(schema.teamInvite)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.teamInvite.id, id), eq(schema.teamInvite.organizationId, ctx.org.id), isNull(schema.teamInvite.acceptedAt), isNull(schema.teamInvite.revokedAt)));
  return Response.json({ ok: true });
}
