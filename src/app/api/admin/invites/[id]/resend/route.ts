import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { sendInviteEmail } from "@/lib/server/invite-email";
import { inviteExpiry, inviteLink, newInviteToken } from "@/lib/tenancy/invites";
import { canInviteRole } from "@/lib/tenancy/team-rules";

/**
 * Resend: issues a NEW token (the old link stops working), resets the expiry, and emails it
 * when Resend is configured. Works for pending, expired or revoked invites — not accepted ones.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const db = getDb();
  const [inv] = await db.select().from(schema.teamInvite).where(and(eq(schema.teamInvite.id, id), eq(schema.teamInvite.organizationId, ctx.org.id))).limit(1);
  if (!inv) return Response.json({ error: "Invite not found" }, { status: 404 });
  if (!canInviteRole(ctx.role, inv.role)) return Response.json({ error: "Only the Owner can manage Admin invites" }, { status: 403 });
  if (inv.acceptedAt) return Response.json({ error: "That invite was already accepted" }, { status: 400 });

  const { token, tokenHash } = newInviteToken();
  const link = inviteLink(token, req);
  const [updated] = await db
    .update(schema.teamInvite)
    .set({ tokenHash, expiresAt: inviteExpiry(), revokedAt: null })
    .where(and(eq(schema.teamInvite.id, id), eq(schema.teamInvite.organizationId, ctx.org.id), isNull(schema.teamInvite.acceptedAt)))
    .returning();
  if (!updated) return Response.json({ error: "That invite was just accepted" }, { status: 409 });
  const mail = await sendInviteEmail(inv.email, ctx.org.name, inv.role, ctx.user.name, link);
  if (mail.sent) await db.update(schema.teamInvite).set({ lastSentAt: new Date() }).where(eq(schema.teamInvite.id, id));
  return Response.json({ invite: { id, email: inv.email, role: inv.role, expiresAt: updated.expiresAt }, link, emailed: mail.sent }, { headers: { "Cache-Control": "no-store" } });
}
