import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@/lib/db/schema";

/** Map any Stripe subscription status onto our stored set (unknown future values → "incomplete"). */
export function normalizeStatus(s: string): SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(s) ? (s as SubscriptionStatus) : "incomplete";
}

/**
 * Whether an org with this status gets paid features. past_due keeps access during
 * Stripe's retry window by default — the grace policy is a founder decision (docs/BILLING.md).
 */
export function hasPaidAccess(status: SubscriptionStatus | null | undefined, opts: { pastDueGrace?: boolean } = {}): boolean {
  if (!status) return false;
  if (status === "active" || status === "trialing") return true;
  if (status === "past_due") return opts.pastDueGrace ?? true;
  return false;
}

/**
 * Stripe subscription statuses that mean the customer still has a live subscription. While one
 * exists, a new Checkout would create a second subscription and double-bill: plan changes,
 * card updates and recovering a past_due/unpaid subscription go through the Customer Portal.
 * incomplete / incomplete_expired (abandoned first payment) and canceled do not block.
 */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid", "paused"] as const;

export function findLiveSubscription<T extends { status: string }>(subs: readonly T[]): T | undefined {
  return subs.find((s) => (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status));
}
