/**
 * Add-on changes on an existing subscription (docs/BILLING.md §11). The Stripe client is injected
 * so this runs offline in tests; no "server-only" import for the same reason.
 *
 * Policy (Brian, 2026-10-27; patch 0004 replaces the "billed at renewal" rule for increases):
 *   - Increase / new add-on (seat, location, branding): charged NOW, prorated for the rest of the current period
 *     (monthly or annual). Active subscription: Stripe prorates (`proration_behavior: "always_invoice"`) and the
 *     write uses `payment_behavior: "pending_if_incomplete"`, so the new quantity only takes effect once that
 *     immediate invoice is paid. A failed payment voids the invoice, which discards the pending update: nothing is
 *     granted and the caller gets 402. During a free TRIAL Stripe's proration is $0, so the add-on's rate for the
 *     rest of the trial is charged now on a standalone invoice before the quantity is applied (addon-charge.ts);
 *     no card on file → 402. Full price from the next renewal either way.
 *   - Decrease / removal (unchanged): the add-on stays active until the current period ends, then drops at renewal.
 *     Done with a subscription schedule whose next phase holds the lower quantity. No refund, no proration credit.
 *   - A later change replaces a pending one (see `setAddonQuantity`).
 */
import type Stripe from "stripe";
import { addonByKey, addonPrice, isTextPackKey, plans, recurringAddons, type BillingInterval } from "./config";
import { addonEffect, addonMaxQuantity, classifyItems, entitlementsFromItems, planLimits, type Entitlements } from "./entitlements";
import { chargeOneOff, inspectProrationOutcome, trialProrationAmount, type ChargeStripe } from "./addon-charge";

type Env = Record<string, string | undefined>;

/**
 * Quantity checks that need no Stripe call (so the route can run them before touching Stripe). null = fine.
 * An unknown add-on is not judged here. The per-add-on maximum comes from `addonMaxQuantity` (defaults + STRIPE_ADDON_MAX_<KEY>).
 */
export function validateAddonQuantity(addon: string, quantity: number, env: Env = process.env): { ok: false; status: 400; error: string } | null {
  const max = addonMaxQuantity(addon, env);
  if (!Number.isInteger(quantity) || quantity < 0) return { ok: false, status: 400, error: `Quantity must be a whole number from 0 to ${max}` };
  if (quantity > max) return { ok: false, status: 400, error: `Quantity ${quantity} is above the maximum of ${max} for the "${addon.toLowerCase()}" add-on. Choose ${max} or fewer.` };
  return null;
}
/** Only these subscription statuses may add or change add-ons (a locked / past_due org must fix the payment first). */
export const ADDON_CHANGE_STATUSES = ["active", "trialing"] as const;

