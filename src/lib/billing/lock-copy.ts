import type { BillingAccess } from "./access-rules";

export type LockAction = "portal" | "choose_plan" | "contact_admin";

export interface LockCopy {
  title: string;
  message: string;
  action: LockAction;
}

/**
 * What the billing lock screen says and offers (pure, so it's unit-tested). Owners/Admins get a way
 * to fix it; Staff are told to contact an admin. Data is never touched by the lock.
 */
export function lockScreenCopy(a: Pick<BillingAccess, "reason" | "canManageBilling">, opts: { trialDays?: number } = {}): LockCopy {
  const reassure = "Your bookings and settings are safe, and full access comes back as soon as billing is sorted.";
  if (!a.canManageBilling) {
    return {
      title: "This workspace is paused",
      message: `There's a billing issue on this account. Ask your workspace owner or an admin to update it. ${reassure}`,
      action: "contact_admin",
    };
  }
  switch (a.reason) {
    case "no_subscription":
    case "incomplete_expired":
      // First plan of the org: the free trial needs no card (checkout-params.ts).
      if (opts.trialDays && opts.trialDays > 0)
        return {
          title: `Start your ${opts.trialDays}-day free trial`,
          message: `Choose a plan to start. No card required: nothing is charged during the trial, and we'll remind you to add a card before it ends. ${reassure}`,
          action: "choose_plan",
        };
      return { title: "Choose a plan to continue", message: `This workspace doesn't have an active plan yet. ${reassure}`, action: "choose_plan" };
    case "canceled":
      // Stripe's portal can't restart a canceled subscription; a new Checkout can.
      return { title: "Your plan has ended", message: `Your subscription was canceled. Choose a plan to pick up where you left off. ${reassure}`, action: "choose_plan" };
    case "paused":
      return { title: "Your plan is paused", message: `Resume your subscription in billing to continue. ${reassure}`, action: "portal" };
    default:
      // past_due, unpaid, incomplete
      return { title: "Billing issue: update your card", message: `We couldn't collect your last payment. Update your card in billing to restore access. ${reassure}`, action: "portal" };
  }
}

/** True when an API response is the billing lock (402 billing_locked). */
export function isBillingLockedResponse(status: number, body: unknown): boolean {
  return status === 402 && typeof body === "object" && body !== null && (body as { error?: unknown }).error === "billing_locked";
}
