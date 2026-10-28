import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { findLiveStripeSubscription } from "./checkout";
import { scheduledChanges, type ScheduledChanges } from "./addons";
import { getStripe } from "./stripe";

/**
 * Changes already scheduled for the org's next renewal (an add-on decrease/removal, or a plan downgrade
 * scheduled in the portal), read live from Stripe: the mirrored tables only hold what is active now, which
 * is also what entitlements use. Returns `{changes: null}` when nothing is pending or the org has no
 * Stripe customer yet, and `{unavailable: true}` when Stripe can't be reached (the caller still answers).
 */
export async function getScheduledChanges(orgId: string, env: Record<string, string | undefined> = process.env): Promise<{ changes: ScheduledChanges | null; unavailable?: true }> {
  const [row] = await getDb().select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, orgId)).limit(1);
  if (!row) return { changes: null };
  try {
    const live = await findLiveStripeSubscription(row.stripeCustomerId);
    if (!live?.schedule) return { changes: null };
    const stripe = getStripe();
    const schedule = await stripe.subscriptionSchedules.retrieve(typeof live.schedule === "string" ? live.schedule : live.schedule.id);
    return { changes: scheduledChanges(schedule, env) };
  } catch (err) {
    console.error("[billing] could not read the subscription schedule", err instanceof Error ? err.message : err);
    return { changes: null, unavailable: true };
  }
}
