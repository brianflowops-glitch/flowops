import "server-only";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb, schema, type Db } from "@/lib/db";
import type { OrgContext } from "@/lib/server/context";
import { getStripe } from "./stripe";
import { findLiveSubscription } from "./status";

/**
 * The org's existing Stripe customer id, or null. Read-only: never calls Stripe and never writes a row, so read paths
 * (e.g. the billing card's GET) can't create customers for the demo org or orgs that never subscribed.
 */
export async function findCustomerId(orgId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: schema.billingCustomer.stripeCustomerId }).from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, orgId)).limit(1);
  return row?.id ?? null;
}

/** Existing Stripe customer for the org, or a new one (one customer per organization). */
export async function getOrCreateCustomer(ctx: OrgContext): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, ctx.org.id)).limit(1);
  if (existing) return existing.stripeCustomerId;
  const customer = await getStripe().customers.create(
    { name: ctx.org.name, email: ctx.user.email, metadata: { organizationId: ctx.org.id } },
    // Per org + user: a retry by the same person reuses the customer; a different admin never hits a
    // params-mismatch 400 on a stale key. The DB insert below keeps the first customer per org.
    { idempotencyKey: `flowops-customer-${ctx.org.id}-${ctx.user.id}` },
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

/** Subscriptions that never became live (abandoned first payment) don't use up the trial. */
const NEVER_LIVE = ["incomplete", "incomplete_expired"];

/**
 * One free trial per business: an org that EVER had a subscription (a row in our mirror, or any subscription on
 * its Stripe customer, including a cancelled one) gets no trial, whatever it does next (cancel and resubscribe, a
 * second checkout, another plan). Both sources are checked because the mirror can lag the webhook.
 */
export async function trialEligibility(
  orgId: string,
  customer: string,
  deps: { db?: Db; stripe?: { subscriptions: { list(p: Stripe.SubscriptionListParams): Promise<{ data: { status: string }[] }> } } } = {},
): Promise<{ eligible: boolean; reason?: "had_subscription" }> {
  const db = deps.db ?? getDb();
  const rows = await db.select({ status: schema.subscription.status }).from(schema.subscription).where(eq(schema.subscription.organizationId, orgId));
  if (rows.some((r) => !NEVER_LIVE.includes(r.status))) return { eligible: false, reason: "had_subscription" };
  const subs = await (deps.stripe ?? getStripe()).subscriptions.list({ customer, status: "all", limit: 100 });
  if (subs.data.some((s) => !NEVER_LIVE.includes(s.status))) return { eligible: false, reason: "had_subscription" };
  return { eligible: true };
}
