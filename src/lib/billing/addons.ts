/**
 * Add-on changes on an existing subscription (docs/BILLING.md §11). The Stripe client is injected
 * so this runs offline in tests; no "server-only" import for the same reason.
 *
 * Policy (team decision, 2026-10-27), always `proration_behavior: "none"` (no mid-cycle charge or credit):
 *   - Increase / new add-on: applied to the subscription immediately; first billed at the next renewal
 *     (so an add-on added mid-cycle is free until then: Brian to decide).
 *   - Decrease / removal: the add-on stays active until the current period ends, then drops at renewal.
 *     Done with a subscription schedule whose next phase holds the lower quantity. This also closes the
 *     "add, use, remove before renewal" loophole: whatever was active is billed at the next renewal.
 *   - A later change replaces a pending one (see `setAddonQuantity`).
 */
import type Stripe from "stripe";
import { addonByKey, addons } from "./config";
import { addonEffect, addonMaxQuantity, classifyItems, entitlementsFromItems, planLimits, type Entitlements } from "./entitlements";

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
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> };
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

export type AddonChangeResult =
  | {
      ok: true;
      /** created/updated: applied now (billed from the next renewal). scheduled: drops at renewal. schedule_cleared: a pending decrease was cancelled. */
      action: "created" | "updated" | "scheduled" | "schedule_cleared" | "unchanged";
      addon: string;
      /** The quantity asked for. */
      quantity: number;
      /** The quantity active right now (differs from `quantity` for a scheduled decrease). */
      currentQuantity: number;
      /** Unix seconds when a scheduled decrease takes effect (the renewal), else null. */
      effectiveAt: number | null;
      itemId: string | null;
      proration: "none";
    }
  | { ok: false; status: 400 | 404 | 409; error: string };

