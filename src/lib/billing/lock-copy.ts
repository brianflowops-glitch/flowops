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
export function lockScreenCopy(a: Pick<BillingAccess, "reason" | "canManageBilling">): LockCopy {
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
      return { title: "Choose a plan to continue", message: `This workspace doesn't have an active plan yet. ${reassure}`, action: "choose_plan" };
    case "canceled":
      return { title: "Your plan has ended", message: `Your subscription was canceled. Restart it in billing to pick up where you left off. ${reassure}`, action: "portal" };
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
