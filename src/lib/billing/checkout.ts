import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { OrgContext } from "@/lib/server/context";
import { getStripe } from "./stripe";
import { findLiveSubscription } from "./status";

/** Existing Stripe customer for the org, or a new one (one customer per organization). */
export async function getOrCreateCustomer(ctx: OrgContext): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, ctx.org.id)).limit(1);
  if (existing) return existing.stripeCustomerId;
  const customer = await getStripe().customers.create(
    { name: ctx.org.name, email: ctx.user.email, metadata: { organizationId: ctx.org.id } },
    { idempotencyKey: `flowops-customer-${ctx.org.id}` },
  );
  await db.insert(schema.billingCustomer).values({ organizationId: ctx.org.id, stripeCustomerId: customer.id }).onConflictDoNothing();
  const [row] = await db.select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, ctx.org.id)).limit(1);
  return row.stripeCustomerId;
}

/**
 * The customer's live subscription in Stripe (active, trialing, past_due, unpaid, paused), if any.
 * Asks Stripe rather than our table, which can lag behind the webhook (e.g. right after checkout).
 */
export async function findLiveStripeSubscription(customer: string) {
  const subs = await getStripe().subscriptions.list({ customer, status: "all", limit: 100 });
  return findLiveSubscription(subs.data);
}

/**
 * Expire the customer's other open Checkout sessions before creating a new one, so an old
 * checkout tab can't be completed later and start a second subscription.
 */
export async function expireOpenCheckoutSessions(customer: string) {
  const stripe = getStripe();
  for await (const session of stripe.checkout.sessions.list({ customer, status: "open", limit: 100 })) {
    await stripe.checkout.sessions.expire(session.id).catch(() => undefined); // already completed/expired: fine
  }
}
