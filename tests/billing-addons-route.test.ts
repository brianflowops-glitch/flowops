import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTestDb } from "./helpers/db";
import { memberOf, moveToOrg, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import * as addonsRoute from "@/app/api/billing/addons/route";
import * as textPacksRoute from "@/app/api/billing/text-packs/route";
import * as checkoutRoute from "@/app/api/billing/checkout/route";
import * as checkoutLib from "@/lib/billing/checkout";
import * as packsLib from "@/lib/billing/text-packs";
import * as stripeLib from "@/lib/billing/stripe";
import * as scheduled from "@/lib/billing/scheduled";

// Route guards for /api/billing/addons. Nothing here reaches Stripe: every case is decided before the first Stripe call.
describe("POST/GET /api/billing/addons guards", () => {
  let owner: TestUser, admin: TestUser, staffer: TestUser;

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    owner = await signUp("owner@addons.test", { businessName: "Addons Co" });
    const orgId = (await memberOf(owner.id)).organizationId;
    admin = await signUp("admin@addons.test");
    staffer = await signUp("staff@addons.test");
    await moveToOrg(admin.id, orgId, "admin");
    await moveToOrg(staffer.id, orgId, "staff");
  });
  afterAll(() => vi.unstubAllEnvs());

  const post = (u: TestUser | null, body: unknown = { addon: "seat", quantity: 1 }) =>
    addonsRoute.POST(req("/api/billing/addons", { method: "POST", body, cookie: u?.cookie }));
  const get = (u: TestUser | null) => addonsRoute.GET(req("/api/billing/addons", { cookie: u?.cookie }));

  it("404 for everyone while BILLING_ENABLED is off (default)", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    for (const u of [owner, admin, staffer, null]) {
      expect((await post(u)).status).toBe(404);
      expect((await get(u)).status).toBe(404);
    }
  });

  it("503 when billing is on but Stripe isn't configured", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect((await post(owner)).status).toBe(503);
  });

  describe("billing on", () => {
    beforeAll(() => {
      vi.stubEnv("BILLING_ENABLED", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
      vi.stubEnv("STRIPE_PRICE_STARTER", "price_x_starter");
      vi.stubEnv("STRIPE_ADDON_PRICE_SEAT", "price_x_seat");
      vi.stubEnv("STRIPE_PRICE_STARTER_ANNUAL", "price_x_starter_y");
      vi.stubEnv("STRIPE_ADDON_PRICE_SEAT_ANNUAL", "price_x_seat_y");
      vi.stubEnv("STRIPE_ADDON_PRICE_TEXTS_1000", "price_x_pack");
      vi.stubEnv("STRIPE_ADDON_PRICE_BRANDING", "price_x_brand");
    });

    it("401 without a session", async () => {
      expect((await post(null)).status).toBe(401);
      expect((await get(null)).status).toBe(401);
    });

    it("403 for staff on both verbs", async () => {
      expect((await post(staffer)).status).toBe(403);
      expect((await get(staffer)).status).toBe(403);
    });

    it("400 on a malformed body (Owner and Admin), before any Stripe call", async () => {
      for (const u of [owner, admin]) {
        for (const body of [{}, { addon: "seat" }, { addon: "seat", quantity: -1 }, { addon: "seat", quantity: 1.5 }, { addon: "seat", quantity: 5000 }, { addon: "", quantity: 1 }]) {
          expect((await post(u, body)).status).toBe(400);
        }
      }
    });

    it("400 with a clear message above the add-on's maximum (Owner and Admin), before any Stripe call", async () => {
      for (const u of [owner, admin]) {
        for (const [addon, quantity, max] of [["seat", 51, 50], ["seat", 1000, 50], ["branding", 2, 1]] as const) {
          const res = await post(u, { addon, quantity });
          expect(res.status).toBe(400);
          const j = await res.json();
          expect(j.error).toContain(`maximum of ${max}`);
          expect(j.error).toContain(addon);
        }
      }
    });

    it("an env override changes the cap used by the route (STRIPE_ADDON_MAX_SEAT=3 → 4 is refused)", async () => {
      vi.stubEnv("STRIPE_ADDON_MAX_SEAT", "3");
      const res = await post(owner, { addon: "seat", quantity: 4 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("maximum of 3");
      vi.stubEnv("STRIPE_ADDON_MAX_SEAT", "");
    });

    it("texts_1000 is no longer a recurring add-on: 400 pointing at the one-time pack endpoint, before any Stripe call", async () => {
      for (const u of [owner, admin]) {
        const res = await post(u, { addon: "texts_1000", quantity: 1 });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain("/api/billing/text-packs");
      }
    });

    it("GET works for Owner and Admin even though the org is locked (no subscription); lists add-ons, no prices", async () => {
      for (const u of [owner, admin]) {
        const res = await get(u);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.addons).toEqual([
          { key: "branding", priceId: "price_x_brand", prices: { month: "price_x_brand" }, known: true, max: 1 },
          { key: "seat", priceId: "price_x_seat", prices: { month: "price_x_seat", year: "price_x_seat_y" }, known: true, max: 50 },
        ]);
        expect(j.textPacks).toEqual([{ key: "texts_1000", priceId: "price_x_pack", texts: 1000, max: 10 }]);
        expect(j.entitlements).toMatchObject({ enforced: true, reason: "no_subscription", entitlements: { seats: 0 } });
        expect(JSON.stringify(j)).not.toMatch(/amount|unit_amount|\$/);
        expect(j.scheduled).toBeNull(); // no Stripe customer yet → nothing pending, and no Stripe call
      }
    });

    it("GET shows what is already scheduled for the renewal (ISO date, add-on diffs, entitlements then)", async () => {
      const entitlementsAtRenewal = { planKey: "starter", seats: 4, locations: 1, monthlyTexts: 500, brandingRemoved: false, source: "configured", addons: [] };
      const spy = vi.spyOn(scheduled, "getScheduledChanges").mockResolvedValue({ changes: { effectiveAt: 1800000000, addons: [{ key: "seat", from: 3, to: 1 }], plan: null, entitlementsAtRenewal } as never });
      const j = await (await get(owner)).json();
      expect(j.scheduled).toMatchObject({ effectiveAt: new Date(1800000000 * 1000).toISOString(), addons: [{ key: "seat", from: 3, to: 1 }], plan: null });
      expect(j.scheduledUnavailable).toBeUndefined();
      spy.mockResolvedValue({ changes: null, unavailable: true });
      const j2 = await (await get(admin)).json();
      expect(j2.scheduled).toBeNull();
      expect(j2.scheduledUnavailable).toBe(true);
      spy.mockRestore();
    });
  });

  describe("POST /api/billing/text-packs", () => {
    const post = (u: TestUser | null, body: unknown = { pack: "texts_1000", quantity: 1 }) =>
      textPacksRoute.POST(req("/api/billing/text-packs", { method: "POST", body, cookie: u?.cookie }));
    const spies: { mockRestore(): void }[] = [];
    afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));
    beforeAll(() => {
      vi.stubEnv("BILLING_ENABLED", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
      vi.stubEnv("STRIPE_PRICE_STARTER", "price_x_starter");
      vi.stubEnv("STRIPE_ADDON_PRICE_TEXTS_1000", "price_x_pack");
    });

    it("404 when billing is off; 401 / 403 for anonymous / staff", async () => {
      vi.stubEnv("BILLING_ENABLED", "");
      expect((await post(owner)).status).toBe(404);
      vi.stubEnv("BILLING_ENABLED", "true");
      expect((await post(null)).status).toBe(401);
      expect((await post(staffer)).status).toBe(403);
    });

    it("400 for bad bodies / unknown pack / above the cap, before any Stripe call", async () => {
      for (const body of [{}, { pack: "texts_1000", quantity: 0 }, { pack: "texts_1000", quantity: 1.5 }, { pack: "seat", quantity: 1 }, { pack: "nope", quantity: 1 }]) expect((await post(owner, body)).status).toBe(400);
      const res = await post(admin, { pack: "texts_1000", quantity: 11 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("maximum of 10");
    });

    it("409 without a subscription", async () => {
      spies.push(vi.spyOn(checkoutLib, "getOrCreateCustomer").mockResolvedValue("cus_x"), vi.spyOn(checkoutLib, "findLiveStripeSubscription").mockResolvedValue(undefined as never));
      expect((await post(owner)).status).toBe(409);
    });

    it("200: charged now, validUntil returned; Owner and Admin both allowed", async () => {
      spies.push(vi.spyOn(checkoutLib, "getOrCreateCustomer").mockResolvedValue("cus_x"), vi.spyOn(checkoutLib, "findLiveStripeSubscription").mockResolvedValue({ id: "sub_x", status: "trialing" } as never), vi.spyOn(stripeLib, "getStripe").mockReturnValue({} as never));
      const buy = vi.spyOn(packsLib, "purchaseTextPack").mockResolvedValue({ ok: true, pack: "texts_1000", quantity: 2, texts: 2000, invoiceId: "in_1", amountPaid: 3000, currency: "usd", validUntil: "2026-12-01T00:00:00.000Z", duringTrial: true });
      spies.push(buy);
      for (const u of [owner, admin]) {
        const res = await post(u, { pack: "texts_1000", quantity: 2 });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ texts: 2000, amountPaid: 3000, validUntil: "2026-12-01T00:00:00.000Z", duringTrial: true });
      }
      expect(buy.mock.calls[0][0]).toMatchObject({ pack: "texts_1000", quantity: 2, subscription: { id: "sub_x" } });
    });

    it("402 (payment failed / no card) is passed through with the portal pointer; nothing granted", async () => {
      spies.push(vi.spyOn(checkoutLib, "getOrCreateCustomer").mockResolvedValue("cus_x"), vi.spyOn(checkoutLib, "findLiveStripeSubscription").mockResolvedValue({ id: "sub_x", status: "active" } as never), vi.spyOn(stripeLib, "getStripe").mockReturnValue({} as never));
      spies.push(vi.spyOn(packsLib, "purchaseTextPack").mockResolvedValue({ ok: false, status: 402, error: "declined", code: "payment_failed", portal: true }));
      const res = await post(owner);
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: "declined", code: "payment_failed", portal: "/api/billing/portal" });
    });
  });

  describe("POST /api/billing/checkout (interval + trial)", () => {
    const post = (u: TestUser | null, body: unknown) => checkoutRoute.POST(req("/api/billing/checkout", { method: "POST", body, cookie: u?.cookie }));
    const spies: { mockRestore(): void }[] = [];
    afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); vi.stubEnv("TRIAL_DAYS", ""); });
    beforeAll(() => {
      vi.stubEnv("BILLING_ENABLED", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
      vi.stubEnv("STRIPE_PRICE_STARTER", "price_x_starter");
      vi.stubEnv("STRIPE_PRICE_STARTER_ANNUAL", "price_x_starter_y");
      vi.stubEnv("STRIPE_PRICE_PRO", "price_x_pro");
    });
    const mock = (eligible: boolean, live: unknown = undefined) => {
      const create = vi.fn().mockResolvedValue({ url: "https://checkout.test/s" });
      spies.push(
        vi.spyOn(checkoutLib, "getOrCreateCustomer").mockResolvedValue("cus_x"),
        vi.spyOn(checkoutLib, "expireOpenCheckoutSessions").mockResolvedValue(undefined as never),
        vi.spyOn(checkoutLib, "findLiveStripeSubscription").mockResolvedValue(live as never),
        vi.spyOn(checkoutLib, "trialEligibility").mockResolvedValue({ eligible }),
        vi.spyOn(stripeLib, "getStripe").mockReturnValue({ checkout: { sessions: { create } } } as never),
      );
      return create;
    };

    it("monthly by default; first subscription → 14-day trial with the card collected up front", async () => {
      const create = mock(true);
      const res = await post(owner, { plan: "starter" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ url: "https://checkout.test/s", interval: "month", trialDays: 14 });
      const p = create.mock.calls[0][0];
      expect(p.line_items[0].price).toBe("price_x_starter");
      expect(p.subscription_data.trial_period_days).toBe(14);
      expect(p.payment_method_collection).toBe("always");
    });

    it("yearly → the annual price; an org that already had a subscription gets NO trial", async () => {
      const create = mock(false);
      const res = await post(admin, { plan: "starter", interval: "year" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ interval: "year", trialDays: 0 });
      const p = create.mock.calls[0][0];
      expect(p.line_items[0].price).toBe("price_x_starter_y");
      expect(p.subscription_data.trial_period_days).toBeUndefined();
      expect(p.payment_method_collection).toBe("always");
    });

    it("TRIAL_DAYS=0 disables the trial; TRIAL_DAYS=7 shortens it", async () => {
      vi.stubEnv("TRIAL_DAYS", "0");
      let create = mock(true);
      await post(owner, { plan: "starter" });
      expect(create.mock.calls[0][0].subscription_data.trial_period_days).toBeUndefined();
      spies.splice(0).forEach((s) => s.mockRestore());
      vi.stubEnv("TRIAL_DAYS", "7");
      create = mock(true);
      await post(owner, { plan: "starter" });
      expect(create.mock.calls[0][0].subscription_data.trial_period_days).toBe(7);
    });

    it("400 for an unknown plan, an unknown interval, or a plan with no yearly price; 409 when already subscribed", async () => {
      mock(true);
      expect((await post(owner, { plan: "nope" })).status).toBe(400);
      expect((await post(owner, { plan: "starter", interval: "week" })).status).toBe(400);
      const res = await post(owner, { plan: "pro", interval: "year" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("no yearly price");
      spies.splice(0).forEach((s) => s.mockRestore());
      mock(true, { id: "sub_x", status: "trialing" });
      expect((await post(owner, { plan: "starter" })).status).toBe(409);
    });

    it("401 / 403 / 404 guards", async () => {
      expect((await post(null, { plan: "starter" })).status).toBe(401);
      expect((await post(staffer, { plan: "starter" })).status).toBe(403);
      vi.stubEnv("BILLING_ENABLED", "");
      expect((await post(owner, { plan: "starter" })).status).toBe(404);
      vi.stubEnv("BILLING_ENABLED", "true");
    });
  });
});
