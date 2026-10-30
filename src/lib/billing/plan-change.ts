/**
 * In-app plan switching and schedule-safe cancel (docs/BILLING.md §12). The Stripe client is injected so this runs
 * offline in tests; no "server-only" import for the same reason. Works for subscriptions with add-on items and with
 * an attached subscription schedule (pending add-on removals, a pending plan change, ours or the portal's).
 *
 * Policy (Brian, 2026-10-30):
 *   - UPGRADE (higher tier, or monthly → annual): `UPGRADE_POLICY` below. Default "prorate_now": applied now, charged
 *     now, prorated (`proration_behavior: "always_invoice"` + `payment_behavior: "pending_if_incomplete"`, the same as
 *     seat/location increases). A failed charge voids the proration invoice, which discards the pending update: no
 *     change is applied, 402. ("at_renewal", kept and tested but NOT the default: scheduled for the next renewal.)
 *   - DOWNGRADE (lower tier) and ANNUAL → MONTHLY: always at the next renewal, as the next phase of a subscription
 *     schedule. No credit, no refund.
 *   - TRIAL: no charge, the trial continues. An upgrade is applied now with `proration_behavior: "none"` and the trial
 *     end kept; a downgrade waits for the trial end (the first renewal).
 *   - Add-on items switch interval with the plan (the matching monthly/annual add-on price); a pending add-on
 *     removal in the next phase is kept (and mapped to the new plan/interval too).
 *   - A new plan choice replaces a pending plan change; choosing the current plan cancels a pending one.
 */
import type Stripe from "stripe";
import { addonByPriceId, addonPrice, planByKey, planByPriceId, type BillingInterval } from "./config";
import { inspectProrationOutcome } from "./addon-charge";
import { phaseItems, phaseParam, retrieveSubscriptionComplete, sameItems, schedulePhases, type AddonStripe, type PhaseItem } from "./addons";

type Env = Record<string, string | undefined>;

// ───────────────────────── upgrade policy: THE switch point ─────────────────────────

/**
 * What an UPGRADE (higher tier, or monthly → annual) on an ACTIVE subscription does:
 *   "prorate_now" → applied now and charged now, prorated (always_invoice + pending_if_incomplete); declined → nothing
 *                   changes (Brian, 2026-10-30; THE DEFAULT).
 *   "at_renewal"  → scheduled for the next renewal like a downgrade (kept and tested, not the default).
 * Downgrades and annual → monthly are at renewal under both; trials are never charged under both.
 */
export type UpgradePolicy = "at_renewal" | "prorate_now";
export const UPGRADE_POLICY: UpgradePolicy = "prorate_now";

/** Tier order of the configured plans (lowest first). Unknown keys fall back to comparing monthly-equivalent prices. */
export const PLAN_TIERS = ["starter", "pro", "business"] as const;

export const PLAN_CHANGE_STATUSES = ["active", "trialing"] as const;

export interface PlanStripe extends AddonStripe {
  subscriptions: AddonStripe["subscriptions"] & { update(id: string, params: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription> };
  prices?: { retrieve(id: string): Promise<Stripe.Price> };
}

export type PlanChangeKind = "upgrade" | "downgrade" | "none";

export type PlanChangeResult =
  | {
      ok: true;
      /** applied: active now (charged now unless trialing). scheduled: at the next renewal. pending_cleared: a pending plan change was cancelled. */
      action: "applied" | "scheduled" | "pending_cleared" | "unchanged";
      kind: PlanChangeKind;
      plan: string;
      interval: BillingInterval;
      /** Unix seconds when a scheduled change takes effect (the renewal / trial end), else null. */
      effectiveAt: number | null;
      proration: "none" | "always_invoice";
      charge: { invoiceId: string; amountPaid: number; currency: string } | null;
      /** Trialing: the trial end that was kept (no charge until then). */
      trialEnd: number | null;
    }
  | { ok: false; status: 400 | 402 | 409 | 502; error: string; code?: "payment_failed" | "stripe_error" | "unsupported" | "cancel_pending"; portal?: boolean; support?: boolean };

export interface ChangePlanInput {
  stripe: PlanStripe;
  subscription: Pick<Stripe.Subscription, "id" | "status">;
  plan: string;
  interval: BillingInterval;
  env?: Env;
}

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.id);
type PhaseParam = Stripe.SubscriptionScheduleUpdateParams.Phase;

