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
