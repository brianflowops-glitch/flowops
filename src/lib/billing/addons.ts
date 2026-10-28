/**
 * Add-on changes on an existing subscription (docs/BILLING.md §11). The Stripe client is injected
 * so this runs offline in tests; no "server-only" import for the same reason.
 *
 * Policy (Brian, 2026-10-27; patch 0004 replaces the "billed at renewal" rule for increases):
 *   - Increase / new add-on (seat, location, branding): charged NOW, prorated for the rest of the current period
 *     (monthly or annual). Active subscription: Stripe prorates (`proration_behavior: "always_invoice"`) and the
 *     write uses `payment_behavior: "pending_if_incomplete"`, so the new quantity only takes effect once that
 *     immediate invoice is paid. A failed payment voids the invoice, which discards the pending update: nothing is
 *     granted and the caller gets 402. During a free TRIAL (0008, Brian 2026-10-28: `TRIAL_ADDON_POLICY = "at_trial_end"`)
 *     the increase is applied now with no charge (`proration_behavior: "none"`, no invoice) and the FIRST invoice at
 *     the trial end bills it in full with the plan. (The older "charge_now" branch, which charged the rest of the
 *     trial on a standalone invoice before applying, is kept and tested but is not the default.)
 *   - Decrease / removal (unchanged): the add-on stays active until the current period ends, then drops at renewal.
 *     Done with a subscription schedule whose next phase holds the lower quantity. No refund, no proration credit.
 *   - A later change replaces a pending one (see `setAddonQuantity`).
 *   - What happens to an increase DURING A TRIAL is decided in exactly one place: `TRIAL_ADDON_POLICY` below.
 */
import type Stripe from "stripe";
import { addonByKey, addonPrice, isTextPackKey, plans, recurringAddons, type BillingInterval } from "./config";
import { addonEffect, addonMaxQuantity, classifyItems, entitlementsFromItems, planLimits, type Entitlements } from "./entitlements";
import { abandonInvoice, chargeOneOff, inspectProrationOutcome, refundAddonCharge, trialProrationAmount, type AddonChargeLedger, type AddonChargeRecord, type ChargeStripe, type RefundStripe } from "./addon-charge";

type Env = Record<string, string | undefined>;

// ───────────────────────── trial add-on policy: THE switch point ─────────────────────────

/**
 * What an add-on INCREASE during a free trial costs:
 *   "charge_now"   → the add-on's rate for the rest of the trial is charged immediately on a standalone invoice, and
 *                    the quantity is applied only once that is paid (Brian, 2026-10-27; the default until 0008).
 *   "at_trial_end" → applied now with no charge; the first invoice at the end of the trial bills it in full
 *                    (Brian, 2026-10-28; THE DEFAULT since 0008). Trade-off: a trial user can add up to the caps
 *                    (e.g. 50 seats, 10 locations) free for the rest of the trial and cancel before it ends.
 * Decreases/removals are the same under both (scheduled for the renewal, no credit).
 */
export type TrialAddonPolicy = "charge_now" | "at_trial_end";

/**
 * THE ONE PLACE to flip the trial add-on rule. Deliberately a code constant reviewed in a PR, NOT an env var or a
 * runtime setting (billing rules must not be flippable at runtime). Changing it also requires updating the guard
 * test in scripts/billing-tests.ts ("TRIAL_ADDON_POLICY is at_trial_end") and docs/BILLING.md §11.
 * Under "at_trial_end" the trial-charge code (chargeTrialIncrease, per-attempt keys, the addon_charge ledger and its
 * sweep/cron) is not reached by new requests; it stays because it IS the "charge_now" branch and it still settles
 * any attempt rows written before the flip.
 */
export const TRIAL_ADDON_POLICY: TrialAddonPolicy = "at_trial_end";

