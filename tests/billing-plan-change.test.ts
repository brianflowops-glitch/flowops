import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { initTestDb } from "./helpers/db";
import { memberOf, moveToOrg, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import * as planRoute from "@/app/api/billing/plan/route";
import * as cancelRoute from "@/app/api/billing/cancel/route";
import * as checkoutLib from "@/lib/billing/checkout";
import * as stripeLib from "@/lib/billing/stripe";
import * as planLib from "@/lib/billing/plan-change";
import * as chargesDb from "@/lib/billing/addon-charges-db";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { changePlanUnderPolicy, classifyPlanChange, itemsForPlan, setCancelAtPeriodEnd, UPGRADE_POLICY, type PlanStripe } from "@/lib/billing/plan-change";
import { packDisputeState, packRevocation } from "@/lib/billing/text-pack-rules";
import StripeSdk from "stripe";
import { isStripeResourceMissing, stripeChargeContextFetcher, type ClawbackStripe } from "@/lib/billing/clawback";

const ENV = {
  STRIPE_PRICE_STARTER: "p_starter_m",
  STRIPE_PRICE_STARTER_ANNUAL: "p_starter_y",
  STRIPE_PRICE_PRO: "p_pro_m",
  STRIPE_PRICE_PRO_ANNUAL: "p_pro_y",
  STRIPE_PRICE_BUSINESS: "p_biz_m",
  STRIPE_PRICE_BUSINESS_ANNUAL: "p_biz_y",
  STRIPE_ADDON_PRICE_SEAT: "p_seat_m",
  STRIPE_ADDON_PRICE_SEAT_ANNUAL: "p_seat_y",
  STRIPE_ADDON_PRICE_LOCATION: "p_loc_m",
  STRIPE_ADDON_PRICE_LOCATION_ANNUAL: "p_loc_y",
  STRIPE_ADDON_PRICE_BRANDING: "p_brand_m",
};
const PERIOD_END = 1_900_000_000;
const PERIOD_START = PERIOD_END - 30 * 86400;

/** In-memory Stripe: one subscription, optional schedule. Records every write. */
function fakeStripe(o: { items: [string, number][]; status?: string; trialEnd?: number; schedule?: { next: [string, number][]; endBehavior?: "release" | "cancel"; metadata?: Record<string, string>; nextMetadata?: Record<string, string> } | null; decline?: boolean }) {
  const calls: { op: string; id?: string; params?: unknown }[] = [];
  let seq = 0;
  const sub = {
    id: "sub_1", object: "subscription", customer: "cus_1", status: o.status ?? "active", trial_end: o.trialEnd ?? null, cancel_at_period_end: false, cancel_at: null,
    latest_invoice: "in_0", schedule: null as string | null, pending_update: null as unknown,
    items: { has_more: false, data: o.items.map(([price, q], i) => ({ id: `si_${i}`, price: { id: price, recurring: { interval: price.endsWith("_y") ? "year" : "month" }, unit_amount: 1000 }, quantity: q, current_period_end: PERIOD_END })) },
  };
  let schedule: Stripe.SubscriptionSchedule | null = null;
  const mkSchedule = (phases: { items: [string, number][] | { price: string; quantity: number }[]; start: number; end: number; trial_end?: number | null; metadata?: Record<string, string> }[], endBehavior: string, metadata: Record<string, string> = {}) => {
    schedule = {
      id: "sub_sched_1", object: "subscription_schedule", status: "active", end_behavior: endBehavior, metadata,
      current_phase: { start_date: phases[0].start, end_date: phases[0].end },
      phases: phases.map((p) => ({ start_date: p.start, end_date: p.end, items: (p.items as unknown[]).map((x) => (Array.isArray(x) ? { price: x[0], quantity: x[1] } : x)), trial_end: p.trial_end ?? null, metadata: p.metadata ?? {}, discounts: [], add_invoice_items: [] })),
    } as unknown as Stripe.SubscriptionSchedule;
    sub.schedule = schedule.id;
  };
  const curItems = () => sub.items.data.map((i) => [i.price.id, i.quantity] as [string, number]);
  if (o.schedule) mkSchedule([{ items: curItems(), start: PERIOD_START, end: PERIOD_END, trial_end: o.trialEnd ?? null }, { items: o.schedule.next, start: PERIOD_END, end: PERIOD_END + 30 * 86400, metadata: o.schedule.nextMetadata }], o.schedule.endBehavior ?? "release", o.schedule.metadata);
  const invoices = new Map<string, Stripe.Invoice>();
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        const s = structuredClone(sub) as unknown as Stripe.Subscription & { latest_invoice: unknown };
        if (typeof sub.latest_invoice === "string" && invoices.has(sub.latest_invoice)) s.latest_invoice = invoices.get(sub.latest_invoice)!;
        void id;
        return s;
      },
      update: async (id: string, params: Stripe.SubscriptionUpdateParams) => {
        calls.push({ op: "subscriptions.update", id, params });
        if (params.cancel_at_period_end !== undefined) sub.cancel_at_period_end = params.cancel_at_period_end;
        if (params.items) {
          const apply = () => {
            for (const it of params.items!) {
              const idx = sub.items.data.findIndex((x) => x.id === it.id);
              if (it.deleted) sub.items.data.splice(idx, 1);
              else sub.items.data[idx] = { ...sub.items.data[idx], price: { ...sub.items.data[idx].price, id: it.price!, recurring: { interval: it.price!.endsWith("_y") ? "year" : "month" } }, quantity: it.quantity ?? sub.items.data[idx].quantity };
            }
          };
          if (params.proration_behavior === "always_invoice") {
            const inv = { id: `in_${++seq}`, object: "invoice", billing_reason: "subscription_update", status: o.decline ? "open" : "paid", amount_paid: o.decline ? 0 : 4321, currency: "usd", parent: { subscription_details: { subscription: sub.id } }, lines: { data: [] } } as unknown as Stripe.Invoice;
            invoices.set(inv.id!, inv);
            sub.latest_invoice = inv.id!;
            if (o.decline) sub.pending_update = { subscription_items: params.items };
            else apply();
          } else apply();
        }
        return structuredClone(sub) as unknown as Stripe.Subscription;
      },
    },
    subscriptionItems: { list: () => ({ autoPagingToArray: async () => sub.items.data }), create: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); } },
    subscriptionSchedules: {
      retrieve: async () => structuredClone(schedule!),
      create: async (p: Stripe.SubscriptionScheduleCreateParams) => {
        calls.push({ op: "schedules.create", params: p });
        mkSchedule([{ items: curItems(), start: PERIOD_START, end: PERIOD_END, trial_end: sub.trial_end }], "release");
        return structuredClone(schedule!);
      },
      update: async (id: string, p: Stripe.SubscriptionScheduleUpdateParams) => {
        calls.push({ op: "schedules.update", id, params: p });
        const phases = p.phases!.map((ph, i) => ({ items: ph.items as { price: string; quantity: number }[], start: i === 0 ? (ph.start_date as number) : PERIOD_END, end: i === 0 ? (ph.end_date as number) : PERIOD_END + (ph.duration?.interval === "year" ? 365 : 30) * 86400, trial_end: (ph.trial_end as number) ?? null, metadata: (ph.metadata as Record<string, string>) ?? {} }));
        const md = { ...(schedule!.metadata ?? {}), ...((p.metadata as Record<string, string>) ?? {}) };
        for (const k of Object.keys(md)) if (md[k] === "") delete md[k];
        mkSchedule(phases, p.end_behavior ?? schedule!.end_behavior, md);
        return structuredClone(schedule!);
      },
      release: async (id: string) => {
        calls.push({ op: "schedules.release", id });
        schedule = null;
        sub.schedule = null;
        return {} as Stripe.SubscriptionSchedule;
      },
    },
    invoices: {
      retrieve: async (id: string) => invoices.get(id)!,
      voidInvoice: async (id: string) => {
        calls.push({ op: "invoices.void", id });
        invoices.get(id)!.status = "void";
        sub.pending_update = null;
        return invoices.get(id)!;
      },
      del: async () => ({}),
    },
  };
  return { stripe: stripe as unknown as PlanStripe, calls, sub, get schedule() { return schedule; }, curItems };
}
const items = (s: Stripe.SubscriptionSchedule | null, i: number) => s?.phases[i]?.items.map((x) => [x.price, x.quantity]);
const run = (f: ReturnType<typeof fakeStripe>, plan: string, interval: "month" | "year", policy: "at_renewal" | "prorate_now" = "prorate_now") =>
  changePlanUnderPolicy(policy, { stripe: f.stripe, subscription: { id: "sub_1", status: f.sub.status as Stripe.Subscription.Status }, plan, interval, env: ENV });