export interface ChangeAddonInput {
  stripe: AddonStripe;
  /** Live subscription id (from findLiveStripeSubscription). */
  subscription: Pick<Stripe.Subscription, "id" | "status">;
  addon: string;
  /** Target quantity (absolute, not a delta). 0 removes the add-on at the next renewal. */
  quantity: number;
  env?: Env;
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
export async function setAddonQuantity({ stripe, subscription, addon, quantity, env = process.env }: ChangeAddonInput): Promise<AddonChangeResult> {
  const cfg = addonByKey(addon, env);
  if (!cfg) return { ok: false, status: 400, error: "Unknown add-on" };
  const invalid = validateAddonQuantity(cfg.key, quantity, env);
  if (invalid) return invalid;
  if (!(ADDON_CHANGE_STATUSES as readonly string[]).includes(subscription.status))
    return { ok: false, status: 409, error: "Add-ons can only be changed on an active subscription. Fix the payment in the billing portal first." };

  const sub = await retrieveSubscriptionComplete(stripe, subscription.id);
  const items = sub.items.data;
  const classified = classifyItems(items.map((i) => ({ priceId: i.price?.id ?? null, quantity: i.quantity ?? 1 })), env);
  if (!classified.plan || !classified.plan.planKey) return { ok: false, status: 409, error: "This subscription is not on a configured plan, so add-ons can't be changed" };
  if (cfg.key === "branding" && planLimits(classified.plan.planKey, env).brandingRemoved) return { ok: false, status: 409, error: "Branding removal is already included in this plan" };

  const existing = items.find((i) => i.price?.id === cfg.priceId);
  const currentQty = existing?.quantity ?? 0;
  const proration = "none" as const;
  const done = (action: Extract<AddonChangeResult, { ok: true }>["action"], effectiveAt: number | null = null, itemId: string | null = existing?.id ?? null): AddonChangeResult => ({
    ok: true, action, addon: cfg.key, quantity, currentQuantity: action === "created" || action === "updated" ? quantity : currentQty, effectiveAt, itemId, proration,
  });

  // The subscription's schedule (ours, or one the portal made for a scheduled downgrade), if any.
  const scheduleId = sub.schedule ? priceIdOf(sub.schedule as string | { id: string }) : null;
  const schedule = scheduleId ? await stripe.subscriptionSchedules.retrieve(scheduleId) : null;
  const ph = schedulePhases(schedule);
  if (ph && ph.future.length > 1) return { ok: false, status: 409, error: "This subscription has several scheduled changes; use the billing portal to adjust add-ons" };
  const next = ph?.future[0] ?? null;
  if (ph && (hasUnsupportedPhaseSettings(ph.current) || (next && hasUnsupportedPhaseSettings(next))))
    return { ok: false, status: 409, error: "This subscription's schedule has discounts, trial or extra invoice items; use the billing portal to adjust add-ons" };

  // ── No next phase: plain increase = direct item write; decrease = start a schedule ──
  if (!next) {
    if (quantity === currentQty) return done("unchanged");
    if (quantity > currentQty) {
      if (!existing) {
        const created = await stripe.subscriptionItems.create({ subscription: sub.id, price: cfg.priceId, quantity, proration_behavior: proration });
        return done("created", null, created.id);
      }
      await stripe.subscriptionItems.update(existing.id, { quantity, proration_behavior: proration });
      return done("updated");
    }
    // decrease / removal: current phase unchanged, next phase holds the lower quantity for one billing period.
    const base = schedule ?? (await stripe.subscriptionSchedules.create({ from_subscription: sub.id }));
    const basePh = schedulePhases(base);
    if (!basePh) return { ok: false, status: 409, error: "Could not read the subscription schedule" };
    const curItems = phaseItems(basePh.current);
    const planPrice = items.find((i) => i.price?.id === classified.plan!.priceId)?.price;
    const rec = planPrice?.recurring;
    const nextPhase: PhaseParam = {
      items: withQuantity(curItems, cfg.priceId, quantity),
      duration: { interval: (rec?.interval ?? "month") as "day" | "week" | "month" | "year", interval_count: rec?.interval_count ?? 1 },
      proration_behavior: proration,
    };
    await stripe.subscriptionSchedules.update(base.id, { end_behavior: "release", proration_behavior: proration, phases: [phaseParam(basePh.current, curItems), nextPhase] });
    return done("scheduled", basePh.current.end_date);
  }

  // ── A next phase exists: edit both phases in ONE schedule update (a direct item write would not touch the next phase) ──
  const curItems = phaseItems(ph!.current);
  const nextItems = phaseItems(next);
  const pendingQty = nextItems.find((i) => i.price === cfg.priceId)?.quantity ?? 0;
  // Already exactly what is scheduled (or nothing is pending and nothing changes): no write.
  if (pendingQty === quantity && quantity <= currentQty) return done("unchanged", quantity < currentQty ? ph!.current.end_date : null);
  const newCur = quantity > currentQty ? withQuantity(curItems, cfg.priceId, quantity) : curItems;
  const newNext = withQuantity(nextItems, cfg.priceId, quantity);
  await stripe.subscriptionSchedules.update(schedule!.id, {
    end_behavior: "release",
    proration_behavior: proration,
    phases: [phaseParam(ph!.current, newCur), phaseParam(next, newNext)],
  });
  const increased = quantity > currentQty;
  // Nothing differs any more between the two phases (a pending decrease was cancelled or replaced by an increase): drop the schedule.
  // A portal-made plan downgrade keeps the phases different, so that schedule stays.
  const cleared = sameItems(newCur, newNext);
  if (cleared) await stripe.subscriptionSchedules.release(schedule!.id);
  if (increased) return done(existing ? "updated" : "created", null, existing?.id ?? null);
  return cleared || quantity === currentQty ? done("schedule_cleared") : done("scheduled", ph!.current.end_date);
}

/** Add-ons currently configured, for UI/GET: key + price id + the most one subscription may hold (no amounts: those live in Stripe). */
export function configuredAddons(env: Env = process.env) {
  return addons(env).map((a) => ({ key: a.key, priceId: a.priceId, known: addonEffect(a.key) !== null, max: addonMaxQuantity(a.key, env) }));
}

