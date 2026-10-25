import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

export async function GET(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const db = getDb();
  const [members, invites] = await Promise.all([
    db
      .select({ id: schema.member.id, role: schema.member.role, userId: schema.user.id, name: schema.user.name, email: schema.user.email, since: schema.member.createdAt })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, ctx.org.id)),
    db.select({ id: schema.staffInvite.id, email: schema.staffInvite.email, at: schema.staffInvite.createdAt }).from(schema.staffInvite).where(eq(schema.staffInvite.organizationId, ctx.org.id)),
  ]);
  return Response.json({ members, invites, me: ctx.user.id });
}

/** Owner invites a staff member by email. They become Staff when they sign up with that email. */
export async function POST(req: Request) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const parsed = z.object({ email: z.string().trim().toLowerCase().email() }).safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const db = getDb();
  const [existingUser] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, parsed.data.email)).limit(1);
  if (existingUser) return badRequest("That email already has a FlowOps account (accounts belong to one organization)");
  const inserted = await db
    .insert(schema.staffInvite)
    .values({ id: `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, organizationId: ctx.org.id, email: parsed.data.email, invitedBy: ctx.user.id })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return badRequest("That email already has a pending invite");
  return Response.json({ invite: inserted[0] });
}

/** Remove a pending invite ({inviteId}) or a staff member ({memberId}). Owners can't remove owners. */
export async function DELETE(req: Request) {
  const ctx = await requireApi(req, { owner: true });
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
    if (m.role === "owner") return badRequest("Owners can't be removed here");
    // Removing staff deletes their login (accounts belong to one organization).
    await db.delete(schema.user).where(eq(schema.user.id, m.userId));
  }
  return Response.json({ ok: true });
}
