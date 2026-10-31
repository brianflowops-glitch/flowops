/**
 * Solo plan ($19/mo, $190/yr; Brian 2026-10-31): 1 seat, 1 location, FlowOps branding always shown, no branding /
 * seat / location add-ons. Prices only from STRIPE_PRICE_SOLO / STRIPE_PRICE_SOLO_ANNUAL; without them Solo is not
 * offered and nothing else changes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { initTestDb } from "./helpers/db";
import { req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { planByKey, plans } from "@/lib/billing/config";
import {
  addonAllowedOnPlan,
  computeEntitlements,
  DEFAULT_PLAN_LIMITS,
  entitlementsFromItems,
  FALLBACK_PLAN_LIMITS,
  planLabel,
  planLimits,
  planPicker,
  planSummary,
  PLAN_TIERS,
  sortPlanKeys,
} from "@/lib/billing/entitlements";
import { setAddonQuantity, type AddonStripe } from "@/lib/billing/addons";
import { blockedAddonsFor, classifyPlanChange } from "@/lib/billing/plan-change";
import * as checkoutRoute from "@/app/api/billing/checkout/route";
import * as planRoute from "@/app/api/billing/plan/route";
import * as checkoutLib from "@/lib/billing/checkout";
import * as stripeLib from "@/lib/billing/stripe";

const BASE = {
  STRIPE_PRICE_STARTER: "p_starter_m",
  STRIPE_PRICE_STARTER_ANNUAL: "p_starter_y",
  STRIPE_PRICE_PRO: "p_pro_m",
  STRIPE_ADDON_PRICE_SEAT: "p_seat_m",
  STRIPE_ADDON_PRICE_LOCATION: "p_loc_m",
  STRIPE_ADDON_PRICE_BRANDING: "p_brand_m",
  STRIPE_ADDON_PRICE_TEXTS_1000: "p_t1k",
};
const SOLO = { ...BASE, STRIPE_PRICE_SOLO: "p_solo_m", STRIPE_PRICE_SOLO_ANNUAL: "p_solo_y" };

describe("Solo plan definition", () => {
  it("limits: 1 seat, 1 location, 200 texts, branding shown; Starter/Pro/Business unchanged", () => {
    expect(DEFAULT_PLAN_LIMITS.solo).toEqual({ seats: 1, locations: 1, monthlyTexts: 200, brandingRemoved: false });
    expect(DEFAULT_PLAN_LIMITS.starter).toEqual({ seats: 3, locations: 1, monthlyTexts: 500, brandingRemoved: false });
    expect(DEFAULT_PLAN_LIMITS.pro).toEqual({ seats: 10, locations: 1, monthlyTexts: 2000, brandingRemoved: true });
    expect(DEFAULT_PLAN_LIMITS.business).toEqual({ seats: 25, locations: 3, monthlyTexts: 5000, brandingRemoved: true });
    expect(planLimits("solo", {})).toMatchObject({ seats: 1, locations: 1, monthlyTexts: 200, brandingRemoved: false, source: "configured" });
    // An unrecognised plan still falls back to Starter (not to the new, smaller Solo).
    expect(FALLBACK_PLAN_LIMITS).toBe(DEFAULT_PLAN_LIMITS.starter);
    // PLAN_LIMITS_SOLO overrides like any other plan.
    expect(planLimits("solo", { PLAN_LIMITS_SOLO: "texts=300" }).monthlyTexts).toBe(300);
  });

  it("is the lowest tier: picker order, and any move to Solo is a downgrade (at renewal)", () => {
    expect(PLAN_TIERS[0]).toBe("solo");
    expect(sortPlanKeys(["business", "pro", "solo", "custom", "starter"])).toEqual(["solo", "starter", "pro", "business", "custom"]);
    expect(classifyPlanChange({ key: "starter", interval: "month" }, { key: "solo", interval: "month" })).toBe("downgrade");
    expect(classifyPlanChange({ key: "starter", interval: "month" }, { key: "solo", interval: "year" })).toBe("downgrade");
    expect(classifyPlanChange({ key: "solo", interval: "month" }, { key: "starter", interval: "month" })).toBe("upgrade");
    expect(classifyPlanChange({ key: "solo", interval: "month" }, { key: "solo", interval: "year" })).toBe("upgrade");
    expect(planLabel("solo")).toBe("Solo");
    expect(planSummary(DEFAULT_PLAN_LIMITS.solo)).toBe("1 seat · 1 location · 200 texts/mo · FlowOps branding");
  });

  it("add-ons: no branding removal, extra seats or extra locations on Solo; text packs and other plans unaffected", () => {
    for (const a of ["branding", "seat", "location", "BRANDING"]) expect(addonAllowedOnPlan("solo", a)).toBe(false);
    expect(addonAllowedOnPlan("solo", "texts_1000")).toBe(true);
    for (const p of ["starter", "pro", "business", null]) for (const a of ["branding", "seat", "location"]) expect(addonAllowedOnPlan(p, a)).toBe(true);
  });

  it("entitlements: a blocked add-on put on a Solo subscription in Stripe directly grants nothing", () => {
    const e = entitlementsFromItems([{ priceId: "p_solo_m", quantity: 1 }, { priceId: "p_brand_m", quantity: 1 }, { priceId: "p_seat_m", quantity: 4 }, { priceId: "p_loc_m", quantity: 2 }], SOLO);
    expect(e).toMatchObject({ planKey: "solo", seats: 1, locations: 1, monthlyTexts: 200, brandingRemoved: false, addons: [] });
    // Text packs still add texts on Solo.
    expect(computeEntitlements("solo", [], SOLO, [{ key: "texts_1000", quantity: 1 }]).monthlyTexts).toBe(1200);
    // The same add-ons on Starter still count (unchanged behaviour).
    expect(entitlementsFromItems([{ priceId: "p_starter_m", quantity: 1 }, { priceId: "p_brand_m", quantity: 1 }, { priceId: "p_seat_m", quantity: 2 }], SOLO)).toMatchObject({ seats: 5, brandingRemoved: true });
  });
});

describe("Solo prices come only from env", () => {
  it("STRIPE_PRICE_SOLO / STRIPE_PRICE_SOLO_ANNUAL → plan 'solo' monthly / yearly", () => {
    expect(planByKey("solo", SOLO, "month")?.priceId).toBe("p_solo_m");
    expect(planByKey("solo", SOLO, "year")?.priceId).toBe("p_solo_y");
  });
  it("STRIPE_PRICE_SOLO_MONTHLY is accepted as an alias; the unsuffixed name wins; no 'solo_monthly' plan appears", () => {
    const alias = { ...BASE, STRIPE_PRICE_SOLO_MONTHLY: "p_solo_alias", STRIPE_PRICE_SOLO_ANNUAL: "p_solo_y" };
    expect(planByKey("solo", alias, "month")?.priceId).toBe("p_solo_alias");
    expect(plans(alias).map((p) => p.key)).not.toContain("solo_monthly");
    expect(plans({ ...alias, STRIPE_PRICE_SOLO: "p_solo_m" }).filter((p) => p.key === "solo" && p.interval === "month").map((p) => p.priceId)).toEqual(["p_solo_m"]);
  });
  it("missing (or blank) Solo env vars → Solo not offered; the other plans are offered exactly as before", () => {
    expect(planPicker(plans(BASE), BASE)).toEqual({
      planKeys: ["starter", "pro"],
      annualPlanKeys: ["starter"],
      planNotes: { starter: "3 seats · 1 location · 500 texts/mo · FlowOps branding", pro: "10 seats · 1 location · 2,000 texts/mo · your branding" },
    });
    expect(planPicker(plans({ ...BASE, STRIPE_PRICE_SOLO: "  ", STRIPE_PRICE_SOLO_ANNUAL: "" }), BASE).planKeys).toEqual(["starter", "pro"]);
    // Monthly only → offered monthly, not yearly. Annual only → not offered (the picker starts from monthly prices).
    expect(planPicker(plans({ ...BASE, STRIPE_PRICE_SOLO: "p_solo_m" }), BASE)).toMatchObject({ planKeys: ["solo", "starter", "pro"], annualPlanKeys: ["starter"] });
    expect(planPicker(plans({ ...BASE, STRIPE_PRICE_SOLO_ANNUAL: "p_solo_y" }), BASE).planKeys).toEqual(["starter", "pro"]);
    expect(planPicker(plans(SOLO), SOLO)).toMatchObject({ planKeys: ["solo", "starter", "pro"], annualPlanKeys: ["solo", "starter"] });
  });
});

describe("plan switch to Solo is refused while a blocked add-on would remain", () => {
  it("blockedAddonsFor lists the add-ons Solo can't carry (quantity > 0 only)", () => {
    expect(blockedAddonsFor("solo", [{ price: "p_starter_m", quantity: 1 }, { price: "p_brand_m", quantity: 1 }, { price: "p_seat_m", quantity: 2 }], SOLO)).toEqual(["branding", "seat"]);
    expect(blockedAddonsFor("solo", [{ price: "p_starter_m", quantity: 1 }, { price: "p_seat_m", quantity: 0 }], SOLO)).toEqual([]);
    expect(blockedAddonsFor("starter", [{ price: "p_brand_m", quantity: 1 }], SOLO)).toEqual([]);
  });
});

/** Minimal Stripe for add-on refusals: they happen before any write, so a write fails the test. */
function addonStripe(items: [string, number][]) {
  const writes: string[] = [];
  const sub = { id: "sub_s", status: "active", schedule: null, items: { has_more: false, data: items.map(([price, quantity], i) => ({ id: `si_${i}`, price: { id: price, recurring: { interval: "month" } }, quantity, current_period_end: 1_900_000_000 })) } };
  const stripe = {
    subscriptions: { retrieve: async () => structuredClone(sub) as unknown as Stripe.Subscription },
    subscriptionItems: {
      list: () => ({ autoPagingToArray: async () => sub.items.data }),
      create: async () => (writes.push("create"), { id: "si_new" }),
      update: async () => (writes.push("update"), { id: "si_0" }),
    },
    subscriptionSchedules: { retrieve: async () => null, create: async () => (writes.push("schedule.create"), null), update: async () => (writes.push("schedule.update"), null), release: async () => (writes.push("schedule.release"), {}) },
  };
  return { stripe: stripe as unknown as AddonStripe, writes };
}