/** Unsupported schedule settings we would drop if we rewrote the phases (same rule as add-ons). */
const hasUnsupportedPhaseSettings = (p: Stripe.SubscriptionSchedule.Phase) => Boolean((p.discounts && p.discounts.length) || (p.add_invoice_items && p.add_invoice_items.length));

/**
 * Items mapped to a plan + interval: the plan item becomes the target plan's price, every add-on its price for the
 * target interval (Stripe: one interval per subscription). Null + reason when something can't be mapped.
 */
export function itemsForPlan(items: readonly PhaseItem[], targetPriceId: string, interval: BillingInterval, env: Env = process.env): { ok: true; items: PhaseItem[] } | { ok: false; error: string } {
  const out: PhaseItem[] = [];
  let planDone = false;
  for (const it of items) {
    if (planByPriceId(it.price, env)) {
      if (!planDone) out.push({ price: targetPriceId, quantity: 1 });
      planDone = true;
      continue;
    }
    const a = addonByPriceId(it.price, env);
    if (!a) return { ok: false, error: "This subscription has an item FlowOps doesn't recognise, so the plan can't be changed in the app" };
    const mapped = addonPrice(a.key, interval, env);
    if (!mapped) return { ok: false, error: `The "${a.key}" add-on has no ${interval === "year" ? "annual" : "monthly"} price configured, so it can't move to a ${interval === "year" ? "yearly" : "monthly"} plan` };
    const existing = out.find((o) => o.price === mapped.priceId);
    if (existing) existing.quantity += it.quantity;
    else out.push({ price: mapped.priceId, quantity: it.quantity });
  }
  if (!planDone) out.unshift({ price: targetPriceId, quantity: 1 });
  return { ok: true, items: out };
}

/**
 * upgrade / downgrade / none. Annual → monthly is always "downgrade" (at renewal); monthly → annual on the same tier
 * is an "upgrade" (charged now under prorate_now). A lower tier is a downgrade whatever the interval.
 */
export function classifyPlanChange(from: { key: string; interval: BillingInterval; monthlyAmount?: number | null }, to: { key: string; interval: BillingInterval; monthlyAmount?: number | null }): PlanChangeKind {
  if (from.key === to.key && from.interval === to.interval) return "none";
  const rank = (k: string) => (PLAN_TIERS as readonly string[]).indexOf(k);
  let tier = 0;
  if (rank(from.key) >= 0 && rank(to.key) >= 0) tier = Math.sign(rank(to.key) - rank(from.key));
  else if (from.key !== to.key) tier = Math.sign((to.monthlyAmount ?? 0) - (from.monthlyAmount ?? 0));
  if (tier < 0) return "downgrade";
  if (from.interval === "year" && to.interval === "month") return "downgrade";
  if (tier > 0) return "upgrade";
  return to.interval === "year" ? "upgrade" : "downgrade";
}

/** The next phase as a schedule phase param, on `interval` (its own billing period). */
const nextPhaseParam = (items: PhaseItem[], interval: BillingInterval, metadata?: Stripe.Metadata | null): PhaseParam => ({
  items,
  duration: { interval, interval_count: 1 },
  proration_behavior: "none",
  ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
});

/**
 * Make the subscription's NEXT phase hold `nextItems` (creating a schedule from the subscription if needed); releases
 * the schedule when the next phase would equal the current one. The current phase is rewritten unchanged
 * (`phaseParam` keeps its dates and trial_end). Returns when the next phase starts, or null when cleared.
 */
export async function writeNextPhase(stripe: PlanStripe, subId: string, schedule: Stripe.SubscriptionSchedule | null, nextItems: PhaseItem[], interval: BillingInterval): Promise<{ ok: true; effectiveAt: number | null } | { ok: false; error: string }> {
  const base = schedule ?? (await stripe.subscriptionSchedules.create({ from_subscription: subId }));
  const ph = schedulePhases(base);
  if (!ph) return { ok: false, error: "Could not read the subscription schedule" };
  const cur = phaseItems(ph.current);
  if (sameItems(cur, nextItems)) {
    await stripe.subscriptionSchedules.release(base.id);
    return { ok: true, effectiveAt: null };
  }
  await stripe.subscriptionSchedules.update(base.id, { end_behavior: "release", proration_behavior: "none", phases: [phaseParam(ph.current, cur), nextPhaseParam(nextItems, interval, ph.future[0]?.metadata)] });
  return { ok: true, effectiveAt: ph.current.end_date };
}

export async function changePlan(input: ChangePlanInput): Promise<PlanChangeResult> {
  return changePlanUnderPolicy(UPGRADE_POLICY, input);
}

