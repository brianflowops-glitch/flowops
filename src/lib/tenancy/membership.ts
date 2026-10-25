import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { DEMO_ORG_ID, defaultHours, slugify } from "./defaults";

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
 *  1. A pending staff invite for their email → Staff in that org.
 *  2. The primary org ("flowops-demo") has no owner yet → Owner of it. This is the
 *     "first account created becomes Owner" rule. If FLOWOPS_OWNER_EMAILS is set, only
 *     those emails can claim it (prevents a stranger claiming Brian's workspace).
 *  3. Otherwise → a brand-new organization, with the user as its Owner (multi-tenant).
 * Idempotent and serialized with an advisory lock.
 */
export async function ensureMembership(u: { id: string; email: string; name: string; businessName?: string | null }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('flowops:membership'))`);
    const existing = await tx.select().from(schema.member).where(eq(schema.member.userId, u.id)).limit(1);
    if (existing.length) return existing[0];

    const email = u.email.toLowerCase();
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
