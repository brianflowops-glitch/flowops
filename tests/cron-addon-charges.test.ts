import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTestDb } from "./helpers/db";
import { seedDemoOrg } from "./helpers/app";
import * as cronRoute from "@/app/api/cron/addon-charges/route";
import * as chargesDb from "@/lib/billing/addon-charges-db";
import { DEMO_ORG_ID, defaultHours } from "@/lib/tenancy/defaults";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

// GET /api/cron/addon-charges: the daily sweep of crashed trial add-on charge attempts (docs/BILLING.md §11, 0006).
describe("GET /api/cron/addon-charges", () => {
  const SECRET = "cron-secret-for-tests-only";
  const call = (auth?: string) =>
    cronRoute.GET(new Request("http://localhost/api/cron/addon-charges", { headers: auth === undefined ? {} : { authorization: auth } }));

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => vi.unstubAllEnvs());

  it("503 when CRON_SECRET is unset (fails closed), nothing swept", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("BILLING_ENABLED", "true");
    const sweep = vi.spyOn(chargesDb, "sweepAddonCharges");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
    expect((await call()).status).toBe(503);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("401 for a missing, wrong, different-length or non-Bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("BILLING_ENABLED", "true");
    const sweep = vi.spyOn(chargesDb, "sweepAddonCharges");
    for (const a of [undefined, "", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}X`, SECRET, `bearer ${SECRET}`, `Bearer  ${SECRET}`])
      expect((await call(a)).status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("uses a constant-time compare (same helper as /api/cron/notifications)", () => {
    const src = readFileSync("src/app/api/cron/addon-charges/route.ts", "utf8");
    expect(src).toMatch(/timingSafeEqual\(got, want\)/);
    expect(src).not.toMatch(/===\s*`Bearer/);
  });

  it("BILLING_ENABLED off → 200 no-op, nothing read or written", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("BILLING_ENABLED", "");
    const sweep = vi.spyOn(chargesDb, "sweepAddonCharges");
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "billing_disabled" });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("billing on but Stripe not configured → 200 no-op", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const sweep = vi.spyOn(chargesDb, "sweepAddonCharges");
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ skipped: "billing_not_configured" });
    expect(sweep).not.toHaveBeenCalled();
  });

  describe("billing on", () => {
    beforeAll(() => {
      vi.stubEnv("CRON_SECRET", SECRET);
      vi.stubEnv("BILLING_ENABLED", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
    });

    it("skips the demo org and BILLING_EXEMPT_ORG_IDS, passes a time budget, reports counts", async () => {
      vi.stubEnv("BILLING_EXEMPT_ORG_IDS", "org_exempt_1, org_exempt_2");
      const sweep = vi.spyOn(chargesDb, "sweepAddonCharges").mockResolvedValue([
        { id: "adc_1", orgId: "org_a", status: "refunded" },
        { id: "adc_2", orgId: "org_a", status: "applied" },
        { id: "*", orgId: "org_b", status: "busy" },
        { id: "*", orgId: DEMO_ORG_ID, status: "skipped_exempt" },
      ] as Awaited<ReturnType<typeof chargesDb.sweepAddonCharges>>);
      const t = Date.now();
      const res = await call(`Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ orgs: 3, settled: 2, counts: { refunded: 1, applied: 1, busy: 1, skipped_exempt: 1 } });
      const opts = sweep.mock.calls[0][2]!;
      expect([...opts.skipOrgIds!].sort()).toEqual([DEMO_ORG_ID, "org_exempt_1", "org_exempt_2"].sort());
      expect(opts.skipDemoOrgs).toBe(true); // 0007: organization.is_demo too
      expect(opts.deadline! - t).toBeGreaterThan(30_000);
      expect(opts.deadline! - t).toBeLessThan(cronRoute.maxDuration * 1000);
    });

    it("a sweep failure → 500 without leaking details", async () => {
      vi.spyOn(chargesDb, "sweepAddonCharges").mockRejectedValue(new Error("boom sk_test_secret"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await call(`Bearer ${SECRET}`);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toMatch(/boom|sk_test/);
    });

    it("0007: a Neon -pooler DATABASE_URL without DATABASE_URL_UNPOOLED → 503 session_db_unavailable (visible failure, not a silent 200)", async () => {
      vi.stubEnv("DATABASE_URL", "postgres://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require");
      vi.stubEnv("DATABASE_URL_UNPOOLED", "");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await call(`Bearer ${SECRET}`);
      expect(res.status).toBe(503);
      const j = await res.json();
      expect(j.error).toBe("session_db_unavailable");
      expect(j.message).toMatch(/DATABASE_URL_UNPOOLED is required/);
      expect(JSON.stringify(j)).not.toMatch(/u:p@|neon\.tech/); // no URL or credentials in the response
      expect(err.mock.calls.flat().join(" ")).toMatch(/DATABASE_URL_UNPOOLED/);
      // With the direct URL present the same environment is fine again.
      vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/db");
      expect((await call(`Bearer ${SECRET}`)).status).toBe(200);
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("DATABASE_URL_UNPOOLED", "");
    });

    it("0007: an org with is_demo set is never swept (real run: its stranded attempt stays pending, no Stripe call)", async () => {
      const db = getDb();
      const org = "org_cron_is_demo";
      await db.insert(schema.organization).values({ id: org, slug: "cron-is-demo", name: "Some demo", hours: defaultHours(), isDemo: true });
      await db.insert(schema.addonCharge).values({ id: "adc_cron_demo", organizationId: org, stripeSubscriptionId: "sub_demo", stripeCustomerId: "cus_demo", addonKey: "seat", priceId: "price_x_seat", fromQuantity: 0, toQuantity: 1, amount: 100, currency: "usd", paymentMethod: "pm_x", status: "pending", createdAt: new Date(Date.now() - 3_600_000) });
      const res = await call(`Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ orgs: 1, settled: 0, counts: { skipped_demo: 1 } });
      const [row] = await db.select().from(schema.addonCharge).where(eq(schema.addonCharge.id, "adc_cron_demo"));
      expect(row.status).toBe("pending");
      await db.delete(schema.organization).where(eq(schema.organization.id, org));
    });

    it("real run against the test DB with nothing to settle → 200, zero orgs, no Stripe call", async () => {
      const res = await call(`Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ orgs: 0, settled: 0, counts: {} });
    });
  });

  it("vercel.json registers it once a day (Hobby-compatible: a single fixed hour, every day)", () => {
    const cfg = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string; schedule: string }[] };
    const c = cfg.crons?.find((x) => x.path === "/api/cron/addon-charges");
    expect(c).toBeDefined();
    const [min, hour, dom, mon, dow] = c!.schedule.split(" ");
    expect(min).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([dom, mon, dow]).toEqual(["*", "*", "*"]);
    expect(cronRoute.maxDuration).toBeLessThanOrEqual(60);
  });
});
