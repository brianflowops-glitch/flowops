import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { initTestDb } from "./helpers/db";
import { futureWeekday, memberOf, moveToOrg, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { getDb, schema } from "@/lib/db";
import { canInjectFaults, faultInjectionEnabled } from "@/lib/server/fault-injection";
import * as bookings from "@/app/api/bookings/route";
import * as state from "@/app/api/state/route";

describe("faultInjectionEnabled / canInjectFaults", () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
  it("is on in dev/test and off in production builds", () => {
    expect(faultInjectionEnabled(env({ NODE_ENV: "test" }))).toBe(true);
    expect(faultInjectionEnabled(env({ NODE_ENV: "development" }))).toBe(true);
    expect(faultInjectionEnabled(env({ NODE_ENV: "production" }))).toBe(false);
  });
  it("can be opted into on a preview deployment, never on the production deployment", () => {
    expect(faultInjectionEnabled(env({ NODE_ENV: "production", VERCEL_ENV: "preview", FLOWOPS_ENABLE_FAULT_INJECTION: "true" }))).toBe(true);
    expect(faultInjectionEnabled(env({ NODE_ENV: "production", VERCEL_ENV: "production", FLOWOPS_ENABLE_FAULT_INJECTION: "true" }))).toBe(false);
    expect(faultInjectionEnabled(env({ NODE_ENV: "development", VERCEL_ENV: "production" }))).toBe(false);
  });
  it("requires Owner or Admin", () => {
    const t = env({ NODE_ENV: "test" });
    expect(canInjectFaults("owner", t)).toBe(true);
    expect(canInjectFaults("admin", t)).toBe(true);
    expect(canInjectFaults("staff", t)).toBe(false);
  });
});

describe("POST /api/bookings with failAgent", () => {
  let owner: TestUser, staffer: TestUser;
  const date = futureWeekday();
  const body = (customer: string) => ({
    action: "create",
    failAgent: "CalendarAgent",
    req: { customer, email: "c@cust.test", category: "appointment", service: "S", resource: "R", date, time: "11:00", durationMin: 30 },
  });
  const count = async (customer: string) => (await getDb().select().from(schema.booking).where(eq(schema.booking.customer, customer))).length;

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    owner = await signUp("owner@fault.test");
    staffer = await signUp("staff@fault.test");
    await moveToOrg(staffer.id, (await memberOf(owner.id)).organizationId, "staff");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is honored for an Owner in a test environment (fault injected, nothing saved)", async () => {
    const r = await (await bookings.POST(req("/api/bookings", { method: "POST", cookie: owner.cookie, body: body("Fault-Test") }))).json();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/injected fault/);
    expect(await count("Fault-Test")).toBe(0);
  });

  it("is refused with 403 in production, and no booking is created", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await bookings.POST(req("/api/bookings", { method: "POST", cookie: owner.cookie, body: body("Fault-Prod") }));
    expect(res.status).toBe(403);
    expect(await count("Fault-Prod")).toBe(0);
  });

  it("is refused for Staff even in a test environment", async () => {
    const res = await bookings.POST(req("/api/bookings", { method: "POST", cookie: staffer.cookie, body: body("Fault-Staff") }));
    expect(res.status).toBe(403);
    expect(await count("Fault-Staff")).toBe(0);
  });

  it("/api/state tells the UI whether to show the fault selector", async () => {
    const s1 = await (await state.GET(req("/api/state", { cookie: owner.cookie }))).json();
    expect(s1.integrations.faultInjection).toBe(true);
    const s2 = await (await state.GET(req("/api/state", { cookie: staffer.cookie }))).json();
    expect(s2.integrations.faultInjection).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    const s3 = await (await state.GET(req("/api/state", { cookie: owner.cookie }))).json();
    expect(s3.integrations.faultInjection).toBe(false);
  });

  it("normal bookings without failAgent still work for Staff", async () => {
    const { failAgent: _f, ...plain } = body("Plain-Staff");
    void _f;
    const r = await (await bookings.POST(req("/api/bookings", { method: "POST", cookie: staffer.cookie, body: plain }))).json();
    expect(r.ok).toBe(true);
    expect(await count("Plain-Staff")).toBe(1);
  });
});