describe("buying add-ons on Solo", () => {
  for (const [addon, text] of [["branding", /Branding removal is not available on the Solo plan/], ["seat", /Extra seats are not available on the Solo plan/], ["location", /Extra locations are not available on the Solo plan/]] as const) {
    it(`${addon}: 409 with an upgrade hint, nothing written`, async () => {
      const f = addonStripe([["p_solo_m", 1]]);
      const r = await setAddonQuantity({ stripe: f.stripe, subscription: { id: "sub_s", status: "active" }, addon, quantity: 1, env: SOLO });
      expect(r).toMatchObject({ ok: false, status: 409 });
      expect(!r.ok && r.error).toMatch(text);
      expect(!r.ok && r.error).toMatch(/Upgrade to Starter/);
      expect(f.writes).toEqual([]);
    });
  }
  it("the same add-on on Starter is still sold (charged now, as before)", async () => {
    const f = addonStripe([["p_starter_m", 1]]);
    const r = await setAddonQuantity({ stripe: f.stripe, subscription: { id: "sub_s", status: "active" }, addon: "seat", quantity: 1, env: SOLO });
    expect(r.ok).toBe(true);
    expect(f.writes).toEqual(["create"]);
  });
});

describe("routes: Solo offered only when its price env vars exist", () => {
  let owner: TestUser;
  const spies: { mockRestore(): void }[] = [];
  const create = vi.fn(async (p: Stripe.Checkout.SessionCreateParams) => ({ id: "cs_1", url: `https://checkout.stripe.test/${p.line_items?.[0]?.price}` }));
  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    await signUp("demo-owner@solo.test", { businessName: "Demo claimer" }); // first sign-up claims the demo org
    owner = await signUp("owner@solo.test", { businessName: "Solo Co" });
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
    for (const [k, v] of Object.entries(BASE)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    create.mockClear();
  });
  afterAll(() => vi.unstubAllEnvs());
  const stubStripe = () =>
    spies.push(
      vi.spyOn(checkoutLib, "getOrCreateCustomer").mockResolvedValue("cus_solo"),
      vi.spyOn(checkoutLib, "expireOpenCheckoutSessions").mockResolvedValue(undefined as never),
      vi.spyOn(checkoutLib, "findLiveStripeSubscription").mockResolvedValue(undefined),
      vi.spyOn(checkoutLib, "trialEligibility").mockResolvedValue({ eligible: true } as never),
      vi.spyOn(checkoutLib, "findCustomerId").mockResolvedValue(null),
      vi.spyOn(stripeLib, "getStripe").mockReturnValue({ checkout: { sessions: { create } } } as never),
    );
  const checkout = (body: unknown) => checkoutRoute.POST(req("/api/billing/checkout", { method: "POST", body, cookie: owner.cookie }));
  const listed = async () => ((await (await planRoute.GET(req("/api/billing/plan", { cookie: owner.cookie }))).json()) as { plans: { key: string; interval: string }[] }).plans;

  it("unset: not listed, checkout for Solo is a clean 400 with no Stripe call, Starter checkout still works", async () => {
    vi.stubEnv("STRIPE_PRICE_SOLO", "");
    vi.stubEnv("STRIPE_PRICE_SOLO_ANNUAL", "");
    stubStripe();
    expect((await listed()).map((p) => p.key)).not.toContain("solo");
    const r = await checkout({ plan: "solo", interval: "month" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toMatch(/Unknown plan/);
    expect(create).not.toHaveBeenCalled();
    const ok = await checkout({ plan: "starter", interval: "month" });
    expect(ok.status).toBe(200);
    expect(create.mock.calls[0][0].line_items).toEqual([{ price: "p_starter_m", quantity: 1 }]);
  });

  it("monthly only: listed monthly, yearly Solo checkout is a 400", async () => {
    vi.stubEnv("STRIPE_PRICE_SOLO", "p_solo_m");
    vi.stubEnv("STRIPE_PRICE_SOLO_ANNUAL", "");
    stubStripe();
    expect((await listed()).filter((p) => p.key === "solo")).toEqual([{ key: "solo", interval: "month" }]);
    const r = await checkout({ plan: "solo", interval: "year" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toMatch(/no yearly price/);
    expect(create).not.toHaveBeenCalled();
  });

  it("both set: checkout uses the Solo price for the chosen interval, with the usual no-card trial", async () => {
    vi.stubEnv("STRIPE_PRICE_SOLO", "p_solo_m");
    vi.stubEnv("STRIPE_PRICE_SOLO_ANNUAL", "p_solo_y");
    stubStripe();
    expect((await listed()).filter((p) => p.key === "solo").map((p) => p.interval).sort()).toEqual(["month", "year"]);
    for (const [interval, price] of [["month", "p_solo_m"], ["year", "p_solo_y"]] as const) {
      const r = await checkout({ plan: "solo", interval });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ plan: "solo", interval, trialDays: 14 });
      const p = create.mock.calls.at(-1)![0];
      expect(p.line_items).toEqual([{ price, quantity: 1 }]);
      expect(p.payment_method_collection).toBe("if_required");
    }
  });
});
