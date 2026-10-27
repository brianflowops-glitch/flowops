import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initTestDb } from "./helpers/db";
import { memberOf, moveToOrg, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import * as addonsRoute from "@/app/api/billing/addons/route";
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
      vi.stubEnv("STRIPE_ADDON_PRICE_TEXTS_1000", "price_x_t1k");
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
        for (const [addon, quantity, max] of [["seat", 51, 50], ["texts_1000", 1000, 10], ["texts_1000", 11, 10], ["branding", 2, 1]] as const) {
          const res = await post(u, { addon, quantity });
          expect(res.status).toBe(400);
          const j = await res.json();
          expect(j.error).toContain(`maximum of ${max}`);
          expect(j.error).toContain(addon);
        }
      }
    });

    it("an env override changes the cap used by the route (STRIPE_ADDON_MAX_TEXTS_1000=3 → 4 is refused)", async () => {
      vi.stubEnv("STRIPE_ADDON_MAX_TEXTS_1000", "3");
      const res = await post(owner, { addon: "texts_1000", quantity: 4 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("maximum of 3");
      vi.stubEnv("STRIPE_ADDON_MAX_TEXTS_1000", "");
    });

    it("GET works for Owner and Admin even though the org is locked (no subscription); lists add-ons, no prices", async () => {
      for (const u of [owner, admin]) {
        const res = await get(u);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.addons).toEqual([
          { key: "branding", priceId: "price_x_brand", known: true, max: 1 },
          { key: "seat", priceId: "price_x_seat", known: true, max: 50 },
          { key: "texts_1000", priceId: "price_x_t1k", known: true, max: 10 },
        ]);
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
});