/** `changePlan` with an explicit upgrade policy. TESTS ONLY (both branches stay tested); app code calls `changePlan`. */
export async function changePlanUnderPolicy(policy: UpgradePolicy, { stripe, subscription, plan, interval, env = process.env }: ChangePlanInput): Promise<PlanChangeResult> {
  const target = planByKey(plan, env, interval);
  if (!target) return { ok: false, status: 400, error: `There is no ${interval === "year" ? "annual" : "monthly"} price for the "${plan}" plan` };
  if (!(PLAN_CHANGE_STATUSES as readonly string[]).includes(subscription.status))
    return { ok: false, status: 409, error: "The plan can only be changed on an active subscription. Fix the payment in the billing portal first.", portal: true };

  const sub = await retrieveSubscriptionComplete(stripe, subscription.id);
  const subItems = sub.items.data;
  const curItems: PhaseItem[] = subItems.map((i) => ({ price: i.price.id, quantity: i.quantity ?? 1 }));
  const planItem = subItems.find((i) => planByPriceId(i.price?.id, env));
  const current = planItem ? planByPriceId(planItem.price.id, env)! : null;
  if (!current || !planItem) return { ok: false, status: 409, code: "unsupported", support: true, error: "This subscription is not on a configured plan; contact support to change it" };
  const trialing = sub.status === "trialing";
  const result = (action: Extract<PlanChangeResult, { ok: true }>["action"], kind: PlanChangeKind, effectiveAt: number | null, charge: Extract<PlanChangeResult, { ok: true }>["charge"] = null): PlanChangeResult => ({
    ok: true, action, kind, plan: target.key, interval: target.interval, effectiveAt,
    proration: action === "applied" && !trialing ? "always_invoice" : "none", charge, trialEnd: trialing ? (sub.trial_end ?? null) : null,
  });

  // A pending cancellation: resume first (otherwise the new plan would be cancelled at the period end anyway).
  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  const schedule = scheduleId ? await stripe.subscriptionSchedules.retrieve(scheduleId) : null;
  if (sub.cancel_at_period_end || sub.cancel_at || (schedule && schedule.status === "active" && schedule.end_behavior === "cancel"))
    return { ok: false, status: 409, code: "cancel_pending", error: "This subscription is set to cancel at the end of the period. Resume it first, then change the plan." };
  const ph = schedulePhases(schedule);
  if (ph && ph.future.length > 1) return { ok: false, status: 409, code: "unsupported", support: true, error: "This subscription has several scheduled changes; contact support to change the plan" };
  if (ph && (hasUnsupportedPhaseSettings(ph.current) || ph.future.some(hasUnsupportedPhaseSettings)))
    return { ok: false, status: 409, code: "unsupported", support: true, error: "This subscription's schedule has discounts or extra invoice items; contact support to change the plan" };
  const next = ph?.future[0] ?? null;
  const pendingItems = next ? phaseItems(next) : curItems;

  // Monthly-equivalent amounts are only needed for plan keys outside PLAN_TIERS.
  const known = (k: string) => (PLAN_TIERS as readonly string[]).includes(k);
  let fromAmt: number | null = null;
  let toAmt: number | null = null;
  if ((!known(current.key) || !known(target.key)) && current.key !== target.key && stripe.prices) {
    const norm = (p: Stripe.Price) => (p.unit_amount ?? 0) / (p.recurring?.interval === "year" ? 12 : 1);
    fromAmt = norm(planItem.price);
    toAmt = norm(await stripe.prices.retrieve(target.priceId));
  }
  const kind = classifyPlanChange({ key: current.key, interval: current.interval, monthlyAmount: fromAmt }, { key: target.key, interval: target.interval, monthlyAmount: toAmt });

  // ── Same plan and interval: nothing now; cancels a pending plan change (pending add-on changes are kept). ──
  if (kind === "none") {
    if (!next) return result("unchanged", "none", null);
    const nextPlanPrice = pendingItems.find((i) => planByPriceId(i.price, env))?.price;
    if (nextPlanPrice === target.priceId) return result("unchanged", "none", next.start_date);
    const mapped = itemsForPlan(pendingItems, target.priceId, target.interval, env);
    if (!mapped.ok) return { ok: false, status: 409, code: "unsupported", support: true, error: mapped.error };
    const w = await writeNextPhase(stripe, sub.id, schedule, mapped.items, target.interval);
    if (!w.ok) return { ok: false, status: 409, error: w.error };
    return result("pending_cleared", "none", w.effectiveAt);
  }

  // Validate both mappings before anything is written.
  const nowMapped = itemsForPlan(curItems, target.priceId, target.interval, env);
  if (!nowMapped.ok) return { ok: false, status: 409, code: "unsupported", support: true, error: nowMapped.error };
  const nextMapped = itemsForPlan(pendingItems, target.priceId, target.interval, env);
  if (!nextMapped.ok) return { ok: false, status: 409, code: "unsupported", support: true, error: nextMapped.error };

  const applyNow = kind === "upgrade" && (trialing || policy === "prorate_now");

  // ── At renewal (downgrade, annual → monthly, or an upgrade under "at_renewal"): the next phase holds the new plan. ──
  if (!applyNow) {
    const w = await writeNextPhase(stripe, sub.id, schedule, nextMapped.items, target.interval);
    if (!w.ok) return { ok: false, status: 409, error: w.error };
    return result("scheduled", kind, w.effectiveAt);
  }

  // ── Now: upgrade on an active subscription (charged, prorated, only if paid) or during the trial (free, trial kept). ──
  // A schedule can't make a change conditional on payment, so it is released first and re-created afterwards with
  // the pending next phase (add-on removals) mapped to the new plan. If the charge fails, the original next phase is
  // put back, so a pending removal is never lost.
  const originalNext = next ? { items: phaseItems(next), interval: current.interval, metadata: next.metadata } : null;
  if (schedule && ph) await stripe.subscriptionSchedules.release(schedule.id);
  const itemParams: Stripe.SubscriptionUpdateParams.Item[] = [];
  const used = new Set<string>();
  for (const it of subItems) {
    const want = planByPriceId(it.price.id, env) ? target.priceId : (addonPrice(addonByPriceId(it.price.id, env)!.key, target.interval, env)!.priceId);
    if (want === it.price.id) continue;
    if (used.has(want)) itemParams.push({ id: it.id, deleted: true });
    else itemParams.push({ id: it.id, price: want, quantity: nowMapped.items.find((n) => n.price === want)!.quantity });
    used.add(want);
  }
  const before = idOf(sub.latest_invoice as string | { id: string } | null);
  const params: Stripe.SubscriptionUpdateParams = trialing
    ? { items: itemParams, proration_behavior: "none", ...(sub.trial_end ? { trial_end: sub.trial_end } : {}) }
    : { items: itemParams, proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" };
  const restore = async () => {
    if (originalNext) await writeNextPhase(stripe, sub.id, null, originalNext.items, originalNext.interval).catch((e) => console.error("[billing] could not restore the pending schedule after a failed plan change", sub.id, e instanceof Error ? e.message : e));
  };
  try {
    await stripe.subscriptions.update(sub.id, params);
  } catch (err) {
    await restore();
    throw err;
  }
  let charge: Extract<PlanChangeResult, { ok: true }>["charge"] = null;
  if (!trialing) {
    const out = await inspectProrationOutcome(stripe, sub.id, before);
    if (!out.ok) {
      await restore();
      if (out.reason === "unidentified") return { ok: false, status: 502, code: "stripe_error", portal: true, error: "Stripe didn't confirm the prorated charge, so the plan wasn't changed. Check the billing portal for an open invoice before trying again." };
      return { ok: false, status: 402, code: "payment_failed", portal: true, error: "The prorated charge for the new plan was declined, so the plan wasn't changed and the invoice was cancelled. Update your card in the billing portal and try again." };
    }
    if (out.invoice) charge = { invoiceId: out.invoice.id, amountPaid: out.invoice.amountPaid, currency: out.invoice.currency };
  }
  // Put the pending next phase back (mapped to the new plan / interval) if it differs from what is now active.
  if (next && !sameItems(nowMapped.items, nextMapped.items)) {
    const w = await writeNextPhase(stripe, sub.id, null, nextMapped.items, target.interval);
    if (!w.ok) console.error("[billing] plan changed but the pending add-on change could not be re-scheduled", sub.id, w.error);
  }
  return result("applied", kind, null, charge);
}

// ───────────────────────── schedule-safe cancel / resume ─────────────────────────

export type CancelResult =
  | { ok: true; action: "cancel_scheduled" | "resumed" | "unchanged"; cancelAt: number | null }
  | { ok: false; status: 409; error: string; code?: "unsupported"; support?: boolean };

const RESUME_KEY = "flowops_resume_next";
const RESUME_INTERVAL_KEY = "flowops_resume_interval";

/**
 * Cancel at the end of the current period (or the trial), or resume. Plain subscription: `cancel_at_period_end`.
 * With a schedule (Stripe refuses cancel_at_period_end on a schedule-managed subscription): the schedule ends after
 * the current phase with `end_behavior: "cancel"`, and the pending next phase (e.g. an add-on removal) is saved in
 * the schedule's metadata so resuming puts it back exactly.
 */
export async function setCancelAtPeriodEnd(stripe: PlanStripe, subscription: Pick<Stripe.Subscription, "id" | "status">, cancel: boolean): Promise<CancelResult> {
  if (!(PLAN_CHANGE_STATUSES as readonly string[]).includes(subscription.status) && cancel) return { ok: false, status: 409, error: "Only an active or trialing subscription can be cancelled here" };
  const sub = await stripe.subscriptions.retrieve(subscription.id);
  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  const schedule = scheduleId ? await stripe.subscriptionSchedules.retrieve(scheduleId) : null;
  const ph = schedulePhases(schedule);
  const periodEnd = sub.items.data[0]?.current_period_end ?? null;
  if (!schedule || !ph) {
    if (Boolean(sub.cancel_at_period_end) === cancel) return { ok: true, action: "unchanged", cancelAt: cancel ? (sub.cancel_at ?? periodEnd) : null };
    const upd = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: cancel });
    return { ok: true, action: cancel ? "cancel_scheduled" : "resumed", cancelAt: cancel ? (upd.cancel_at ?? periodEnd) : null };
  }
  if (ph.future.length > 1) return { ok: false, status: 409, code: "unsupported", support: true, error: "This subscription has several scheduled changes; contact support to cancel it" };
  if (hasUnsupportedPhaseSettings(ph.current) || ph.future.some(hasUnsupportedPhaseSettings)) return { ok: false, status: 409, code: "unsupported", support: true, error: "This subscription's schedule has discounts or extra invoice items; contact support to cancel it" };
  const cur = phaseItems(ph.current);
  const curParam = phaseParam(ph.current, cur);
  if (cancel) {
    if (schedule.end_behavior === "cancel" && !ph.future.length) return { ok: true, action: "unchanged", cancelAt: ph.current.end_date };
    const next = ph.future[0];
    const interval = (sub.items.data.find((i) => planByPriceId(i.price.id))?.price.recurring?.interval ?? "month") as BillingInterval;
    const metadata = next ? { ...(schedule.metadata ?? {}), [RESUME_KEY]: JSON.stringify(phaseItems(next)), [RESUME_INTERVAL_KEY]: interval } : (schedule.metadata ?? {});
    if ((metadata[RESUME_KEY] ?? "").length > 500) return { ok: false, status: 409, code: "unsupported", support: true, error: "This subscription has too many scheduled changes; contact support to cancel it" };
    await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: "cancel", proration_behavior: "none", phases: [curParam], metadata });
    return { ok: true, action: "cancel_scheduled", cancelAt: ph.current.end_date };
  }
  if (schedule.end_behavior !== "cancel") return { ok: true, action: "unchanged", cancelAt: null };
  const saved = schedule.metadata?.[RESUME_KEY];
  const savedInterval = (schedule.metadata?.[RESUME_INTERVAL_KEY] as BillingInterval | undefined) ?? "month";
  const items = saved ? (JSON.parse(saved) as PhaseItem[]) : null;
  if (!items || sameItems(items, cur)) {
    await stripe.subscriptionSchedules.release(schedule.id);
    return { ok: true, action: "resumed", cancelAt: null };
  }
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [curParam, nextPhaseParam(items, savedInterval)],
    metadata: { [RESUME_KEY]: "", [RESUME_INTERVAL_KEY]: "" },
  });
  return { ok: true, action: "resumed", cancelAt: null };
}

/** When a cancellation is pending (unix seconds), from the subscription and its schedule; null if none. */
export function pendingCancelAt(sub: Pick<Stripe.Subscription, "cancel_at_period_end" | "cancel_at" | "items">, schedule: Stripe.SubscriptionSchedule | null): number | null {
  if (sub.cancel_at) return sub.cancel_at;
  if (sub.cancel_at_period_end) return sub.items.data[0]?.current_period_end ?? null;
  const ph = schedulePhases(schedule);
  if (schedule && ph && schedule.end_behavior === "cancel") return (ph.future.length ? ph.future[ph.future.length - 1] : ph.current).end_date;
  return null;
}
