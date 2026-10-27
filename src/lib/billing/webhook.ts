import "server-only";
import type Stripe from "stripe";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/lib/db";
import { normalizeStatus } from "./status";
import { classifyItems } from "./entitlements";

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

/** Fetches the CURRENT subscription from Stripe. Injected so tests run offline. */
export type SubscriptionFetcher = (subscriptionId: string) => Promise<Stripe.Subscription>;

export interface ProcessOptions {
  db?: Db;
  /** Required for subscription.* / invoice.* events that reference a subscription. */
  fetchSubscription?: SubscriptionFetcher;
}

export type WebhookResult = {
  /** stale = the subscription row already reflects a strictly newer event (or is canceled); nothing written. */
  status: "processed" | "duplicate" | "ignored" | "stale";
  eventId: string;
  type: string;
};

/** Subscription id an event refers to (subscription.* object id, or the invoice's subscription). */
export function subscriptionIdForEvent(event: Stripe.Event): string | null {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return event.data.object.id;
    case "invoice.paid":
    case "invoice.payment_failed":
      return idOf(event.data.object.parent?.subscription_details?.subscription ?? null);
    default:
      return null;
  }
}

/**
 * Process one verified Stripe event exactly once.
 *
 * Ordering: Stripe does not guarantee delivery order, so subscription.* and invoice.*
 * events are treated as a *signal*. Before the DB transaction we retrieve the current
 * subscription from Stripe and write that state, not the (possibly stale) payload.
 * Backup guard: the row stores the source event's `created`; writes from strictly older
 * events are skipped (ties: the freshly fetched state wins). Canceled is terminal.
 *
 * Idempotency: the stripe_event insert and the state change share one transaction; a
 * duplicate delivery hits the primary key and is skipped; a failure rolls everything
 * back so Stripe's retry can process it again. No network calls inside the transaction.
 */
export async function processStripeEvent(event: Stripe.Event, opts: ProcessOptions = {}): Promise<WebhookResult> {
  const db = opts.db ?? getDb();
  const result = (status: WebhookResult["status"]): WebhookResult => ({ status, eventId: event.id, type: event.type });
  if (!(HANDLED_EVENTS as readonly string[]).includes(event.type)) return result("ignored");

  // Cheap pre-check so duplicate deliveries don't cost a Stripe API call (the PK insert below is the real guard).
  const [seen] = await db.select({ id: schema.stripeEvent.id }).from(schema.stripeEvent).where(eq(schema.stripeEvent.id, event.id)).limit(1);
  if (seen) return result("duplicate");

  // Network call happens here, OUTSIDE the transaction. A failure throws → 500 → Stripe retries.
  const subId = subscriptionIdForEvent(event);
  let current: Stripe.Subscription | null = null;
  if (subId) {
    if (!opts.fetchSubscription) throw new Error("fetchSubscription is required for subscription/invoice events");
    current = await opts.fetchSubscription(subId);
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.stripeEvent)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: schema.stripeEvent.id });
    if (!inserted.length) return result("duplicate");

    if (event.type === "checkout.session.completed") {
      await onCheckoutCompleted(tx, event.data.object);
      return result("processed");
    }
    // invoice.* : status (active / past_due) is written from the fetched subscription.
    // Owner emails / account locking on failure are a founder decision (docs/BILLING.md → Failed payments)
    // and hook in here for invoice.payment_failed.
    if (!current) return result("processed"); // e.g. a one-off invoice with no subscription
    const wrote = await upsertSubscription(tx, current, new Date(event.created * 1000));
    return result(wrote ? "processed" : "stale");
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

export function subscriptionFields(sub: Stripe.Subscription, env: Record<string, string | undefined> = process.env) {
  const items = sub.items?.data ?? [];
  // The plan item is the one whose price id matches a configured plan (never "the first item": add-ons
  // are extra items on the same subscription). Falls back to the first non-add-on item, then to none.
  const { plan } = classifyItems(items.map((i) => ({ priceId: i.price?.id ?? null, quantity: i.quantity ?? 1 })), env);
  const planItem = (plan && items.find((i) => (i.price?.id ?? null) === plan.priceId)) || items[0];
  // Since API version 2025-03-31 the billing period lives on subscription items (all items share one period).
  const periodEnd = planItem?.current_period_end ?? items[0]?.current_period_end ?? null;
  return {
    status: normalizeStatus(sub.status),
    priceId: plan?.priceId ?? null,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}

/** Returns false when the write was skipped by the ordering / canceled guard. */
async function upsertSubscription(tx: Tx, sub: Stripe.Subscription, eventCreated: Date): Promise<boolean> {
  const orgId = await orgForSubscription(tx, sub);
  if (!orgId) throw new Error(`No organization for subscription ${sub.id}; will retry`);
  const customerId = idOf(sub.customer);
  if (customerId) await linkCustomer(tx, orgId, customerId);
  const fields = subscriptionFields(sub);
  const t = schema.subscription;
  const rows = await tx
    .insert(t)
    .values({ id: rid("sub"), organizationId: orgId, stripeSubscriptionId: sub.id, ...fields, lastEventCreated: eventCreated })
    .onConflictDoUpdate({
      target: t.stripeSubscriptionId,
      set: { ...fields, lastEventCreated: eventCreated, updatedAt: sql`now()` },
      // 1. A canceled Stripe subscription can never become active again.
      // 2. Skip events strictly older than the one that produced the stored state; on a tie the
      //    freshly fetched state wins (it is current).
      setWhere: sql`${t.status} <> 'canceled' and (${t.lastEventCreated} is null or ${t.lastEventCreated} <= ${eventCreated.toISOString()}::timestamptz)`,
    })
    .returning({ id: t.id });
  // Items follow the same guard: only written when the subscription row was written (so a stale
  // event or a canceled subscription never rewrites add-ons either), in the same transaction.
  if (rows.length > 0) await syncItems(tx, rows[0].id, sub);
  return rows.length > 0;
}

/** Make `subscription_item` equal the fetched subscription's items (upsert present, prune removed). */
async function syncItems(tx: Tx, subscriptionRowId: string, sub: Stripe.Subscription) {
  const items = sub.items?.data ?? [];
  const i = schema.subscriptionItem;
  for (const it of items) {
    await tx
      .insert(i)
      .values({ id: rid("si"), subscriptionId: subscriptionRowId, stripeItemId: it.id, priceId: it.price?.id ?? null, quantity: it.quantity ?? 1 })
      .onConflictDoUpdate({
        target: i.stripeItemId,
        set: { subscriptionId: subscriptionRowId, priceId: it.price?.id ?? null, quantity: it.quantity ?? 1, updatedAt: sql`now()` },
      });
  }
  // Only prune when the list is complete: a paginated (has_more) payload would otherwise drop real items.
  if (sub.items?.has_more) return;
  await tx.delete(i).where(items.length ? and(eq(i.subscriptionId, subscriptionRowId), notInArray(i.stripeItemId, items.map((x) => x.id))) : eq(i.subscriptionId, subscriptionRowId));
}
