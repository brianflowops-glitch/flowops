import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";
import { sendInviteEmail } from "@/lib/server/invite-email";
import { INVITE_ROLES, inviteExpiry, inviteLink, newInviteToken } from "@/lib/tenancy/invites";
import { canInviteRole } from "@/lib/tenancy/team-rules";

const body = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(INVITE_ROLES).default("staff") });

/** Owner/Admin invites someone by email. Always returns the copyable link; emails it when Resend is configured. */
export async function POST(req: Request) {
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const { email, role } = parsed.data;
  if (!canInviteRole(ctx.role, role)) return Response.json({ error: "Only the Owner can invite Admins" }, { status: 403 });
  const db = getDb();

  const [already] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, ctx.org.id), eq(schema.user.email, email)))
    .limit(1);
  if (already) return badRequest("That person is already on your team");
  const [pending] = await db
    .select({ id: schema.teamInvite.id })
    .from(schema.teamInvite)
    .where(
      and(
        eq(schema.teamInvite.organizationId, ctx.org.id),
        eq(schema.teamInvite.email, email),
        isNull(schema.teamInvite.acceptedAt),
        isNull(schema.teamInvite.revokedAt),
        gt(schema.teamInvite.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (pending) return badRequest("That email already has a pending invite — use Resend to get a fresh link");

  const { token, tokenHash } = newInviteToken();
  const link = inviteLink(token, req);
  const [invite] = await db
    .insert(schema.teamInvite)
    .values({
      id: `tinv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      organizationId: ctx.org.id,
      email,
      role,
      tokenHash,
      invitedBy: ctx.user.id,
      expiresAt: inviteExpiry(),
    })
    .returning();
  const mail = await sendInviteEmail(email, ctx.org.name, role, ctx.user.name, link);
  if (mail.sent) await db.update(schema.teamInvite).set({ lastSentAt: new Date() }).where(eq(schema.teamInvite.id, invite.id));
  return Response.json({ invite: { id: invite.id, email, role, expiresAt: invite.expiresAt }, link, emailed: mail.sent }, { headers: { "Cache-Control": "no-store" } });
}