/** How a trial increase is handled under a policy (pure; both branches are tested). */
export function trialIncreaseHandling(policy: TrialAddonPolicy): "charge_rest_of_trial_now" | "apply_free_until_trial_end" {
  return policy === "at_trial_end" ? "apply_free_until_trial_end" : "charge_rest_of_trial_now";
}

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
  creditNotes?: RefundStripe["creditNotes"];
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
      /** "always_invoice" for an increase that was charged now (prorated); "none" for decreases / no change and for a
       *  trial increase applied free until the trial ends (at_trial_end). */
      proration: "none" | "always_invoice";
      charge: AddonCharge | null;
      /** Trial increase applied free (at_trial_end): unix seconds of the trial end, when the first invoice bills it. Else null. */
      freeUntil?: number | null;
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
  /**
   * Required for trial increases under "charge_now" (not the default since 0008): the per-attempt `addon_charge` record (addon-charges-db.ts in
   * the app). The CALLER MUST HOLD THE ORG ROW LOCK (the route does): unresolved attempts of this org are settled
   * first (`reconcileAddonCharges`), which is only safe when no other request of the org is in flight.
   */
  ledger?: AddonChargeLedger;
  /** Attempt id generator (tests). Default: a random UUID. */
  newAttemptId?: () => string;
}

type PhaseParam = Stripe.SubscriptionScheduleUpdateParams.Phase;

/**
 * A phase rewritten with new items. Everything we rewrite is carried over: dates, metadata and the phase's
 * `trial_end` (0005: without it, rewriting a trialing subscription's current phase would end the trial early).
 */
export function phaseParam(p: Stripe.SubscriptionSchedule.Phase, items: PhaseItem[]): PhaseParam {
  return {
    start_date: p.start_date,
    end_date: p.end_date,
    items,
    proration_behavior: "none",
    ...(p.trial_end ? { trial_end: p.trial_end } : {}),
    ...(p.metadata && Object.keys(p.metadata).length ? { metadata: p.metadata } : {}),
  };
}

/** Phases we can't safely rewrite (they'd lose settings we don't copy): refuse instead of dropping them. (`trial_end` is carried, 0005.) */
const hasUnsupportedPhaseSettings = (p: Stripe.SubscriptionSchedule.Phase) => Boolean((p.discounts && p.discounts.length) || (p.add_invoice_items && p.add_invoice_items.length));

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
export async function setAddonQuantity(input: ChangeAddonInput): Promise<AddonChangeResult> {
  return setAddonQuantityUnderPolicy(TRIAL_ADDON_POLICY, input);
}

/**
 * `setAddonQuantity` with an explicit trial policy. TESTS ONLY (so both branches stay tested): app code calls
 * `setAddonQuantity`, which always uses the `TRIAL_ADDON_POLICY` constant.
 */
