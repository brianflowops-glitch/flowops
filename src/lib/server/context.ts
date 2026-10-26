import "server-only";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { getDb, hasDatabase, schema } from "@/lib/db";
import { ensureMembership } from "@/lib/tenancy/membership";

export type Role = "owner" | "admin" | "staff";
/** Owner and Admin manage the team (invites, reset links). Settings stay Owner-only. */
export const canManageTeam = (r: Role) => r === "owner" || r === "admin";
export interface OrgContext {
  user: { id: string; name: string; email: string; emailVerified: boolean };
  role: Role;
  org: typeof schema.organization.$inferSelect;
}

/** Resolve the signed-in user + their organization from request headers. */
export async function getContextFromHeaders(h: Headers): Promise<OrgContext | null> {
  if (!hasDatabase()) return null;
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) return null;
  const db = getDb();
  let [m] = await db.select().from(schema.member).where(eq(schema.member.userId, session.user.id)).limit(1);
  if (!m) {
    // Session cookie may outlive a deleted user (cookie cache) — treat as signed out.
    const [u] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, session.user.id)).limit(1);
    if (!u) return null;
    m = await ensureMembership({ id: session.user.id, email: session.user.email, name: session.user.name, emailVerified: Boolean(session.user.emailVerified) });
  }
  const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, m.organizationId)).limit(1);
  if (!org) return null;
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email, emailVerified: Boolean(session.user.emailVerified) },
    role: m.role,
    org,
  };
}

export async function getContext() {
  return getContextFromHeaders(await headers());
}

export function unauthorized(message = "Sign in required") {
  return Response.json({ error: message }, { status: 401 });
}
export function forbidden(message = "Owner role required") {
  return Response.json({ error: message }, { status: 403 });
}

/** For route handlers: returns the context or a 401 Response. */
export async function requireApi(req: Request, opts: { owner?: boolean; manager?: boolean } = {}): Promise<OrgContext | Response> {
  if (!hasDatabase()) return Response.json({ error: "Database not configured (DATABASE_URL missing)" }, { status: 503 });
  const ctx = await getContextFromHeaders(req.headers);
  if (!ctx) return unauthorized();
  if (opts.owner && ctx.role !== "owner") return forbidden();
  if (opts.manager && !canManageTeam(ctx.role)) return forbidden("Owner or Admin role required");
  return ctx;
}

/** Client-safe view of the org. */
export function publicOrg(org: OrgContext["org"]) {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    timeZone: org.timeZone,
    hours: org.hours,
    publicBooking: org.publicBooking,
    isDemo: org.isDemo,
    googleConnected: Boolean(org.googleRefreshTokenEnc),
    googleAccountEmail: org.googleAccountEmail,
  };
}
export type PublicOrg = ReturnType<typeof publicOrg>;
