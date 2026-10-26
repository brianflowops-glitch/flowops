import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { DEMO_ORG_ID, defaultHours, slugify } from "./defaults";
import { consumeInvite, findUsableInvite } from "./invites";

const rid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

function ownerEmails(): string[] | null {
  const raw = process.env.FLOWOPS_OWNER_EMAILS?.trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Give a newly signed-up user exactly one organization membership:
 *  0. Signed up from an invite link (`inviteToken`, validated in the auth before-hook) →
 *     that invite's org and role; the token is consumed (single use).
 *  1. A legacy email-match staff invite for their email → Staff in that org.
 *  2. The primary org ("flowops-demo") has no owner yet → Owner of it. This is the
 *     "first account created becomes Owner" rule. If FLOWOPS_OWNER_EMAILS is set, only
 *     those emails can claim it (prevents a stranger claiming Brian's workspace).
 *  3. Otherwise → a brand-new organization, with the user as its Owner (multi-tenant).
 * Idempotent and serialized with an advisory lock.
 */
export async function ensureMembership(u: { id: string; email: string; name: string; businessName?: string | null; inviteToken?: string | null }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('flowops:membership'))`);
    const existing = await tx.select().from(schema.member).where(eq(schema.member.userId, u.id)).limit(1);
    if (existing.length) return existing[0];

    const email = u.email.toLowerCase();
    if (u.inviteToken) {
      const inv = await consumeInvite(tx, u.inviteToken, email, u.id);
      if (inv) {
        const [m] = await tx.insert(schema.member).values({ id: rid("mem"), organizationId: inv.organizationId, userId: u.id, role: inv.role }).returning();
        return m;
      }
      // Invite became unusable between validation and here (race) → fall through to the normal rules.
    }
    const [invite] = await tx.select().from(schema.staffInvite).where(eq(schema.staffInvite.email, email)).limit(1);
    if (invite) {
      const [m] = await tx
        .insert(schema.member)
        .values({ id: rid("mem"), organizationId: invite.organizationId, userId: u.id, role: "staff" })
        .returning();
      await tx.delete(schema.staffInvite).where(eq(schema.staffInvite.id, invite.id));
      return m;
    }

    const allow = ownerEmails();
    const [primary] = await tx.select().from(schema.organization).where(eq(schema.organization.id, DEMO_ORG_ID)).limit(1);
    if (primary && (!allow || allow.includes(email))) {
      const owners = await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, DEMO_ORG_ID), eq(schema.member.role, "owner")))
        .limit(1);
      if (!owners.length) {
        const [m] = await tx.insert(schema.member).values({ id: rid("mem"), organizationId: DEMO_ORG_ID, userId: u.id, role: "owner" }).returning();
        if (u.businessName?.trim()) {
          await tx.update(schema.organization).set({ name: u.businessName.trim().slice(0, 80) }).where(eq(schema.organization.id, DEMO_ORG_ID));
        }
        return m;
      }
    }

    const name = (u.businessName?.trim() || `${u.name.split(" ")[0] || "My"}'s workspace`).slice(0, 80);
    let slug = slugify(name);
    const taken = await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.slug, slug)).limit(1);
    if (taken.length) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const orgId = rid("org");
    await tx.insert(schema.organization).values({ id: orgId, slug, name, hours: defaultHours() });
    const [m] = await tx.insert(schema.member).values({ id: rid("mem"), organizationId: orgId, userId: u.id, role: "owner" }).returning();
    return m;
  });
}

export class InviteJoinError extends Error {}

/**
 * An existing, signed-in user accepts an invite: move them into the invite's org with its role.
 * Accounts belong to one organization, so:
 *  - Staff/Admin elsewhere → their old membership is replaced.
 *  - Owner of an *empty* auto-created workspace (no other members, no bookings) → that empty
 *    workspace is removed and they join.
 *  - Owner of a workspace with bookings or teammates (or the primary org) → refused.
 */
export async function joinOrgWithInvite(u: { id: string; email: string }, token: string) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('flowops:membership'))`);
    const [current] = await tx.select().from(schema.member).where(eq(schema.member.userId, u.id)).limit(1);
    // Validate first (without consuming) so a refusal leaves the invite usable.
    const usable = await findUsableInvite(token, u.email);
    if (!usable) throw new InviteJoinError("This invite is invalid, expired, already used, revoked, or for a different email.");
    if (current?.organizationId === usable.invite.organizationId) throw new InviteJoinError("You're already a member of this organization.");
    if (current) {
      if (current.role === "owner") {
        const [{ others }] = (
          await tx.execute(sql`select
            (select count(*)::int from member where organization_id = ${current.organizationId} and user_id <> ${u.id}) +
            (select count(*)::int from booking where organization_id = ${current.organizationId}) as others`)
        ).rows as { others: number }[];
        if (current.organizationId === DEMO_ORG_ID || Number(others) > 0)
          throw new InviteJoinError("You own a workspace that has bookings or teammates. FlowOps accounts belong to one organization, so sign up with a different email to accept this invite.");
        await tx.delete(schema.organization).where(eq(schema.organization.id, current.organizationId));
      } else {
        await tx.delete(schema.member).where(eq(schema.member.id, current.id));
      }
    }
    const inv = await consumeInvite(tx, token, u.email, u.id);
    if (!inv) throw new InviteJoinError("This invite was just used or revoked.");
    const [m] = await tx.insert(schema.member).values({ id: rid("mem"), organizationId: inv.organizationId, userId: u.id, role: inv.role }).returning();
    return m;
  });
}

export class RemoveMemberError extends Error {}

/**
 * Remove someone from one organization. Deletes ONLY their membership row in that org (never the
 * user account, bookings, or anything in other orgs), signs them out, drops any legacy email-match
 * staff invite for that org (so they aren't auto-re-added on next sign-in), and writes an audit row.
 * Next sign-in, a user with no membership gets the normal new-account flow (their own empty workspace).
 */
export async function removeMemberFromOrg(opts: { orgId: string; memberId: string; actor: string; actorEmail?: string }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('flowops:membership'))`);
    const [m] = await tx
      .select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role, email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(and(eq(schema.member.id, opts.memberId), eq(schema.member.organizationId, opts.orgId)))
      .limit(1);
    if (!m) return null;
    if (m.role === "owner") throw new RemoveMemberError("Owners can't be removed here");

    await tx.delete(schema.member).where(and(eq(schema.member.id, m.id), eq(schema.member.organizationId, opts.orgId)));
    // Sign them out everywhere: accounts belong to one organization, so their sessions were for this org.
    await tx.delete(schema.session).where(eq(schema.session.userId, m.userId));
    await tx
      .delete(schema.staffInvite)
      .where(and(eq(schema.staffInvite.organizationId, opts.orgId), eq(schema.staffInvite.email, m.email.toLowerCase())));
    await tx.insert(schema.auditEntry).values({
      id: rid("aud"),
      organizationId: opts.orgId,
      at: new Date(),
      action: "member.removed",
      bookingId: null,
      agent: "TeamAdmin",
      outcome: "success",
      detail: `Removed ${m.role} ${m.email} (member ${m.id}) from the team`,
      actor: opts.actor,
    });
    return { memberId: m.id, userId: m.userId, role: m.role };
  });
}