describe("plan change: policy and classification", () => {
  it("UPGRADE_POLICY default is prorate_now (Brian, 2026-10-30)", () => {
    expect(UPGRADE_POLICY).toBe("prorate_now");
  });
  it("classifies tiers and intervals: monthly→annual is an upgrade, annual→monthly and lower tiers are downgrades", () => {
    const c = (a: string, ai: "month" | "year", b: string, bi: "month" | "year") => classifyPlanChange({ key: a, interval: ai }, { key: b, interval: bi });
    expect(c("starter", "month", "pro", "month")).toBe("upgrade");
    expect(c("pro", "month", "pro", "year")).toBe("upgrade");
    expect(c("starter", "month", "business", "year")).toBe("upgrade");
    expect(c("pro", "year", "pro", "month")).toBe("downgrade");
    expect(c("starter", "year", "business", "month")).toBe("downgrade");
    expect(c("business", "month", "pro", "year")).toBe("downgrade");
    expect(c("pro", "month", "starter", "month")).toBe("downgrade");
    expect(c("pro", "month", "pro", "month")).toBe("none");
    expect(classifyPlanChange({ key: "x", interval: "month", monthlyAmount: 10 }, { key: "y", interval: "month", monthlyAmount: 20 })).toBe("upgrade");
  });
  it("itemsForPlan maps add-ons to the target interval, refuses unmappable items", () => {
    expect(itemsForPlan([{ price: "p_pro_m", quantity: 1 }, { price: "p_seat_m", quantity: 3 }, { price: "p_loc_m", quantity: 1 }], "p_biz_y", "year", ENV)).toEqual({ ok: true, items: [{ price: "p_biz_y", quantity: 1 }, { price: "p_seat_y", quantity: 3 }, { price: "p_loc_y", quantity: 1 }] });
    expect(itemsForPlan([{ price: "p_pro_m", quantity: 1 }, { price: "p_brand_m", quantity: 1 }], "p_pro_y", "year", ENV).ok).toBe(false); // no annual branding price
    expect(itemsForPlan([{ price: "p_pro_m", quantity: 1 }, { price: "p_unknown", quantity: 1 }], "p_biz_m", "month", ENV).ok).toBe(false);
  });
});

