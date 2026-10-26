import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/lib/db";
import type { OrgContext, Role } from "@/lib/server/context";
import { canManageTeam } from "@/lib/tenancy/team-rules";
import { billingEnabled } from "./config";
import { billingExemptOrgIds, billingLockedBody, effectiveSubscription, isBillingExemptPath, resolveBillingAccess, type BillingAccess } from "./access-rules";

export * from "./access-rules";

/** Owner or Admin may fix billing (same roles that manage the team). */
export const canManageBilling = (role: Role | null | undefined) => Boolean(role && canManageTeam(role));

/**
 * Billing access for an organization (docs/BILLING.md §6). Read-only: never changes or deletes data.
 *   BILLING_ENABLED off            → full ("billing_disabled"), no DB query
 *   active / trialing              → full ("ok")
 *   org in BILLING_EXEMPT_ORG_IDS  → full ("exempt")
 *   no subscription row            → locked ("no_subscription")
 *   past_due, unpaid, incomplete, incomplete_expired, canceled, paused → locked (reason = status)
 * `role` is the signed-in user's role in that org; it only sets `canManageBilling`.
 */
export async function getBillingAccess(organizationId: string, role?: Role | null, opts: { db?: Db; env?: Record<string, string | undefined> } = {}): Promise<BillingAccess> {
  const manage = canManageBilling(role);
  const env = opts.env ?? process.env;
  const enabled = opts.env ? env.BILLING_ENABLED === "true" : billingEnabled();
  if (!enabled) return resolveBillingAccess({ enabled, exempt: false, status: null, canManageBilling: manage });
  const rows = await (opts.db ?? getDb())
    .select({ status: schema.subscription.status, updatedAt: schema.subscription.updatedAt })
    .from(schema.subscription)
    .where(eq(schema.subscription.organizationId, organizationId));
  return resolveBillingAccess({
    enabled,
    exempt: billingExemptOrgIds(env).has(organizationId),
    status: effectiveSubscription(rows)?.status ?? null,
    canManageBilling: manage,
  });
}

/**
 * Shared API guard (called from requireApi): null when the request may proceed, else a 402
 * `{ error: "billing_locked", reason, status, canManageBilling }`. /api/billing/*, /api/auth/* and
 * /api/invites/* are exempt so a locked Owner/Admin can still sign in/out and fix billing.
 */
export async function requireBillingAccess(req: Request, ctx: Pick<OrgContext, "org" | "role">): Promise<Response | null> {
  if (!billingEnabled()) return null;
  if (isBillingExemptPath(new URL(req.url).pathname)) return null;
  const a = await getBillingAccess(ctx.org.id, ctx.role);
  if (a.access === "full") return null;
  return Response.json(billingLockedBody(a), { status: 402 });
}
