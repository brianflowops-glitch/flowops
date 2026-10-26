import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { DEMO_ORG_ID, defaultHours, slugify } from "./defaults";
import { INVITE_TTL_DAYS, consumeInvite, findUsableInvite } from "./invites";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type LegacyInvite = typeof schema.staffInvite.$inferSelect;

/**
 * Legacy email-match staff invites (pre-v2.1, no token) are only honored for a VERIFIED email,
 * and only within INVITE_TTL_DAYS of being created. Without this, whoever signed up first with
 * that address (no proof they own it) became Staff in the inviting org.
 */
export const LEGACY_INVITE_TTL_DAYS = INVITE_TTL_DAYS;
export function legacyInviteUsable(inv: Pick<LegacyInvite, "createdAt">, emailVerified: boolean, now = new Date()) {
  if (!emailVerified) return false;
  return now.getTime() - inv.createdAt.getTime() < LEGACY_INVITE_TTL_DAYS * 24 * 3600 * 1000;
}

/** True if `orgId` is a throwaway auto-created workspace: not the primary org, no other members, no bookings. */
async function isEmptyOwnWorkspace(tx: Tx, orgId: string, userId: string) {
  if (orgId === DEMO_ORG_ID) return false;
  const [{ others }] = (
    await tx.execute(sql`select
      (select count(*)::int from member where organization_id = ${orgId} and user_id <> ${userId}) +
      (select count(*)::int from booking where organization_id = ${orgId}) as others`)
  ).rows as { others: number }[];
  return Number(others) === 0;
}

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
 *  1. A legacy email-match staff invite for their email → Staff in that org, ONLY if the email is
 *     already verified and the invite is under LEGACY_INVITE_TTL_DAYS old (see legacyInviteUsable).
 *     At sign-up the email is unverified, so this normally happens later, in
 *     claimLegacyInviteAfterVerification (called when the user verifies their email).
 *  2. The primary org ("flowops-demo") has no owner yet → Owner of it. This is the
 *     "first account created becomes Owner" rule. If FLOWOPS_OWNER_EMAILS is set, only
 *     those emails can claim it (prevents a stranger claiming Brian's workspace).
 *  3. Otherwise → a brand-new organization, with the user as its Owner (multi-tenant).
 * Idempotent and serialized with an advisory lock.
 */
export async function ensureMembership(u: { id: string; email: string; name: string; emailVerified?: boolean; businessName?: string | null; inviteToken?: string | null }) {
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
    if (invite && legacyInviteUsable(invite, Boolean(u.emailVerified))) {
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
 * With `requireVerifiedEmail`, the account's email must be verified first.
 */
export async function joinOrgWithInvite(u: { id: string; email: string }, token: string, opts: { requireVerifiedEmail?: boolean } = {}) {
  const db = getDb();
  // Validate first (without consuming) so a refusal leaves the invite usable. Done before the
  // transaction: it reads via its own connection, and consumeInvite below re-checks atomically.
  const usable = await findUsableInvite(token, u.email);
  if (!usable) throw new InviteJoinError("This invite is invalid, expired, already used, revoked, or for a different email.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('flowops:membership'))`);
    const [current] = await tx.select().from(schema.member).where(eq(schema.member.userId, u.id)).limit(1);
    // An existing account must prove it owns the invited address before switching orgs — when
    // verification emails can actually be sent (otherwise nobody could ever accept).
    if (opts.requireVerifiedEmail) {
      const [row] = await tx.select({ v: schema.user.emailVerified }).from(schema.user).where(eq(schema.user.id, u.id)).limit(1);
      if (!row?.v) throw new InviteJoinError("Verify your email address first (check your inbox for the FlowOps verification link), then open this invite again.");
    }
    if (current?.organizationId === usable.invite.organizationId) throw new InviteJoinError("You're already a member of this organization.");
    if (current) {
      if (current.role === "owner") {
        if (!(await isEmptyOwnWorkspace(tx, current.organizationId, u.id)))
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

/**
 * Called after a user verifies their email: if a usable legacy email-match staff invite exists
 * for that (now proven) address, join that org as Staff — but only if the user has no
 * membership yet or is the Owner of an empty auto-created workspace (which is then removed).
 * Never moves someone out of a real workspace. Returns the new membership, or null.
 */
export async function claimLegacyInviteAfterVerification(u: { id: string; email: string }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('flowops:membership'))`);
    const email = u.email.toLowerCase();
    const [invite] = await tx.select().from(schema.staffInvite).where(eq(schema.staffInvite.email, email)).limit(1);
    if (!invite || !legacyInviteUsable(invite, true)) return null;
    const [current] = await tx.select().from(schema.member).where(eq(schema.member.userId, u.id)).limit(1);
    if (current?.organizationId === invite.organizationId) {
      await tx.delete(schema.staffInvite).where(eq(schema.staffInvite.id, invite.id));
      return null;
    }
    if (current) {
      if (current.role !== "owner" || !(await isEmptyOwnWorkspace(tx, current.organizationId, u.id))) return null;
      await tx.delete(schema.organization).where(eq(schema.organization.id, current.organizationId));
    }
    const [m] = await tx.insert(schema.member).values({ id: rid("mem"), organizationId: invite.organizationId, userId: u.id, role: "staff" }).returning();
    await tx.delete(schema.staffInvite).where(eq(schema.staffInvite.id, invite.id));
    return m;
  });
}
