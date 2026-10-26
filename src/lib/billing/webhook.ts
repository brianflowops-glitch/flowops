import "server-only";
import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/lib/db";
import { normalizeStatus } from "./status";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

const rid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.id);

export type WebhookResult = { status: "processed" | "duplicate" | "ignored"; eventId: string; type: string };

/**
 * Process one verified Stripe event exactly once. The stripe_event insert and the
 * state changes share one transaction: a duplicate delivery hits the primary key and
 * is skipped; a failure rolls everything back so Stripe's retry can process it again.
 * No network calls happen inside the transaction (everything comes from the event payload).
 */
export async function processStripeEvent(event: Stripe.Event, db: Db = getDb()): Promise<WebhookResult> {
  if (!(HANDLED_EVENTS as readonly string[]).includes(event.type)) {
    return { status: "ignored", eventId: event.id, type: event.type };
  }
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.stripeEvent)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: schema.stripeEvent.id });
    if (!inserted.length) return { status: "duplicate", eventId: event.id, type: event.type } as const;

    switch (event.type) {
      case "checkout.session.completed":
        await onCheckoutCompleted(tx, event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertSubscription(tx, event.data.object);
        break;
      case "invoice.paid":
      case "invoice.payment_failed":
        // Subscription status (active / past_due) arrives via customer.subscription.updated.
        // Here we only record the event; owner emails / account locking on failure are a
        // founder decision (docs/BILLING.md → Failed payments) and hook in at this point.
        break;
    }
    return { status: "processed", eventId: event.id, type: event.type } as const;
  });
}

async function linkCustomer(tx: Tx, organizationId: string, stripeCustomerId: string) {
  await tx
    .insert(schema.billingCustomer)
    .values({ organizationId, stripeCustomerId })
    .onConflictDoUpdate({ target: schema.billingCustomer.organizationId, set: { stripeCustomerId, updatedAt: sql`now()` } });
}

async function orgExists(tx: Tx, id: string) {
  const [o] = await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, id)).limit(1);
  return Boolean(o);
}

async function onCheckoutCompleted(tx: Tx, session: Stripe.Checkout.Session) {
  const orgId = session.client_reference_id ?? session.metadata?.organizationId ?? null;
  const customerId = idOf(session.customer);
  if (!orgId || !customerId) return;
  if (!(await orgExists(tx, orgId))) return;
  await linkCustomer(tx, orgId, customerId);
}

/** Resolve the org: subscription metadata (set at checkout) first, else the customer mapping. */
async function orgForSubscription(tx: Tx, sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.organizationId;
  if (fromMeta && (await orgExists(tx, fromMeta))) return fromMeta;
  const customerId = idOf(sub.customer);
  if (!customerId) return null;
  const [c] = await tx
    .select({ organizationId: schema.billingCustomer.organizationId })
    .from(schema.billingCustomer)
    .where(eq(schema.billingCustomer.stripeCustomerId, customerId))
    .limit(1);
  return c?.organizationId ?? null;
}

export function subscriptionFields(sub: Stripe.Subscription) {
  const item = sub.items?.data?.[0];
  // Since API version 2025-03-31 the billing period lives on subscription items.
  const periodEnd = item?.current_period_end ?? null;
  return {
    status: normalizeStatus(sub.status),
    priceId: item?.price?.id ?? null,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}

async function upsertSubscription(tx: Tx, sub: Stripe.Subscription) {
  const orgId = await orgForSubscription(tx, sub);
  if (!orgId) throw new Error(`No organization for subscription ${sub.id}; will retry`);
  const customerId = idOf(sub.customer);
  if (customerId) await linkCustomer(tx, orgId, customerId);
  const fields = subscriptionFields(sub);
  await tx
    .insert(schema.subscription)
    .values({ id: rid("sub"), organizationId: orgId, stripeSubscriptionId: sub.id, ...fields })
    .onConflictDoUpdate({
      target: schema.subscription.stripeSubscriptionId,
      set: { ...fields, updatedAt: sql`now()` },
      // A canceled Stripe subscription can never become active again, so a late/out-of-order
      // "updated" event must not resurrect it.
      setWhere: sql`${schema.subscription.status} <> 'canceled'`,
    });
}
