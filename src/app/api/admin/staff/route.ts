import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { canManageTeam, requireApi, type Role } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";
import { inviteStatus } from "@/lib/tenancy/invites";
import { RemoveMemberError, removeMemberFromOrg } from "@/lib/tenancy/membership";
import { canInviteRole, canRemove, canResetFor } from "@/lib/tenancy/team-rules";

/** Team overview: members, token invites (with status), legacy email-match invites. */
export async function GET(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const db = getDb();
  const manage = canManageTeam(ctx.role);
  const [members, invites, legacyInvites] = await Promise.all([
    db
      .select({ id: schema.member.id, role: schema.member.role, userId: schema.user.id, name: schema.user.name, email: schema.user.email, emailVerified: schema.user.emailVerified, since: schema.member.createdAt })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, ctx.org.id)),
    manage
      ? db.select().from(schema.teamInvite).where(eq(schema.teamInvite.organizationId, ctx.org.id)).orderBy(desc(schema.teamInvite.createdAt)).limit(50)
      : Promise.resolve([]),
    manage
      ? db.select({ id: schema.staffInvite.id, email: schema.staffInvite.email, at: schema.staffInvite.createdAt }).from(schema.staffInvite).where(eq(schema.staffInvite.organizationId, ctx.org.id))
      : Promise.resolve([]),
  ]);
  const actor = { id: ctx.user.id, role: ctx.role };
  return Response.json(
    {
      me: ctx.user.id,
      myRole: ctx.role,
      canManage: manage,
      inviteRoles: (["admin", "staff"] as const).filter((r) => canInviteRole(ctx.role, r)),
      members: members.map((m) => ({ ...m, canReset: canResetFor(actor, { userId: m.userId, role: m.role as Role }), canRemove: canRemove(actor, { userId: m.userId, role: m.role as Role }) })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, status: inviteStatus(i), createdAt: i.createdAt, expiresAt: i.expiresAt, lastSentAt: i.lastSentAt, acceptedAt: i.acceptedAt, revokedAt: i.revokedAt })),
      legacyInvites,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Remove a legacy invite ({inviteId}) or a member ({memberId}). Owners can't be removed. */
export async function DELETE(req: Request) {
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  const parsed = z.object({ inviteId: z.string().optional(), memberId: z.string().optional() }).safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const db = getDb();
  if (parsed.data.inviteId)
    await db.delete(schema.staffInvite).where(and(eq(schema.staffInvite.id, parsed.data.inviteId), eq(schema.staffInvite.organizationId, ctx.org.id)));
  if (parsed.data.memberId) {
    const [m] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.id, parsed.data.memberId), eq(schema.member.organizationId, ctx.org.id)))
      .limit(1);
    if (!m) return Response.json({ error: "Member not found" }, { status: 404 });
    if (!canRemove({ id: ctx.user.id, role: ctx.role }, { userId: m.userId, role: m.role }))
      return Response.json({ error: m.role === "owner" ? "Owners can't be removed here" : "You can't remove this member" }, { status: 403 });
    // Remove only their membership in THIS org (never the account itself) and audit it.
    try {
      const removed = await removeMemberFromOrg({ orgId: ctx.org.id, memberId: m.id, actor: `user:${ctx.user.email}` });
      if (!removed) return Response.json({ error: "Member not found" }, { status: 404 });
    } catch (e) {
      if (e instanceof RemoveMemberError) return Response.json({ error: e.message }, { status: 403 });
      throw e;
    }
  }
  return Response.json({ ok: true });
}
