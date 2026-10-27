/**
 * Billing access rules — pure, no database (unit-tested offline in scripts/billing-tests.ts).
 * Policy (Brian, 2026-10-26): a failed card locks the org immediately. Owner/Admin can still sign
 * in and reach /api/billing/* to fix it, data is never deleted, and access returns as soon as the
 * Stripe webhook moves the subscription back to active. See docs/BILLING.md §6.
 */
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@/lib/db/schema";

export type BillingAccessLevel = "full" | "locked";
export type BillingAccessReason = "ok" | "billing_disabled" | "exempt" | "no_subscription" | Exclude<SubscriptionStatus, "active" | "trialing">;

export interface BillingAccess {
  access: BillingAccessLevel;
  reason: BillingAccessReason;
  /** Stored status of the org's effective subscription, or null when it has none. */
  status: SubscriptionStatus | null;
  /** Owner or Admin: may open the billing portal / checkout to fix a lock. */
  canManageBilling: boolean;
}

/** Statuses that give full access. Everything else locks (fail closed). */
export const FULL_ACCESS_STATUSES = ["active", "trialing"] as const satisfies readonly SubscriptionStatus[];
/** Statuses that lock the org. */
export const LOCKED_STATUSES = SUBSCRIPTION_STATUSES.filter((s) => !(FULL_ACCESS_STATUSES as readonly string[]).includes(s));

/**
 * Orgs that never get locked when billing is on: existing/pilot orgs that predate billing
 * (e.g. org_flowops_demo). Comma-separated BILLING_EXEMPT_ORG_IDS. Founder decision.
 */
export function billingExemptOrgIds(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.BILLING_EXEMPT_ORG_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * The subscription that decides access when an org has several rows (e.g. an old canceled one
 * plus a new active one): any active/trialing row wins, else the most recently updated row.
 */
export function effectiveSubscription<T extends { status: string; updatedAt?: Date | null }>(subs: readonly T[]): T | undefined {
  const full = subs.find((s) => (FULL_ACCESS_STATUSES as readonly string[]).includes(s.status));
  if (full) return full;
  return [...subs].sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))[0];
}

export interface AccessInput {
  enabled: boolean;
  exempt: boolean;
  status: SubscriptionStatus | null;
  canManageBilling: boolean;
}

/** Map billing flag + exemption + subscription status onto full/locked. */
export function resolveBillingAccess({ enabled, exempt, status, canManageBilling }: AccessInput): BillingAccess {
  if (!enabled) return { access: "full", reason: "billing_disabled", status, canManageBilling };
  if (status && (FULL_ACCESS_STATUSES as readonly string[]).includes(status)) return { access: "full", reason: "ok", status, canManageBilling };
  if (exempt) return { access: "full", reason: "exempt", status, canManageBilling };
  if (!status) return { access: "locked", reason: "no_subscription", status, canManageBilling };
  return { access: "locked", reason: status as BillingAccessReason, status, canManageBilling };
}

/**
 * API paths that stay reachable while an org is locked: billing (checkout, portal, webhook),
 * auth (sign-in, sign-out, password reset, email verification) and invites.
 */
const EXEMPT_PATH = /^\/api\/(billing|auth|invites)(\/|$)/;
export function isBillingExemptPath(pathname: string): boolean {
  return EXEMPT_PATH.test(pathname);
}

/** JSON body of the 402 a locked org gets from guarded API routes. */
export function billingLockedBody(a: BillingAccess) {
  return { error: "billing_locked" as const, reason: a.reason, status: a.status, canManageBilling: a.canManageBilling };
}