describe("plan change: prorate_now (default)", () => {
  it("upgrade on an active plan-only subscription: always_invoice + pending_if_incomplete, applied, charge returned", async () => {
    const f = fakeStripe({ items: [["p_starter_m", 1]] });
    const r = await run(f, "pro", "month");
    expect(r).toMatchObject({ ok: true, action: "applied", kind: "upgrade", proration: "always_invoice", charge: { amountPaid: 4321 } });
    const u = f.calls.find((c) => c.op === "subscriptions.update")!.params as Stripe.SubscriptionUpdateParams;
    expect(u).toMatchObject({ proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", items: [{ id: "si_0", price: "p_pro_m", quantity: 1 }] });
    expect(f.curItems()).toEqual([["p_pro_m", 1]]);
  });
  it("monthly → annual with add-ons: every add-on switches to its annual price in the same charged update", async () => {
    const f = fakeStripe({ items: [["p_pro_m", 1], ["p_seat_m", 2], ["p_loc_m", 1]] });
    const r = await run(f, "pro", "year");
    expect(r).toMatchObject({ ok: true, action: "applied", kind: "upgrade" });
    expect(f.curItems()).toEqual([["p_pro_y", 1], ["p_seat_y", 2], ["p_loc_y", 1]]);
  });
  it("declined proration → invoice voided, nothing changed, 402", async () => {
    const f = fakeStripe({ items: [["p_starter_m", 1], ["p_seat_m", 1]], decline: true });
    const r = await run(f, "business", "month");
    expect(r).toMatchObject({ ok: false, status: 402, code: "payment_failed" });
    expect(f.calls.some((c) => c.op === "invoices.void")).toBe(true);
    expect(f.curItems()).toEqual([["p_starter_m", 1], ["p_seat_m", 1]]);
  });
  it("upgrade with an attached schedule (pending seat removal): schedule released, charged, the removal re-scheduled on the new plan", async () => {
    const f = fakeStripe({ items: [["p_starter_m", 1], ["p_seat_m", 3]], schedule: { next: [["p_starter_m", 1], ["p_seat_m", 1]] } });
    const r = await run(f, "pro", "month");
    expect(r).toMatchObject({ ok: true, action: "applied" });
    expect(f.curItems()).toEqual([["p_pro_m", 1], ["p_seat_m", 3]]);
    expect(items(f.schedule, 1)).toEqual([["p_pro_m", 1], ["p_seat_m", 1]]);
    expect(f.schedule!.end_behavior).toBe("release");
  });
  it("declined upgrade with a schedule: the original pending removal is put back", async () => {
    const f = fakeStripe({ items: [["p_starter_m", 1], ["p_seat_m", 3]], schedule: { next: [["p_starter_m", 1], ["p_seat_m", 1]] }, decline: true });
    const r = await run(f, "pro", "month");
    expect(r).toMatchObject({ ok: false, status: 402 });
    expect(f.curItems()).toEqual([["p_starter_m", 1], ["p_seat_m", 3]]);
    expect(items(f.schedule, 1)).toEqual([["p_starter_m", 1], ["p_seat_m", 1]]);
  });
  it("the released schedule's next-phase metadata is kept: restored after a decline, and re-created after success", async () => {
    const md = { flowops_addon_change: "seat:3->1", flowops_by: "user_1" };
    const declined = fakeStripe({ items: [["p_starter_m", 1], ["p_seat_m", 3]], schedule: { next: [["p_starter_m", 1], ["p_seat_m", 1]], nextMetadata: md }, decline: true });
    expect(await run(declined, "pro", "month")).toMatchObject({ ok: false, status: 402 });
    expect(items(declined.schedule, 1)).toEqual([["p_starter_m", 1], ["p_seat_m", 1]]);
    expect(declined.schedule!.phases[1].metadata).toEqual(md);
    const restoreCall = declined.calls.filter((c) => c.op === "schedules.update").at(-1)!.params as Stripe.SubscriptionScheduleUpdateParams;
    expect(restoreCall.phases![1].metadata).toEqual(md);
    const ok = fakeStripe({ items: [["p_starter_m", 1], ["p_seat_m", 3]], schedule: { next: [["p_starter_m", 1], ["p_seat_m", 1]], nextMetadata: md } });
    expect(await run(ok, "pro", "month")).toMatchObject({ ok: true, action: "applied" });
    expect(items(ok.schedule, 1)).toEqual([["p_pro_m", 1], ["p_seat_m", 1]]);
    expect(ok.schedule!.phases[1].metadata).toEqual(md);
  });
  it("downgrade is scheduled for the renewal (next phase), nothing charged; existing pending removal kept", async () => {
    const f = fakeStripe({ items: [["p_biz_m", 1], ["p_seat_m", 3]], schedule: { next: [["p_biz_m", 1], ["p_seat_m", 1]] } });
    const r = await run(f, "starter", "month");
    expect(r).toMatchObject({ ok: true, action: "scheduled", kind: "downgrade", effectiveAt: PERIOD_END, proration: "none", charge: null });
    expect(f.calls.some((c) => c.op === "subscriptions.update")).toBe(false);
    expect(items(f.schedule, 0)).toEqual([["p_biz_m", 1], ["p_seat_m", 3]]);
    expect(items(f.schedule, 1)).toEqual([["p_starter_m", 1], ["p_seat_m", 1]]);
  });
  it("annual → monthly waits for the renewal; add-ons move to monthly prices in the next phase (duration 1 month)", async () => {
    const f = fakeStripe({ items: [["p_pro_y", 1], ["p_seat_y", 2]] });
    const r = await run(f, "pro", "month");
    expect(r).toMatchObject({ ok: true, action: "scheduled", kind: "downgrade" });
    const upd = f.calls.find((c) => c.op === "schedules.update")!.params as Stripe.SubscriptionScheduleUpdateParams;
    expect(upd.phases![1]).toMatchObject({ items: [{ price: "p_pro_m", quantity: 1 }, { price: "p_seat_m", quantity: 2 }], duration: { interval: "month", interval_count: 1 }, proration_behavior: "none" });
    expect(upd.end_behavior).toBe("release");
  });
  it("choosing the current plan again cancels a pending plan change but keeps a pending add-on removal", async () => {
    const f = fakeStripe({ items: [["p_pro_m", 1], ["p_seat_m", 3]], schedule: { next: [["p_starter_m", 1], ["p_seat_m", 1]] } });
    const r = await run(f, "pro", "month");
    expect(r).toMatchObject({ ok: true, action: "pending_cleared" });
    expect(items(f.schedule, 1)).toEqual([["p_pro_m", 1], ["p_seat_m", 1]]);
    const g = fakeStripe({ items: [["p_pro_m", 1]], schedule: { next: [["p_starter_m", 1]] } });
    expect(await run(g, "pro", "month")).toMatchObject({ ok: true, action: "pending_cleared", effectiveAt: null });
    expect(g.schedule).toBeNull();
  });
  it("trial upgrade (incl. monthly → annual): applied now, no charge, trial_end kept", async () => {
    const trialEnd = PERIOD_END;
    const f = fakeStripe({ items: [["p_starter_m", 1], ["p_seat_m", 1]], status: "trialing", trialEnd });
    const r = await run(f, "business", "year");
    expect(r).toMatchObject({ ok: true, action: "applied", proration: "none", charge: null, trialEnd });
    const u = f.calls.find((c) => c.op === "subscriptions.update")!.params as Stripe.SubscriptionUpdateParams;
    expect(u.proration_behavior).toBe("none");
    expect(u.payment_behavior).toBeUndefined();
    expect(u.trial_end).toBe(trialEnd);
    expect(f.curItems()).toEqual([["p_biz_y", 1], ["p_seat_y", 1]]);
  });
  it("trial downgrade waits for the trial end (the next phase keeps the current phase's trial_end)", async () => {
    const f = fakeStripe({ items: [["p_pro_m", 1]], status: "trialing", trialEnd: PERIOD_END });
    const r = await run(f, "starter", "month");
    expect(r).toMatchObject({ ok: true, action: "scheduled", effectiveAt: PERIOD_END });
    const upd = f.calls.find((c) => c.op === "schedules.update")!.params as Stripe.SubscriptionScheduleUpdateParams;
    expect(upd.phases![0].trial_end).toBe(PERIOD_END);
  });
  it("refusals before any write: unknown plan/interval (400), past_due (409), pending cancel (409), unmappable add-on (409 + support)", async () => {
    const f = fakeStripe({ items: [["p_pro_m", 1], ["p_brand_m", 1]] });
    expect(await run(f, "enterprise", "month")).toMatchObject({ ok: false, status: 400 });
    expect(await run(f, "pro", "year")).toMatchObject({ ok: false, status: 409, support: true });
    const pd = fakeStripe({ items: [["p_pro_m", 1]], status: "past_due" });
    expect(await run(pd, "business", "month")).toMatchObject({ ok: false, status: 409 });
    const cx = fakeStripe({ items: [["p_pro_m", 1]], schedule: { next: [["p_pro_m", 1]], endBehavior: "cancel" } });
    expect(await run(cx, "business", "month")).toMatchObject({ ok: false, status: 409, code: "cancel_pending" });
    expect([...f.calls, ...pd.calls, ...cx.calls].filter((c) => c.op !== "schedules.retrieve")).toEqual([]);
  });
});

describe("plan change: at_renewal (kept, not the default)", () => {
  it("upgrade is scheduled for the renewal, nothing charged now", async () => {
    const f = fakeStripe({ items: [["p_starter_m", 1], ["p_seat_m", 2]] });
    const r = await run(f, "pro", "year", "at_renewal");
    expect(r).toMatchObject({ ok: true, action: "scheduled", kind: "upgrade", proration: "none", charge: null });
    expect(f.calls.some((c) => c.op === "subscriptions.update")).toBe(false);
    expect(items(f.schedule, 1)).toEqual([["p_pro_y", 1], ["p_seat_y", 2]]);
  });
  it("a trial upgrade is still applied now for free (trials are never charged under either policy)", async () => {
    const f = fakeStripe({ items: [["p_starter_m", 1]], status: "trialing", trialEnd: PERIOD_END });
    expect(await run(f, "pro", "month", "at_renewal")).toMatchObject({ ok: true, action: "applied", proration: "none" });
  });
});

describe("schedule-safe cancel / resume", () => {
  it("plain subscription: cancel_at_period_end true / false", async () => {
    const f = fakeStripe({ items: [["p_pro_m", 1]] });
    expect(await setCancelAtPeriodEnd(f.stripe, { id: "sub_1", status: "active" }, true)).toMatchObject({ ok: true, action: "cancel_scheduled", cancelAt: PERIOD_END });
    expect(f.sub.cancel_at_period_end).toBe(true);
    expect(await setCancelAtPeriodEnd(f.stripe, { id: "sub_1", status: "active" }, false)).toMatchObject({ ok: true, action: "resumed" });
    expect(f.sub.cancel_at_period_end).toBe(false);
  });
  it("with a pending removal: schedule ends with end_behavior cancel; resume restores the exact pending phase", async () => {
    const f = fakeStripe({ items: [["p_pro_m", 1], ["p_seat_m", 3]], schedule: { next: [["p_pro_m", 1], ["p_seat_m", 1]] } });
    const c = await setCancelAtPeriodEnd(f.stripe, { id: "sub_1", status: "active" }, true);
    expect(c).toMatchObject({ ok: true, action: "cancel_scheduled", cancelAt: PERIOD_END });
    expect(f.schedule!.end_behavior).toBe("cancel");
    expect(f.schedule!.phases).toHaveLength(1);
    expect(f.calls.some((x) => x.op === "subscriptions.update")).toBe(false); // never cancel_at_period_end on a scheduled sub
    expect(planLib.pendingCancelAt(f.sub as unknown as Stripe.Subscription, f.schedule)).toBe(PERIOD_END);
    const r = await setCancelAtPeriodEnd(f.stripe, { id: "sub_1", status: "active" }, false);
    expect(r).toMatchObject({ ok: true, action: "resumed" });
    expect(f.schedule!.end_behavior).toBe("release");
    expect(items(f.schedule, 1)).toEqual([["p_pro_m", 1], ["p_seat_m", 1]]);
    expect(f.schedule!.metadata).toEqual({});
  });
  it("cancel twice is a no-op", async () => {
    const f = fakeStripe({ items: [["p_pro_m", 1]], schedule: { next: [["p_pro_m", 1], ["p_seat_m", 1]] } });
    await setCancelAtPeriodEnd(f.stripe, { id: "sub_1", status: "active" }, true);
    const n = f.calls.length;
    expect(await setCancelAtPeriodEnd(f.stripe, { id: "sub_1", status: "active" }, true)).toMatchObject({ action: "unchanged" });
    expect(f.calls.length).toBe(n);
  });
});

describe("text-pack clawback rules (pure)", () => {
  const base = { total: 1000, used: 0, revokedBefore: 0, chargeAmount: 1500, amountRefunded: 0, fullyRefunded: false, dispute: "none" as const, expired: false };
  it("partial refunds are floor(total × cumulative fraction), never more than total − used", () => {
    expect(packRevocation({ ...base, amountRefunded: 500 }).revoked).toBe(333);
    expect(packRevocation({ ...base, amountRefunded: 1000, used: 900 })).toMatchObject({ revoked: 100, target: 666, usedOverRevocation: 566, reason: "partial_refund" });
    expect(packRevocation({ ...base, amountRefunded: 1500, fullyRefunded: true, used: 10 })).toMatchObject({ revoked: 990, reason: "refund" });
  });
  it("disputes: open/lost revoke all remaining; won restores unless expired; inquiries revoke nothing", () => {
    expect(packRevocation({ ...base, dispute: "open", used: 200 })).toMatchObject({ revoked: 800, reason: "dispute" });
    expect(packRevocation({ ...base, dispute: "lost", revokedBefore: 800, used: 200 })).toMatchObject({ revoked: 800, reason: "dispute_lost" });
    expect(packRevocation({ ...base, dispute: "won", revokedBefore: 800, used: 200 })).toMatchObject({ revoked: 0, reason: "restored_dispute_won" });
    expect(packRevocation({ ...base, dispute: "won", revokedBefore: 800, used: 200, expired: true }).revoked).toBe(800);
    expect(packRevocation({ ...base, dispute: "inquiry" }).revoked).toBe(0);
    expect(packDisputeState(["won", "needs_response"])).toBe("open");
    expect(packDisputeState(["warning_closed"])).toBe("inquiry");
    expect(packDisputeState(["lost"])).toBe("lost");
    expect(packDisputeState([])).toBe("none");
  });
  it("idempotent: re-applying the same state yields the same result", () => {
    const a = packRevocation({ ...base, amountRefunded: 750, used: 100 });
    expect(packRevocation({ ...base, amountRefunded: 750, used: 100, revokedBefore: a.revoked }).revoked).toBe(a.revoked);
  });
});

describe("clawback: Stripe 404 on the charge / invoice lookup", () => {
  const missing = () => new StripeSdk.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_missing", message: "No such charge", statusCode: 404 } as never);
  it("recognises Stripe's resource_missing / 404 errors, and nothing else", () => {
    expect(isStripeResourceMissing(missing())).toBe(true);
    expect(isStripeResourceMissing(Object.assign(new Error("x"), { statusCode: 404 }))).toBe(true);
    expect(isStripeResourceMissing(new StripeSdk.errors.StripeAPIError({ type: "api_error", message: "down", statusCode: 500 } as never))).toBe(false);
    expect(isStripeResourceMissing(new Error("network"))).toBe(false);
    expect(isStripeResourceMissing(null)).toBe(false);
  });
  it("the real fetcher surfaces a 404 from the charge or the invoice-payments lookup (the webhook then ignores it)", async () => {
    const charge = { id: "ch_1", amount: 1500, amount_refunded: 0, refunded: false, disputed: false, payment_intent: "pi_1" };
    const s1 = { charges: { retrieve: async () => { throw missing(); } }, invoicePayments: { list: async () => ({ data: [] }) }, disputes: { list: async () => ({ data: [] }) } } as unknown as ClawbackStripe;
    await expect(stripeChargeContextFetcher(s1)("ch_1")).rejects.toSatisfy(isStripeResourceMissing);
    const s2 = { charges: { retrieve: async () => charge }, invoicePayments: { list: async () => { throw missing(); } }, disputes: { list: async () => ({ data: [] }) } } as unknown as ClawbackStripe;
    await expect(stripeChargeContextFetcher(s2)("ch_1")).rejects.toSatisfy(isStripeResourceMissing);
  });
});

// Route guards for /api/billing/plan and /api/billing/cancel (Stripe and the library are mocked).
describe("POST/GET /api/billing/plan and POST /api/billing/cancel", () => {
  let owner: TestUser, admin: TestUser, staffer: TestUser, demoUser: TestUser;
  const spies: { mockRestore(): void }[] = [];
  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    // The first sign-up in a fresh database claims the seeded demo org (is_demo); it is the demo-org user here.
    demoUser = await signUp("demo@plan.test", { businessName: "Demo user co" });
    owner = await signUp("owner@plan.test", { businessName: "Plan Co" });
    const orgId = (await memberOf(owner.id)).organizationId;
    admin = await signUp("admin@plan.test");
    staffer = await signUp("staff@plan.test");
    await moveToOrg(admin.id, orgId, "admin");
    await moveToOrg(staffer.id, orgId, "staff");
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });
  afterAll(() => vi.unstubAllEnvs());
  const post = (u: TestUser | null, body: unknown = { plan: "pro", interval: "month" }) => planRoute.POST(req("/api/billing/plan", { method: "POST", body, cookie: u?.cookie }));
  const cancel = (u: TestUser | null, body: unknown = { cancel: true }) => cancelRoute.POST(req("/api/billing/cancel", { method: "POST", body, cookie: u?.cookie }));
  const live = (status = "active") => spies.push(vi.spyOn(checkoutLib, "findCustomerId").mockResolvedValue("cus_x"), vi.spyOn(checkoutLib, "findLiveStripeSubscription").mockResolvedValue({ id: "sub_x", status, items: { data: [] } } as never), vi.spyOn(stripeLib, "getStripe").mockReturnValue({} as never));

  it("404 while BILLING_ENABLED is off", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    expect((await post(owner)).status).toBe(404);
    expect((await cancel(owner)).status).toBe(404);
    expect((await planRoute.GET(req("/api/billing/plan", { cookie: owner.cookie }))).status).toBe(404);
  });

  describe("billing on", () => {
    beforeAll(() => {
      vi.stubEnv("BILLING_ENABLED", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
    });
    it("401 / 403 staff / 400 bad body, before any Stripe call", async () => {
      const ch = vi.spyOn(planLib, "changePlan");
      spies.push(ch);
      expect((await post(null)).status).toBe(401);
      expect((await post(staffer)).status).toBe(403);
      expect((await cancel(staffer)).status).toBe(403);
      for (const body of [{}, { plan: "pro" }, { plan: "pro", interval: "week" }, { plan: "", interval: "month" }]) expect((await post(owner, body)).status).toBe(400);
      expect((await cancel(owner, { cancel: "yes" })).status).toBe(400);
      expect(ch).not.toHaveBeenCalled();
    });
    it("403 demo_org for the demo organization (plan and cancel)", async () => {
      const [org] = await getDb().select().from(schema.organization).where(eq(schema.organization.id, (await memberOf(demoUser.id)).organizationId));
      expect(org.isDemo).toBe(true);
      const ch = vi.spyOn(planLib, "changePlan");
      spies.push(ch);
      const r = await post(demoUser);
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe("demo_org");
      expect((await cancel(demoUser)).status).toBe(403);
      expect(ch).not.toHaveBeenCalled();
    });
    it("409 without a subscription", async () => {
      spies.push(vi.spyOn(checkoutLib, "findCustomerId").mockResolvedValue("cus_x"), vi.spyOn(checkoutLib, "findLiveStripeSubscription").mockResolvedValue(null as never));
      expect((await post(owner)).status).toBe(409);
      expect((await cancel(admin)).status).toBe(409);
    });

    // Read paths must never create a Stripe customer or a billing_customer row (the demo org is off-limits, and an
    // admin opening the page must not make a customer for an org that never subscribed).
    const customerRows = async () => (await getDb().select().from(schema.billingCustomer)).length;
    const stripeSpies = () => {
      const create = vi.fn(async () => ({ id: "cus_should_not_exist" }));
      const gs = vi.spyOn(stripeLib, "getStripe").mockReturnValue({ customers: { create }, subscriptions: { list: vi.fn(async () => ({ data: [] })) }, subscriptionSchedules: { retrieve: vi.fn() } } as never);
      const occ = vi.spyOn(checkoutLib, "getOrCreateCustomer");
      const fl = vi.spyOn(checkoutLib, "findLiveStripeSubscription");
      spies.push(gs, occ, fl);
      return { create, gs, occ, fl };
    };
    it("GET for the demo org: subscription null, no Stripe call, no billing_customer row written", async () => {
      const before = await customerRows();
      const sp = stripeSpies();
      const res = await planRoute.GET(req("/api/billing/plan", { cookie: demoUser.cookie }));
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.subscription).toBeNull();
      expect(j.demo).toBe(true);
      expect(sp.gs).not.toHaveBeenCalled();
      expect(sp.create).not.toHaveBeenCalled();
      expect(sp.occ).not.toHaveBeenCalled();
      expect(sp.fl).not.toHaveBeenCalled();
      const demoOrg = (await memberOf(demoUser.id)).organizationId;
      expect(await getDb().select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, demoOrg))).toHaveLength(0);
      expect(await customerRows()).toBe(before);
    });
    it("GET / POST / cancel for an org that never subscribed: no customer created, no row, no Stripe call", async () => {
      const orgId = (await memberOf(owner.id)).organizationId;
      expect(await getDb().select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, orgId))).toHaveLength(0);
      const before = await customerRows();
      const sp = stripeSpies();
      const res = await planRoute.GET(req("/api/billing/plan", { cookie: admin.cookie }));
      expect(res.status).toBe(200);
      expect((await res.json()).subscription).toBeNull();
      expect((await post(owner)).status).toBe(409);
      expect((await cancel(owner)).status).toBe(409);
      expect(sp.gs).not.toHaveBeenCalled();
      expect(sp.create).not.toHaveBeenCalled();
      expect(sp.occ).not.toHaveBeenCalled();
      expect(sp.fl).not.toHaveBeenCalled();
      expect(await getDb().select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, orgId))).toHaveLength(0);
      expect(await customerRows()).toBe(before);
    });
    it("GET with an existing billing_customer row: looks up that customer's subscription (no create)", async () => {
      const orgId = (await memberOf(owner.id)).organizationId;
      await getDb().insert(schema.billingCustomer).values({ organizationId: orgId, stripeCustomerId: "cus_existing" });
      try {
        const sp = stripeSpies();
        sp.fl.mockResolvedValue(null as never);
        const j = await (await planRoute.GET(req("/api/billing/plan", { cookie: owner.cookie }))).json();
        expect(j.subscription).toBeNull();
        expect(sp.fl).toHaveBeenCalledWith("cus_existing");
        expect(sp.occ).not.toHaveBeenCalled();
        expect(sp.create).not.toHaveBeenCalled();
      } finally {
        await getDb().delete(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, orgId));
      }
    });
    it("runs inside the org's billing lock; busy → 409 change_in_progress, nothing changed", async () => {
      live();
      const ch = vi.spyOn(planLib, "changePlan").mockResolvedValue({ ok: true, action: "applied", kind: "upgrade", plan: "pro", interval: "month", effectiveAt: null, proration: "always_invoice", charge: { invoiceId: "in_1", amountPaid: 1234, currency: "usd" }, trialEnd: null });
      const lock = vi.spyOn(chargesDb, "withAddonChangeLock");
      spies.push(ch, lock);
      let res = await post(owner);
      expect(res.status).toBe(200);
      expect((await res.json()).billing).toContain("Charged 12.34 USD now, prorated");
      expect(lock).toHaveBeenCalledTimes(1);
      lock.mockRejectedValueOnce(new chargesDb.AddonChangeBusy());
      res = await post(admin);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("change_in_progress");
      lock.mockRejectedValueOnce(new chargesDb.AddonChangeBusy());
      res = await cancel(owner);
      expect(res.status).toBe(409);
      expect(ch).toHaveBeenCalledTimes(1);
    });
    it("scheduled / trial / unsupported answers are explained; unsupported points at support", async () => {
      live();
      const ch = vi.spyOn(planLib, "changePlan");
      spies.push(ch);
      ch.mockResolvedValueOnce({ ok: true, action: "scheduled", kind: "downgrade", plan: "starter", interval: "month", effectiveAt: PERIOD_END, proration: "none", charge: null, trialEnd: null });
      let j = await (await post(owner, { plan: "starter", interval: "month" })).json();
      expect(j.billing).toContain("at the next renewal");
      ch.mockResolvedValueOnce({ ok: true, action: "applied", kind: "upgrade", plan: "pro", interval: "year", effectiveAt: null, proration: "none", charge: null, trialEnd: PERIOD_END });
      j = await (await post(owner)).json();
      expect(j.billing).toContain("Nothing is charged until the trial ends");
      ch.mockResolvedValueOnce({ ok: false, status: 409, code: "unsupported", support: true, error: "x" });
      const res = await post(owner);
      expect(res.status).toBe(409);
      expect((await res.json()).support).toMatch(/@/);
    });
    it("cancel: explained with the end date", async () => {
      live();
      spies.push(vi.spyOn(planLib, "setCancelAtPeriodEnd").mockResolvedValue({ ok: true, action: "cancel_scheduled", cancelAt: PERIOD_END }));
      const j = await (await cancel(owner)).json();
      expect(j.billing).toContain("Your subscription ends on");
    });
  });
});