export async function setAddonQuantityUnderPolicy(policy: TrialAddonPolicy, { stripe, subscription, addon, quantity, env = process.env, now = new Date(), ledger, newAttemptId }: ChangeAddonInput): Promise<AddonChangeResult> {
  // Text bundles are one-time packs now (text-packs.ts / POST /api/billing/text-packs), never a recurring add-on.
  if (isTextPackKey(addon)) return { ok: false, status: 400, error: "Text bundles are one-time packs now. Buy them with POST /api/billing/text-packs; they are not a recurring add-on." };
  const known = addonByKey(addon, env);
  if (!known) return { ok: false, status: 400, error: "Unknown add-on" };
  const invalid = validateAddonQuantity(known.key, quantity, env);
  if (invalid) return invalid;
  if (!(ADDON_CHANGE_STATUSES as readonly string[]).includes(subscription.status))
    return { ok: false, status: 409, error: "Add-ons can only be changed on an active subscription. Fix the payment in the billing portal first." };

  // Settle attempts a crashed request left behind before anything new is charged (we hold the org lock).
  if (ledger) await reconcileAddonCharges(stripe, ledger);

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
  /** Set for a charged trial increase: marks its `addon_charge` row applied as soon as Stripe confirms the item write. */
  let onItemWritten: (() => Promise<void>) | null = null;
  const existing = items.find((i) => i.price?.id === cfg.priceId);
  const currentQty = existing?.quantity ?? 0;
  const none = "none" as const;
  let charge: AddonCharge | null = null;
  const done = (action: Extract<AddonChangeResult, { ok: true }>["action"], effectiveAt: number | null = null, itemId: string | null = existing?.id ?? null): AddonChangeResult => {
    const written = action === "created" || action === "updated";
    // A trial increase that was not charged now (at_trial_end, or no trial time left) is free until the trial end.
    const freeTrialAdd = written && trialing && !charge;
    return {
      ok: true, action, addon: cfg.key, quantity, currentQuantity: written ? quantity : currentQty, effectiveAt, itemId,
      proration: written && !freeTrialAdd ? "always_invoice" : none, charge,
      freeUntil: freeTrialAdd ? (sub.trial_end ?? null) : null,
    };
  };

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

  // ── Trial increase under "charge_now": charge the rest of the trial at the add-on's rate FIRST (standalone invoice,
  //    one `addon_charge` attempt row written before any Stripe call); apply only once paid. Under "at_trial_end"
  //    the increase is applied with no charge and the trial-end invoice bills it (TRIAL_ADDON_POLICY). ──
  if (increase && trialing && trialIncreaseHandling(policy) === "charge_rest_of_trial_now") {
    if (!ledger) throw new Error("setAddonQuantity: a trial increase needs the addon_charge ledger (and the org row lock)");
    const paid = await chargeTrialIncrease(stripe, ledger, { sub, priceId: cfg.priceId, price: existing?.price ?? null, addon: cfg.key, from: currentQty, to: quantity, interval: interval as BillingInterval, now, attemptId: (newAttemptId ?? defaultAttemptId)() });
    if (!paid.ok) return paid;
    charge = paid.charge;
    if (!paid.record) return applyChange(); // nothing was charged (no trial time left)
    const rec = paid.record;
    // From here on the money is taken. The row becomes `applied` the moment Stripe confirms the item write (0006,
    // `onItemWritten`), BEFORE any later step (schedule re-read / phase rewrite / release): if one of those fails, or the
    // process dies after it, the add-on was active, so the sweep must never refund it. If the item write itself fails
    // or throws, settle the attempt from Stripe's state (applied after all → keep; not applied → refund once).
    let itemConfirmed = false;
    onItemWritten = async () => {
      itemConfirmed = true;
      // A failed DB write here leaves the row `paid`; the sweep then finds the item on the subscription → applied.
      await ledger.update(rec.id, { status: "applied", note: "item confirmed by Stripe" }).catch((e) => console.error("[billing] could not mark add-on charge applied (sweep will)", rec.id, e instanceof Error ? e.message : e));
    };
    let result: AddonChangeResult;
    try {
      result = await applyChange();
    } catch (err) {
      if (!itemConfirmed) await reconcileAddonCharges(stripe, ledger, [rec]).catch((e) => console.error("[billing] add-on charge left for the sweep", rec.id, e instanceof Error ? e.message : e));
      throw err;
    }
    if (!itemConfirmed) {
      if (result.ok) await ledger.update(rec.id, { status: "applied" });
      else await reconcileAddonCharges(stripe, ledger, [rec]);
    }
    return result;
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
    if (onItemWritten) await onItemWritten();
    if (!prorate) return { ok: true, itemId };
    const out = await inspectProrationOutcome(stripe, sub.id, before);
    if (!out.ok && out.reason === "unidentified")
      return { ok: false, status: 502, code: "stripe_error", portal: true, error: "Stripe didn't confirm the prorated charge, so nothing was added. Check the billing portal for an open invoice before trying again." };
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

const defaultAttemptId = () => `adc_${globalThis.crypto.randomUUID()}`;

/**
 * Trial increase: the add-on's rate for the rest of the trial (`trialProrationAmount`), charged now on a standalone
 * invoice to the card on file. No card → 402 no_payment_method (nothing created, no row). Declined → invoice voided,
 * row `failed`, 402.
 *
 * Every attempt gets its own `addon_charge` row (written BEFORE any Stripe call) and its own idempotency key
 * (attempt id + payment method, 0005): a retry after a decline is a new attempt with a fresh invoice, never a replay
 * of the voided one. Double clicks can't double-charge: the route serialises per org, and after a success the
 * current quantity is the target (no increase left to charge).
 */
async function chargeTrialIncrease(
  stripe: AddonStripe,
  ledger: AddonChargeLedger,
  p: { sub: Stripe.Subscription; priceId: string; price: Stripe.Price | null; addon: string; from: number; to: number; interval: BillingInterval; now: Date; attemptId: string },
): Promise<{ ok: true; charge: AddonCharge | null; record: AddonChargeRecord | null } | Extract<AddonChangeResult, { ok: false }>> {
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
  if (amount <= 0) return { ok: true, charge: null, record: null }; // the trial ends now: the renewal invoice bills it in full
  const currency = price.currency ?? "usd";
  const record = { id: p.attemptId, subscriptionId: p.sub.id, customerId, addon: p.addon, priceId: p.priceId, fromQuantity: p.from, toQuantity: p.to, amount, currency, paymentMethod: pm };
  await ledger.insert(record);
  const label = p.addon === "branding" ? "Branding removal" : p.addon === "seat" ? "Extra seat" : p.addon === "location" ? "Extra location" : p.addon;
  const end = new Date(periodEnd * 1000).toISOString().slice(0, 10);
  const out = await chargeOneOff(stripe as ChargeStripe, {
    customer: customerId,
    paymentMethod: pm,
    amount,
    currency,
    description: `FlowOps ${label}: +${p.to - p.from} during the free trial, prorated until ${end}`,
    metadata: { flowops_addon_charge: "trial_proration", flowops_addon_charge_id: p.attemptId, subscription: p.sub.id, addon: p.addon, from: String(p.from), to: String(p.to) },
    idempotencyKey: trialChargeIdempotencyKey(p.attemptId, pm),
    period: { start: nowSec, end: periodEnd },
    onInvoiceCreated: (invoiceId) => ledger.update(p.attemptId, { invoiceId }),
  });
  if (!out.ok) {
    // Voided / deleted (or never created): nothing was collected. If the void itself failed, leave the row pending for the sweep.
    if (out.final !== "unknown") await ledger.update(p.attemptId, { status: "failed", note: out.code });
    return out.code === "payment_failed"
      ? { ok: false, status: 402, code: "payment_failed", portal: true, error: "Your card was declined, so nothing was charged and nothing was added. Update your card in the billing portal and try again." }
      : { ok: false, status: 502, code: "stripe_error", portal: true, error: "The add-on could not be charged, so nothing was added. Try again, or check your payment method in the billing portal." };
  }
  await ledger.update(p.attemptId, { status: "paid", invoiceId: out.invoiceId });
  return { ok: true, charge: { kind: "trial_proration", invoiceId: out.invoiceId, amountPaid: out.amountPaid, currency: out.currency }, record: { ...record, orgId: ledger.orgId, status: "paid", invoiceId: out.invoiceId, creditNoteId: null, createdAt: p.now } };
}

/** Idempotency key of one trial-charge attempt: unique per attempt and payment method (never reused after a decline). */
export const trialChargeIdempotencyKey = (attemptId: string, paymentMethod: string) => `flowops-trial-addon-${attemptId}-${paymentMethod}`;

/**
 * Settle trial add-on charge attempts that a crashed or failed request left `pending` / `paid` (0005). Idempotent;
 * never grants anything (it never writes a subscription item) and never refunds twice (`refundAddonCharge`).
 * CALLER MUST HOLD THE ORG ROW LOCK (so no attempt of this org is in flight):
 *   pending → find its invoice (stored id, else by `flowops_addon_charge_id` metadata): paid → treat as paid;
 *             open/draft → void it → failed; none → failed.
 *   paid    → the add-on is applied iff the subscription item for the price has at least `to_quantity` → applied;
 *             otherwise refund the invoice with a credit note → refunded (Stripe unreachable → stays paid, retried).
 * Pass `rows` to settle specific attempts; default = every unresolved attempt of the ledger's org.
 */
export async function reconcileAddonCharges(stripe: AddonStripe, ledger: AddonChargeLedger, rows?: AddonChargeRecord[]): Promise<{ id: string; status: string }[]> {
  const todo = rows ?? (await ledger.unresolved());
  const out: { id: string; status: string }[] = [];
  for (const r of todo) {
    try {
      out.push(await reconcileOne(stripe, ledger, r));
    } catch (err) {
      // One bad attempt (e.g. its customer is gone) must not block the others; it stays unresolved for the next run.
      console.error("[billing] could not reconcile add-on charge", r.id, err instanceof Error ? err.message : err);
      out.push({ id: r.id, status: "error" });
    }
  }
  return out;
}

async function reconcileOne(stripe: AddonStripe, ledger: AddonChargeLedger, r: AddonChargeRecord): Promise<{ id: string; status: string }> {
  {
    let status = r.status;
    let invoiceId = r.invoiceId;
    let amountPaid = r.amount;
    if (status === "pending") {
      let inv: Stripe.Invoice | null = null;
      if (invoiceId && stripe.invoices) inv = await stripe.invoices.retrieve(invoiceId);
      else if (stripe.invoices?.list) {
        // Newest first; the attempt is recent, so its invoice is among the customer's latest. (No `created` filter:
        // invoice timestamps follow a test clock's frozen time, not the wall clock our row was written with.)
        const list = await stripe.invoices.list({ customer: r.customerId, limit: 100 });
        inv = list.data.find((i) => i.metadata?.flowops_addon_charge_id === r.id) ?? null;
      }
      let final = inv?.status ?? "none";
      if (inv && final !== "paid" && stripe.invoices) final = await abandonInvoice({ invoices: stripe.invoices }, inv.id!);
      if (final === "paid" && inv) {
        status = "paid";
        invoiceId = inv.id!;
        await ledger.update(r.id, { status: "paid", invoiceId });
      } else if (final === "unknown") {
        return { id: r.id, status: "pending" }; // couldn't void it yet: try again later
      } else {
        await ledger.update(r.id, { status: "failed", ...(inv ? { invoiceId: inv.id! } : {}), note: `reconciled: invoice ${final}` });
        return { id: r.id, status: "failed" };
      }
    }
    if (status !== "paid") return { id: r.id, status };
    const sub = await retrieveSubscriptionComplete(stripe, r.subscriptionId);
    const qty = sub.status === "canceled" || sub.status === "incomplete_expired" ? 0 : (sub.items.data.find((i) => i.price?.id === r.priceId)?.quantity ?? 0);
    if (qty >= r.toQuantity) {
      await ledger.update(r.id, { status: "applied", note: "reconciled: add-on found on the subscription" });
      return { id: r.id, status: "applied" };
    }
    if (invoiceId && stripe.invoices) amountPaid = (await stripe.invoices.retrieve(invoiceId)).amount_paid ?? amountPaid;
    const cn = await refundAddonCharge(stripe, { id: r.id, invoiceId, amount: r.amount }, amountPaid, "the add-on could not be applied after the trial charge");
    if (!cn) return { id: r.id, status: "paid" }; // Stripe unreachable: retried by the next run
    await ledger.update(r.id, { status: "refunded", creditNoteId: cn });
    return { id: r.id, status: "refunded" };
  }
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

