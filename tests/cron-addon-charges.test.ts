import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTestDb } from "./helpers/db";
import { seedDemoOrg } from "./helpers/app";
import * as cronRoute from "@/app/api/cron/addon-charges/route";
import * as chargesDb from "@/lib/billing/addon-charges-db";
import { DEMO_ORG_ID } from "@/lib/tenancy/defaults";

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