/** The subset of the Stripe client this module uses (lets tests pass a fake). */
export interface AddonStripe {
  subscriptions: { retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription> };
  subscriptionItems: {
    list(params: { subscription: string; limit?: number }): { autoPagingToArray(o: { limit: number }): Promise<Stripe.SubscriptionItem[]> };
    create(params: Stripe.SubscriptionItemCreateParams): Promise<Stripe.SubscriptionItem>;
    update(id: string, params: Stripe.SubscriptionItemUpdateParams): Promise<Stripe.SubscriptionItem>;
  };
  subscriptionSchedules: {
    retrieve(id: string): Promise<Stripe.SubscriptionSchedule>;
    create(params: Stripe.SubscriptionScheduleCreateParams): Promise<Stripe.SubscriptionSchedule>;
    update(id: string, params: Stripe.SubscriptionScheduleUpdateParams): Promise<Stripe.SubscriptionSchedule>;
    release(id: string): Promise<Stripe.SubscriptionSchedule>;
  };
  /** Needed for increases: voiding an unpaid proration invoice, and the trial charge (a standalone invoice). */
  invoices?: ChargeStripe["invoices"];
  invoiceItems?: ChargeStripe["invoiceItems"];
  /** Trial charge: the add-on's unit price and the card on file. */
  prices?: { retrieve(id: string): Promise<Stripe.Price> };
  customers?: { retrieve(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> };
  creditNotes?: { create(p: Stripe.CreditNoteCreateParams): Promise<Stripe.CreditNote> };
}

/**
 * Retrieve a subscription with ALL its items (the embedded list is capped at 10). The webhook uses
 * this as its fetcher so item pruning never works from a truncated list.
 */
export async function retrieveSubscriptionComplete(stripe: Pick<AddonStripe, "subscriptions" | "subscriptionItems">, id: string): Promise<Stripe.Subscription> {
  const sub = await stripe.subscriptions.retrieve(id);
  if (!sub.items?.has_more) return sub;
  const all = await stripe.subscriptionItems.list({ subscription: id, limit: 100 }).autoPagingToArray({ limit: 1000 });
  return { ...sub, items: { ...sub.items, data: all, has_more: false } } as Stripe.Subscription;
}

// ───────────────────────── schedule helpers (pure) ─────────────────────────

export interface PhaseItem {
  price: string;
  quantity: number;
}

const priceIdOf = (p: string | { id: string }) => (typeof p === "string" ? p : p.id);
const idOrNull = (p: string | { id: string } | null | undefined) => (p == null ? null : typeof p === "string" ? p : p.id);

/** A schedule phase's items as {price, quantity}. */
export function phaseItems(phase: Pick<Stripe.SubscriptionSchedule.Phase, "items">): PhaseItem[] {
  return phase.items.map((i) => ({ price: priceIdOf(i.price as string | { id: string }), quantity: i.quantity ?? 1 }));
}

/** Items with `price` set to `quantity` (added at the end if new, removed at 0). Other items untouched. */
export function withQuantity(items: readonly PhaseItem[], price: string, quantity: number): PhaseItem[] {
  const rest = items.filter((i) => i.price !== price);
  const had = items.some((i) => i.price === price);
  if (quantity <= 0) return rest;
  return had ? items.map((i) => (i.price === price ? { price, quantity } : i)) : [...rest, { price, quantity }];
}

export const sameItems = (a: readonly PhaseItem[], b: readonly PhaseItem[]) => {
  const k = (x: readonly PhaseItem[]) => JSON.stringify([...x].sort((p, q) => p.price.localeCompare(q.price)));
  return k(a) === k(b);
};

export interface SchedulePhases {
  current: Stripe.SubscriptionSchedule.Phase;
  /** Phases that start at or after the current one ends (the portal's scheduled downgrade, or ours). */
  future: Stripe.SubscriptionSchedule.Phase[];
}

/** Current + future phases of an active schedule, or null for a missing / finished one. */
export function schedulePhases(schedule: Stripe.SubscriptionSchedule | null | undefined): SchedulePhases | null {
  if (!schedule || schedule.status !== "active" || !schedule.current_phase) return null;
  const cur = schedule.current_phase;
  const current = schedule.phases.find((p) => p.start_date === cur.start_date);
  if (!current) return null;
  return { current, future: schedule.phases.filter((p) => p.start_date >= current.end_date) };
}

export interface ScheduledChanges {
  /** Unix seconds: when the next phase starts (the renewal). */
  effectiveAt: number;
  addons: { key: string; from: number; to: number }[];
  /** Set when the next phase is on a different plan (e.g. a downgrade scheduled in the portal). */
  plan: { from: string | null; to: string | null } | null;
  /** What the org will be entitled to once the next phase starts. */
  entitlementsAtRenewal: Entitlements;
}

/** Differences between a schedule's current phase and its next phase (null when nothing is pending). */
export function scheduledChanges(schedule: Stripe.SubscriptionSchedule | null | undefined, env: Env = process.env): ScheduledChanges | null {
  const ph = schedulePhases(schedule);
  const next = ph?.future[0];
  if (!ph || !next) return null;
  const cur = classifyItems(phaseItems(ph.current).map((i) => ({ priceId: i.price, quantity: i.quantity })), env);
  const nxt = classifyItems(phaseItems(next).map((i) => ({ priceId: i.price, quantity: i.quantity })), env);
  const qty = (list: { key: string; quantity: number }[], key: string) => list.filter((a) => a.key === key).reduce((n, a) => n + a.quantity, 0);
  const keys = [...new Set([...cur.addons, ...nxt.addons].map((a) => a.key))].sort();
  const addonChanges = keys.map((key) => ({ key, from: qty(cur.addons, key), to: qty(nxt.addons, key) })).filter((c) => c.from !== c.to);
  const planChange = (cur.plan?.planKey ?? null) !== (nxt.plan?.planKey ?? null) || cur.plan?.priceId !== nxt.plan?.priceId ? { from: cur.plan?.planKey ?? null, to: nxt.plan?.planKey ?? null } : null;
  if (!addonChanges.length && !planChange) return null;
  return {
    effectiveAt: ph.current.end_date,
    addons: addonChanges,
    plan: planChange,
    entitlementsAtRenewal: entitlementsFromItems(phaseItems(next).map((i) => ({ priceId: i.price, quantity: i.quantity })), env),
  };
}

/** What an increase was charged right away (null when nothing was charged: decrease, no change, or a $0 proration). */
export interface AddonCharge {
  /** "proration": Stripe's immediate prorated invoice on the subscription. "trial_proration": our standalone invoice for the rest of the trial. */
  kind: "proration" | "trial_proration";
  invoiceId: string;
  amountPaid: number;
  currency: string;
  lines?: { description: string | null; amount: number }[];
}

export type AddonChangeResult =
  | {
      ok: true;
      /** created/updated: applied now and charged now (prorated). scheduled: drops at renewal. schedule_cleared: a pending decrease was cancelled. */
      action: "created" | "updated" | "scheduled" | "schedule_cleared" | "unchanged";
      addon: string;
      /** The quantity asked for. */
      quantity: number;
      /** The quantity active right now (differs from `quantity` for a scheduled decrease). */
      currentQuantity: number;
      /** Unix seconds when a scheduled decrease takes effect (the renewal), else null. */
      effectiveAt: number | null;
      itemId: string | null;
      /** "always_invoice" for an increase (charged now, prorated); "none" for decreases / no change. */
      proration: "none" | "always_invoice";
      charge: AddonCharge | null;
    }
  | { ok: false; status: 400 | 402 | 404 | 409 | 502; error: string; code?: "payment_failed" | "no_payment_method" | "stripe_error"; portal?: boolean };

export interface ChangeAddonInput {
  stripe: AddonStripe;
  /** Live subscription id (from findLiveStripeSubscription). */
  subscription: Pick<Stripe.Subscription, "id" | "status">;
  addon: string;
  /** Target quantity (absolute, not a delta). 0 removes the add-on at the next renewal. */
  quantity: number;
  env?: Env;
  /** "Now" for the trial proration (a test clock's frozen time in the sandbox). Default: the real clock. */
  now?: Date;
}

type PhaseParam = Stripe.SubscriptionScheduleUpdateParams.Phase;

function phaseParam(p: Stripe.SubscriptionSchedule.Phase, items: PhaseItem[]): PhaseParam {
  return { start_date: p.start_date, end_date: p.end_date, items, proration_behavior: "none", ...(p.metadata && Object.keys(p.metadata).length ? { metadata: p.metadata } : {}) };
}

/** Phases we can't safely rewrite (they'd lose settings we don't copy): refuse instead of dropping them. */
const hasUnsupportedPhaseSettings = (p: Stripe.SubscriptionSchedule.Phase) => Boolean((p.discounts && p.discounts.length) || (p.add_invoice_items && p.add_invoice_items.length) || p.trial_end);

/**
 * Set an add-on's quantity (absolute). Validates against config, plan and status first; nothing is
 * sent to Stripe when validation fails.
 *
 *   target > current        → applied now, first billed at renewal. If a schedule with a next phase exists the
 *                             next phase is raised too, which replaces any pending decrease for this add-on.
 *   target < current (or 0) → stays active until the period ends: the NEXT phase of a subscription schedule
 *                             (created if needed, or the portal's existing one) holds the lower quantity.
 *   target = current        → cancels a pending decrease for this add-on (releases our schedule if it ends up
 *                             identical to the current phase); otherwise nothing to do.
 * Other add-ons' pending changes, and a portal-scheduled plan downgrade, are kept.
 */
export async function setAddonQuantity({ stripe, subscription, addon, quantity, env = process.env, now = new Date() }: ChangeAddonInput): Promise<AddonChangeResult> {
  // Text bundles are one-time packs now (text-packs.ts / POST /api/billing/text-packs), never a recurring add-on.
  if (isTextPackKey(addon)) return { ok: false, status: 400, error: "Text bundles are one-time packs now. Buy them with POST /api/billing/text-packs; they are not a recurring add-on." };
  const known = addonByKey(addon, env);
  if (!known) return { ok: false, status: 400, error: "Unknown add-on" };
  const invalid = validateAddonQuantity(known.key, quantity, env);
  if (invalid) return invalid;
  if (!(ADDON_CHANGE_STATUSES as readonly string[]).includes(subscription.status))
    return { ok: false, status: 409, error: "Add-ons can only be changed on an active subscription. Fix the payment in the billing portal first." };

  const sub = await retrieveSubscriptionComplete(stripe, subscription.id);
  const items = sub.items.data;
  const classified = classifyItems(items.map((i) => ({ priceId: i.price?.id ?? null, quantity: i.quantity ?? 1 })), env);
  if (!classified.plan || !classified.plan.planKey) return { ok: false, status: 409, error: "This subscription is not on a configured plan, so add-ons can't be changed" };
  // The add-on price must have the subscription's billing interval (Stripe: one interval per subscription).
  const planItem = items.find((i) => i.price?.id === classified.plan!.priceId);
  const interval = (planItem?.price?.recurring?.interval ?? plans(env).find((p) => p.priceId === classified.plan!.priceId)?.interval ?? "month") as string;
  if (interval !== "month" && interval !== "year") return { ok: false, status: 409, error: "This subscription's billing interval doesn't support add-ons" };
  const cfg = addonPrice(known.key, interval as BillingInterval, env);
  if (!cfg) return { ok: false, status: 409, error: `The "${known.key}" add-on has no ${interval === "year" ? "annual" : "monthly"} price configured, so it can't be added to this ${interval === "year" ? "annual" : "monthly"} subscription` };
  if (cfg.key === "branding" && planLimits(classified.plan.planKey, env).brandingRemoved) return { ok: false, status: 409, error: "Branding removal is already included in this plan" };

  const c = cfg; // narrowed (used by applyChange below)
  const existing = items.find((i) => i.price?.id === cfg.priceId);
  const currentQty = existing?.quantity ?? 0;
  const none = "none" as const;
  let charge: AddonCharge | null = null;
  const done = (action: Extract<AddonChangeResult, { ok: true }>["action"], effectiveAt: number | null = null, itemId: string | null = existing?.id ?? null): AddonChangeResult => ({
    ok: true, action, addon: cfg.key, quantity, currentQuantity: action === "created" || action === "updated" ? quantity : currentQty, effectiveAt, itemId,
    proration: action === "created" || action === "updated" ? "always_invoice" : none, charge,
  });

  // The subscription's schedule (ours, or one the portal made for a scheduled downgrade), if any.
  const scheduleId = sub.schedule ? priceIdOf(sub.schedule as string | { id: string }) : null;
  const schedule = scheduleId ? await stripe.subscriptionSchedules.retrieve(scheduleId) : null;
  const ph = schedulePhases(schedule);
  if (ph && ph.future.length > 1) return { ok: false, status: 409, error: "This subscription has several scheduled changes; use the billing portal to adjust add-ons" };
  const next = ph?.future[0] ?? null;
  if (ph && (hasUnsupportedPhaseSettings(ph.current) || (next && hasUnsupportedPhaseSettings(next))))
    return { ok: false, status: 409, error: "This subscription's schedule has discounts, trial or extra invoice items; use the billing portal to adjust add-ons" };

  const increase = quantity > currentQty;
  const trialing = sub.status === "trialing";

  // ── Trial increase: charge the rest of the trial at the add-on's rate FIRST (standalone invoice); apply only once paid ──
  if (increase && trialing) {
    const paid = await chargeTrialIncrease(stripe, { sub, priceId: cfg.priceId, price: existing?.price ?? null, addon: cfg.key, from: currentQty, to: quantity, interval: interval as BillingInterval, now });
    if (!paid.ok) return paid;
    charge = paid.charge;
    // From here on the money is taken: if applying the quantity fails, refund it (a paid charge never stays without the add-on).
    try {
      return await applyChange();
    } catch (err) {
      if (charge) await refundCharge(stripe, charge, "the add-on could not be applied after the trial charge");
      throw err;
    }
  }
  return applyChange();

  async function applyChange(): Promise<AddonChangeResult> {

  /** Increase on an ACTIVE subscription: Stripe prorates and invoices at once; applied only if that invoice is paid. */
  const writeItem = async (): Promise<{ ok: true; itemId: string } | Extract<AddonChangeResult, { ok: false }>> => {
    const prorate = increase && !trialing;
    const extra = prorate ? { proration_behavior: "always_invoice" as const, payment_behavior: "pending_if_incomplete" as const } : { proration_behavior: none };
    const before = idOrNull(sub.latest_invoice as string | { id: string } | null);
    const itemId = existing
      ? (await stripe.subscriptionItems.update(existing.id, { quantity, ...extra })).id
      : (await stripe.subscriptionItems.create({ subscription: sub.id, price: c.priceId, quantity, ...extra })).id;
    if (!prorate) return { ok: true, itemId };
    const out = await inspectProrationOutcome(stripe, sub.id, before);
    if (!out.ok) return { ok: false, status: 402, code: "payment_failed", portal: true, error: `The prorated charge for the added ${c.key === "branding" ? "branding removal" : `${c.key}s`} was declined, so nothing was added and the invoice was cancelled. Update your card in the billing portal and try again.` };
    if (out.invoice) charge = { kind: "proration", invoiceId: out.invoice.id, amountPaid: out.invoice.amountPaid, currency: out.invoice.currency, lines: out.invoice.lines };
    return { ok: true, itemId: existing?.id ?? itemId };
  };

  // ── No next phase: plain increase = direct item write; decrease = start a schedule ──
  if (!next) {
    if (quantity === currentQty) return done("unchanged");
    if (increase) {
      const w = await writeItem();
      if (!w.ok) return w;
      return existing ? done("updated") : done("created", null, w.itemId);
    }
    // decrease / removal: current phase unchanged, next phase holds the lower quantity for one billing period.
    const base = schedule ?? (await stripe.subscriptionSchedules.create({ from_subscription: sub.id }));
    const basePh = schedulePhases(base);
    if (!basePh) return { ok: false, status: 409, error: "Could not read the subscription schedule" };
    const curItems = phaseItems(basePh.current);
    const planPrice = items.find((i) => i.price?.id === classified.plan!.priceId)?.price;
    const rec = planPrice?.recurring;
    const nextPhase: PhaseParam = {
      items: withQuantity(curItems, c.priceId, quantity),
      duration: { interval: (rec?.interval ?? "month") as "day" | "week" | "month" | "year", interval_count: rec?.interval_count ?? 1 },
      proration_behavior: none,
    };
    await stripe.subscriptionSchedules.update(base.id, { end_behavior: "release", proration_behavior: none, phases: [phaseParam(basePh.current, curItems), nextPhase] });
    return done("scheduled", basePh.current.end_date);
  }

  // ── A next phase exists ──
  const pendingQty = phaseItems(next).find((i) => i.price === c.priceId)?.quantity ?? 0;
  // Already exactly what is scheduled (or nothing is pending and nothing changes): no write.
  if (pendingQty === quantity && quantity <= currentQty) return done("unchanged", quantity < currentQty ? ph!.current.end_date : null);
  let itemId = existing?.id ?? null;
  let sched = schedule!;
  if (increase) {
    // Charge + apply on the subscription itself first (a schedule update can't make the change conditional on payment),
    // then re-read the schedule (Stripe records the change in it) and carry the new quantity into the next phase.
    const w = await writeItem();
    if (!w.ok) return w;
    itemId = w.itemId;
    sched = await stripe.subscriptionSchedules.retrieve(sched.id);
  }
  const ph2 = schedulePhases(sched);
  const next2 = ph2?.future[0];
  if (!ph2 || !next2) return increase ? done(existing ? "updated" : "created", null, itemId) : { ok: false, status: 409, error: "Could not read the subscription schedule" };
  const curItems = phaseItems(ph2.current);
  const nextItems = phaseItems(next2);
  const newCur = increase ? withQuantity(curItems, c.priceId, quantity) : curItems;
  const newNext = withQuantity(nextItems, c.priceId, quantity);
  if (!(sameItems(curItems, newCur) && sameItems(nextItems, newNext)))
    await stripe.subscriptionSchedules.update(sched.id, {
      end_behavior: "release",
      proration_behavior: none, // the increase was already charged above; rewriting the phases must not prorate again
      phases: [phaseParam(ph2.current, newCur), phaseParam(next2, newNext)],
    });
  // Nothing differs any more between the two phases (a pending decrease was cancelled or replaced by an increase): drop the schedule.
  // A portal-made plan downgrade keeps the phases different, so that schedule stays.
  const cleared = sameItems(newCur, newNext);
  if (cleared) await stripe.subscriptionSchedules.release(sched.id);
  if (increase) return done(existing ? "updated" : "created", null, itemId);
  return cleared || quantity === currentQty ? done("schedule_cleared") : done("scheduled", ph2.current.end_date);
  }
}

/** Best effort: give back a trial charge whose add-on could not be applied (credit note with a refund to the card). */
async function refundCharge(stripe: AddonStripe, charge: AddonCharge, why: string) {
  try {
    if (!stripe.creditNotes) throw new Error("no creditNotes client");
    await stripe.creditNotes.create({ invoice: charge.invoiceId, amount: charge.amountPaid, refund_amount: charge.amountPaid, memo: `Refund: ${why}` });
  } catch (err) {
    console.error("[billing] could not refund an add-on charge; refund it manually", charge.invoiceId, err instanceof Error ? err.message : err);
  }
}

/**
 * Trial increase: the add-on's rate for the rest of the trial (`trialProrationAmount`), charged now on a standalone
 * invoice to the card on file. No card → 402 no_payment_method (nothing created). Declined → invoice voided, 402.
 * Idempotency key = subscription + price + trial end + from→to: within one period an add-on's current quantity only
 * goes up (decreases are scheduled), so a transition happens once; a retried / doubled request reuses the same invoice.
 */
async function chargeTrialIncrease(
  stripe: AddonStripe,
  p: { sub: Stripe.Subscription; priceId: string; price: Stripe.Price | null; addon: string; from: number; to: number; interval: BillingInterval; now: Date },
): Promise<{ ok: true; charge: AddonCharge | null } | Extract<AddonChangeResult, { ok: false }>> {
  if (!stripe.invoices || !stripe.invoiceItems || !stripe.customers || !stripe.prices) throw new Error("setAddonQuantity: the Stripe client needs invoices, invoiceItems, customers and prices for trial increases");
  const customerId = priceIdOf(p.sub.customer as string | { id: string });
  const customer = await stripe.customers.retrieve(customerId);
  const pm =
    idOrNull(p.sub.default_payment_method as string | { id: string } | null) ??
    (customer.deleted ? null : idOrNull(customer.invoice_settings?.default_payment_method as string | { id: string } | null));
  if (!pm) return { ok: false, status: 402, code: "no_payment_method", portal: true, error: "There is no payment method on file. Add one in the billing portal, then add the add-on." };
  const price = p.price?.unit_amount != null ? p.price : await stripe.prices.retrieve(p.priceId);
  const periodEnd = p.sub.trial_end ?? p.sub.items.data[0]?.current_period_end ?? 0;
  const nowSec = Math.floor(p.now.getTime() / 1000);
  const amount = trialProrationAmount({ unitAmount: price.unit_amount ?? 0, delta: p.to - p.from, now: nowSec, periodEnd, interval: p.interval });
  if (amount <= 0) return { ok: true, charge: null }; // the trial ends now: the renewal invoice bills it in full
  const label = p.addon === "branding" ? "Branding removal" : p.addon === "seat" ? "Extra seat" : p.addon === "location" ? "Extra location" : p.addon;
  const end = new Date(periodEnd * 1000).toISOString().slice(0, 10);
  const out = await chargeOneOff(stripe as ChargeStripe, {
    customer: customerId,
    paymentMethod: pm,
    amount,
    currency: price.currency ?? "usd",
    description: `FlowOps ${label}: +${p.to - p.from} during the free trial, prorated until ${end}`,
    metadata: { flowops_addon_charge: "trial_proration", subscription: p.sub.id, addon: p.addon, from: String(p.from), to: String(p.to) },
    idempotencyKey: `flowops-trial-addon-${p.sub.id}-${p.priceId}-${periodEnd}-${p.from}-${p.to}`,
    period: { start: nowSec, end: periodEnd },
  });
  if (!out.ok)
    return out.code === "payment_failed"
      ? { ok: false, status: 402, code: "payment_failed", portal: true, error: "Your card was declined, so nothing was charged and nothing was added. Update your card in the billing portal and try again." }
      : { ok: false, status: 502, code: "stripe_error", portal: true, error: "The add-on could not be charged, so nothing was added. Try again, or check your payment method in the billing portal." };
  return { ok: true, charge: { kind: "trial_proration", invoiceId: out.invoiceId, amountPaid: out.amountPaid, currency: out.currency } };
}

/** Recurring add-ons currently configured, for UI/GET: key + price ids per interval + the most one subscription may hold (no amounts: those live in Stripe). Text packs are listed separately. */
export function configuredAddons(env: Env = process.env) {
  const keys = [...new Set(recurringAddons(env).map((a) => a.key))];
  return keys.map((key) => {
    const month = addonPrice(key, "month", env)?.priceId;
    const year = addonPrice(key, "year", env)?.priceId;
    return { key, priceId: month ?? year!, prices: { ...(month ? { month } : {}), ...(year ? { year } : {}) }, known: addonEffect(key) !== null, max: addonMaxQuantity(key, env) };
  });
}

