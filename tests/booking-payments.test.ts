/**
 * Payments at booking (BOOKING_PAYMENTS_ENABLED, Stripe Connect direct charges). Every Stripe call goes to an
 * in-test fake; the DB is PGlite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { initTestDb } from "./helpers/db";
import { BASE, futureWeekday, memberOf, moveToOrg, params, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { getDb, schema } from "@/lib/db";
import { DEMO_ORG_ID, DEMO_ORG_SLUG } from "@/lib/tenancy/defaults";
import { paymentDue, servicePaymentError } from "@/lib/payments/rules";
import { accountFlags } from "@/lib/payments/connect";
import * as stripeLib from "@/lib/billing/stripe";
import * as book from "@/app/api/public/[slug]/book/route";
import * as publicInfo from "@/app/api/public/[slug]/route";
import * as avail from "@/app/api/public/[slug]/availability/route";
import * as holdRoute from "@/app/api/public/[slug]/holds/[id]/route";
import * as releaseRoute from "@/app/api/public/[slug]/holds/[id]/release/route";
import * as connectHook from "@/app/api/webhooks/stripe-connect/route";
import * as adminPayments from "@/app/api/admin/payments/route";
import * as serviceRoute from "@/app/api/admin/services/[id]/route";

const ACCT = "acct_test_business";
const SVC = "svc_demo_consult"; // 60 min, Room A
let ip = 0;
/** Distinct dates (futureWeekday can map nearby offsets to the same Monday). */
const day = (k: number) => futureWeekday(14 + 7 * k);

describe("rules", () => {
  it("paymentDue: none / fixed / percent / full, minimums, deposit capped at price", () => {
    expect(paymentDue({ paymentMode: "none", priceCents: 5000 })).toBeNull();
    expect(paymentDue({ paymentMode: "fixed", depositCents: 2500 })).toEqual({ amountCents: 2500, kind: "deposit", currency: "usd" });
    expect(paymentDue({ paymentMode: "fixed", depositCents: 9000, priceCents: 5000 })?.amountCents).toBe(5000);
    expect(paymentDue({ paymentMode: "percent", priceCents: 8000, depositPercent: 25 })).toEqual({ amountCents: 2000, kind: "deposit", currency: "usd" });
    expect(paymentDue({ paymentMode: "percent", priceCents: 8000, depositPercent: 100 })?.kind).toBe("full");
    expect(paymentDue({ paymentMode: "percent", priceCents: 8000 })).toBeNull();
    expect(paymentDue({ paymentMode: "full", priceCents: 8000 })).toEqual({ amountCents: 8000, kind: "full", currency: "usd" });
    expect(paymentDue({ paymentMode: "full", priceCents: 40 })).toBeNull(); // under Stripe's $0.50
    expect(paymentDue({ paymentMode: "fixed", depositCents: null })).toBeNull();
  });
  it("servicePaymentError: required fields per mode", () => {
    expect(servicePaymentError({ paymentMode: "none" })).toBeNull();
    expect(servicePaymentError({ paymentMode: "fixed" })).toMatch(/at least \$0.50/);
    expect(servicePaymentError({ paymentMode: "fixed", depositCents: 6000, priceCents: 5000 })).toMatch(/more than the price/);
    expect(servicePaymentError({ paymentMode: "fixed", depositCents: 2500 })).toBeNull();
    expect(servicePaymentError({ paymentMode: "percent", depositPercent: 20 })).toMatch(/price/);
    expect(servicePaymentError({ paymentMode: "percent", priceCents: 100, depositPercent: 10 })).toMatch(/under \$0.50/);
    expect(servicePaymentError({ paymentMode: "percent", priceCents: 10000, depositPercent: 20 })).toBeNull();
    expect(servicePaymentError({ paymentMode: "full" })).toMatch(/price/);
    expect(servicePaymentError({ paymentMode: "full", priceCents: 9000 })).toBeNull();
    expect(servicePaymentError({ paymentMode: "none", depositPercent: 150 })).toMatch(/1–100/);
  });
  it("accountFlags: card_payments active → charges enabled; due requirements → details not submitted", () => {
    expect(accountFlags({ configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } }, requirements: { summary: {} } } as never)).toEqual({ chargesEnabled: true, detailsSubmitted: true });
    expect(accountFlags({ configuration: { merchant: { capabilities: { card_payments: { status: "pending" } } } }, requirements: { summary: { minimum_deadline: { status: "currently_due" } } } } as never)).toEqual({ chargesEnabled: false, detailsSubmitted: false });
  });
});

function fakeStripe() {
  const sessions = new Map<string, { id: string; status: string; payment_status: string; payment_intent: string | null; metadata: Record<string, string>; account: string }>();
  let n = 0;
  const run = Math.random().toString(36).slice(2, 8);
  const sid = (k: number) => `cs_test_${run}_${k}`;
  const create = vi.fn(async (p: { metadata: Record<string, string>; expires_at: number; line_items: { price_data: { unit_amount: number } }[] }, o: { stripeAccount: string; idempotencyKey: string }) => {
    const id = sid(++n);
    sessions.set(id, { id, status: "open", payment_status: "unpaid", payment_intent: null, metadata: p.metadata, account: o.stripeAccount });
    return { id, url: `https://checkout.stripe.test/${id}` };
  });
  const expire = vi.fn(async (id: string) => {
    const s = sessions.get(id)!;
    if (s.status === "complete") throw new Error("session complete");
    s.status = "expired";
    return s;
  });
  const retrieve = vi.fn(async (id: string) => sessions.get(id)!);
  const refunds = { create: vi.fn(async () => ({ id: "re_1" })) };
  const pay = (id: string) => Object.assign(sessions.get(id)!, { status: "complete", payment_status: "paid", payment_intent: `pi_${id}` });
  const v2 = {
    core: {
      accounts: {
        create: vi.fn(async () => ({ id: ACCT, configuration: { merchant: { capabilities: { card_payments: { status: "pending" } } } }, requirements: { summary: { minimum_deadline: { status: "currently_due" } } } })),
        retrieve: vi.fn(async () => ({ id: ACCT, configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } }, requirements: { summary: {} } })),
      },
      accountLinks: { create: vi.fn(async () => ({ url: "https://connect.stripe.test/onboard" })) },
    },
  };
  let nextEvent: unknown = null;
  const webhooks = { constructEventAsync: vi.fn(async () => nextEvent) };
  return { checkout: { sessions: { create, expire, retrieve } }, refunds, v2, webhooks, sessions, pay, sid, setEvent: (e: unknown) => (nextEvent = e) };
}

function bookReq(body: Record<string, unknown>) {
  ip++;
  return new Request(`${BASE}/api/public/${DEMO_ORG_SLUG}/book`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-real-ip": `198.51.100.${ip}`, "x-forwarded-for": `198.51.100.${ip}` },
    body: JSON.stringify({ serviceId: SVC, time: "10:00", name: "Pat Payer", ...body }),
  });
}
const publicReq = (path: string, method = "GET") => {
  ip++;
  return new Request(`${BASE}${path}`, { method, headers: { origin: BASE, "x-real-ip": `198.51.100.${ip}` } });
};
const bookingsOn = (date: string) => getDb().select().from(schema.booking).where(and(eq(schema.booking.organizationId, DEMO_ORG_ID), eq(schema.booking.date, date)));
const holdRow = async (id: string) => (await getDb().select().from(schema.bookingHold).where(eq(schema.bookingHold.id, id)))[0];
const slotsOn = async (date: string) => (await (await avail.GET(publicReq(`/api/public/${DEMO_ORG_SLUG}/availability?serviceId=${SVC}&date=${date}`), params({ slug: DEMO_ORG_SLUG }))).json()).slots as string[];
const hookEvent = (type: string, sessionId: string, holdId: string, account = ACCT, paid = true) => ({
  id: `evt_${type}_${sessionId}_${Math.random()}`,
  type,
  account,
  data: { object: { id: sessionId, object: "checkout.session", payment_status: paid ? "paid" : "unpaid", payment_intent: paid ? `pi_${sessionId}` : null, metadata: { flowops_hold_id: holdId } } },
});
const postHook = () => connectHook.POST(new Request(`${BASE}/api/webhooks/stripe-connect`, { method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: "{}" }));

describe("booking flow (PGlite)", () => {
  let fake: ReturnType<typeof fakeStripe>;
  let owner: TestUser, admin: TestUser, staffer: TestUser;
  const spies: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    owner = await signUp("owner@pay.test"); // claims the demo org (test DB only)
    admin = await signUp("admin@pay.test");
    staffer = await signUp("staff@pay.test");
    const orgId = (await memberOf(owner.id)).organizationId;
    expect(orgId).toBe(DEMO_ORG_ID);
    await moveToOrg(admin.id, orgId, "admin");
    await moveToOrg(staffer.id, orgId, "staff");
    // Consultation: $25 fixed deposit. Connected account ready.
    await getDb().update(schema.service).set({ paymentMode: "fixed", depositCents: 2500, priceCents: 10000 }).where(eq(schema.service.id, SVC));
    await getDb().insert(schema.stripeConnectAccount).values({ organizationId: DEMO_ORG_ID, stripeAccountId: ACCT, chargesEnabled: true, detailsSubmitted: true });
  });
  beforeEach(() => {
    fake = fakeStripe();
    spies.push(vi.spyOn(stripeLib, "getStripe").mockReturnValue(fake as never));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_dummy_never_used");
  });
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    vi.unstubAllEnvs();
  });

  describe("flag OFF (default): booking flow exactly as before", () => {
    it("a deposit service books immediately, no hold, no Stripe; public info has no payment field; new routes 404", async () => {
      const date = day(1);
      const res = await book.POST(bookReq({ date, email: "off@cust.test" }), params({ slug: DEMO_ORG_SLUG }));
      const d = await res.json();
      expect(d).toMatchObject({ ok: true, outcome: "verified" });
      expect(d.booking.id).toBeTruthy();
      expect(d.checkoutUrl).toBeUndefined();
      expect(fake.checkout.sessions.create).not.toHaveBeenCalled();
      expect(await getDb().select().from(schema.bookingHold)).toHaveLength(0);
      const info = await (await publicInfo.GET(publicReq(`/api/public/${DEMO_ORG_SLUG}`), params({ slug: DEMO_ORG_SLUG }))).json();
      expect(Object.keys(info.services.find((s: { id: string }) => s.id === SVC)).sort()).toEqual(["category", "description", "durationMin", "id", "name"]);
      expect((await postHook()).status).toBe(404);
      expect((await holdRoute.GET(publicReq("/x"), params({ slug: DEMO_ORG_SLUG, id: "hold_x" }))).status).toBe(404);
      expect((await releaseRoute.POST(publicReq("/x", "POST"), params({ slug: DEMO_ORG_SLUG, id: "hold_x" }))).status).toBe(404);
      expect((await adminPayments.GET(req("/api/admin/payments", { cookie: owner.cookie }))).status).toBe(404);
    });
  });

  describe("flag ON", () => {
    beforeEach(() => vi.stubEnv("BOOKING_PAYMENTS_ENABLED", "true"));

    it("service with payment mode 'none' books as before", async () => {
      const date = day(2);
      const d = await (await book.POST(bookReq({ date, serviceId: "svc_demo_onboard", email: "none@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      expect(d).toMatchObject({ ok: true, outcome: "verified" });
      expect(fake.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("no ready Stripe account → books without payment", async () => {
      await getDb().update(schema.stripeConnectAccount).set({ chargesEnabled: false }).where(eq(schema.stripeConnectAccount.organizationId, DEMO_ORG_ID));
      try {
        const d = await (await book.POST(bookReq({ date: day(3), email: "notready@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
        expect(d).toMatchObject({ ok: true, outcome: "verified" });
        expect(fake.checkout.sessions.create).not.toHaveBeenCalled();
      } finally {
        await getDb().update(schema.stripeConnectAccount).set({ chargesEnabled: true }).where(eq(schema.stripeConnectAccount.organizationId, DEMO_ORG_ID));
      }
    });

    it("public info shows the deposit label", async () => {
      const info = await (await publicInfo.GET(publicReq(`/api/public/${DEMO_ORG_SLUG}`), params({ slug: DEMO_ORG_SLUG }))).json();
      expect(info.services.find((s: { id: string }) => s.id === SVC).payment).toEqual({ amountCents: 2500, currency: "usd", kind: "deposit", label: "$25.00 deposit due at booking" });
      expect(info.services.find((s: { id: string }) => s.id === "svc_demo_onboard").payment).toBeUndefined();
    });

    it("deposit service → hold + Checkout on the connected account; slot blocked; webhook confirms once; duplicate is a no-op", async () => {
      const date = day(4);
      const d = await (await book.POST(bookReq({ date, email: "pay@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      expect(d).toMatchObject({ ok: true, outcome: "payment_required", checkoutUrl: `https://checkout.stripe.test/${fake.sid(1)}`, booking: null, payment: { amountCents: 2500, kind: "deposit" } });
      const [params0, opts0] = fake.checkout.sessions.create.mock.calls[0];
      expect(opts0.stripeAccount).toBe(ACCT);
      expect(params0.line_items[0].price_data.unit_amount).toBe(2500);
      expect(params0).not.toHaveProperty("payment_method_types");
      expect(params0).not.toHaveProperty("payment_intent_data.application_fee_amount");
      expect(params0.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
      const hold = await holdRow(d.hold.id);
      expect(hold).toMatchObject({ status: "pending", checkoutSessionId: fake.sid(1), amountCents: 2500, stripeAccountId: ACCT });
      expect(await bookingsOn(date)).toHaveLength(0); // not booked until paid

      // Slot is held: not offered, and a second customer can't take it.
      expect(await slotsOn(date)).not.toContain("10:00");
      const other = await (await book.POST(bookReq({ date, email: "other@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      expect(other).toMatchObject({ ok: false, outcome: "conflict" });
      expect(other.error).toMatch(/just taken/);

      fake.pay(fake.sid(1));
      fake.setEvent(hookEvent("checkout.session.completed", fake.sid(1), hold.id));
      expect(await (await postHook()).json()).toMatchObject({ status: "booked" });
      const rows = await bookingsOn(date);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ time: "10:00", email: "pay@cust.test", source: "public", status: "confirmed" });
      expect(await holdRow(hold.id)).toMatchObject({ status: "paid", bookingId: rows[0].id, paymentIntentId: `pi_${fake.sid(1)}` });

      // Re-delivery and the status poll don't double-book.
      expect(await (await postHook()).json()).toMatchObject({ status: "already" });
      const view = await (await holdRoute.GET(publicReq("/x"), params({ slug: DEMO_ORG_SLUG, id: hold.id }))).json();
      expect(view.hold).toMatchObject({ status: "paid", amount: "$25.00", booking: { id: rows[0].id, date, time: "10:00" } });
      expect(await bookingsOn(date)).toHaveLength(1);
      expect(fake.refunds.create).not.toHaveBeenCalled();
    });

    it("status poll confirms a paid session even without the webhook", async () => {
      const date = day(5);
      const d = await (await book.POST(bookReq({ date, email: "poll@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      fake.pay(fake.sid(1));
      const view = await (await holdRoute.GET(publicReq("/x"), params({ slug: DEMO_ORG_SLUG, id: d.hold.id }))).json();
      expect(view.hold.status).toBe("paid");
      expect(await bookingsOn(date)).toHaveLength(1);
    });

    it("expired Checkout → hold released, slot free again", async () => {
      const date = day(6);
      const d = await (await book.POST(bookReq({ date, email: "exp@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      expect(await slotsOn(date)).not.toContain("10:00");
      fake.setEvent(hookEvent("checkout.session.expired", fake.sid(1), d.hold.id, ACCT, false));
      expect(await (await postHook()).json()).toMatchObject({ status: "released" });
      expect((await holdRow(d.hold.id)).status).toBe("expired");
      expect(await slotsOn(date)).toContain("10:00");
      expect(await bookingsOn(date)).toHaveLength(0);
    });

    it("customer cancels in Checkout → release expires the session and frees the slot", async () => {
      const date = day(7);
      const d = await (await book.POST(bookReq({ date, email: "cancel@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      const r = await (await releaseRoute.POST(publicReq("/x", "POST"), params({ slug: DEMO_ORG_SLUG, id: d.hold.id }))).json();
      expect(r.hold.status).toBe("expired");
      expect(fake.checkout.sessions.expire).toHaveBeenCalledWith(fake.sid(1), {}, { stripeAccount: ACCT });
      expect(await slotsOn(date)).toContain("10:00");
    });

    it("release never frees a slot whose session was already paid", async () => {
      const date = day(8);
      const d = await (await book.POST(bookReq({ date, email: "paidrel@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      fake.pay(fake.sid(1));
      const r = await (await releaseRoute.POST(publicReq("/x", "POST"), params({ slug: DEMO_ORG_SLUG, id: d.hold.id }))).json();
      expect(r.hold.status).toBe("pending");
    });

    it("paid but the slot was taken meanwhile → conflict, refunded exactly once on the connected account", async () => {
      const date = day(9);
      const d = await (await book.POST(bookReq({ date, email: "late@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      // Simulate the hold lapsing and someone else booking the time.
      await getDb().update(schema.bookingHold).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.bookingHold.id, d.hold.id));
      const taken = await (await book.POST(bookReq({ date, serviceId: SVC, email: "first@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      expect(taken.outcome).toBe("payment_required");
      fake.pay(fake.sid(2));
      fake.setEvent(hookEvent("checkout.session.completed", fake.sid(2), taken.hold.id));
      expect(await (await postHook()).json()).toMatchObject({ status: "booked" });

      fake.pay(fake.sid(1));
      fake.setEvent(hookEvent("checkout.session.completed", fake.sid(1), d.hold.id));
      expect(await (await postHook()).json()).toMatchObject({ status: "conflict" });
      expect(await (await postHook()).json()).toMatchObject({ status: "already" });
      expect(fake.refunds.create).toHaveBeenCalledTimes(1);
      const [rp, ro] = fake.refunds.create.mock.calls[0] as unknown as [{ payment_intent: string }, { stripeAccount: string; idempotencyKey: string }];
      expect(rp.payment_intent).toBe(`pi_${fake.sid(1)}`);
      expect(ro).toEqual({ stripeAccount: ACCT, idempotencyKey: `flowops-hold-refund-${d.hold.id}` });
      expect((await holdRow(d.hold.id)).status).toBe("conflict");
      expect(await bookingsOn(date)).toHaveLength(1);
    });

    it("events from another connected account, or without our metadata, are ignored", async () => {
      const date = day(10);
      const d = await (await book.POST(bookReq({ date, email: "spoof@cust.test" }), params({ slug: DEMO_ORG_SLUG }))).json();
      fake.pay(fake.sid(1));
      fake.setEvent(hookEvent("checkout.session.completed", fake.sid(1), d.hold.id, "acct_someone_else"));
      expect(await (await postHook()).json()).toMatchObject({ status: "ignored" });
      fake.setEvent({ id: "evt_x", type: "checkout.session.completed", account: ACCT, data: { object: { id: "cs_x", metadata: {} } } });
      expect(await (await postHook()).json()).toMatchObject({ status: "ignored" });
      expect(await bookingsOn(date)).toHaveLength(0);
    });

    it("Checkout create failure frees the slot and returns 502", async () => {
      const date = day(11);
      fake.checkout.sessions.create.mockRejectedValueOnce(new Error("stripe down"));
      spies.push(vi.spyOn(console, "error").mockImplementation(() => {}));
      const res = await book.POST(bookReq({ date, email: "fail@cust.test" }), params({ slug: DEMO_ORG_SLUG }));
      expect(res.status).toBe(502);
      expect(await slotsOn(date)).toContain("10:00");
    });

    it("dashboard bookings also respect a held slot", async () => {
      const { runPipeline } = await import("@/lib/server/pipeline");
      const date = day(12);
      await book.POST(bookReq({ date, email: "held@cust.test" }), params({ slug: DEMO_ORG_SLUG }));
      const [org] = await getDb().select().from(schema.organization).where(eq(schema.organization.id, DEMO_ORG_ID));
      const r = await runPipeline(org, { action: "create", req: { customer: "Walk In", email: "walk@in.test", category: "appointment", service: "Consultation", resource: "Room A", date, time: "10:30", durationMin: 30 } }, { actor: "test", source: "dashboard" });
      expect(r.outcome).toBe("conflict");
    });

    it("admin payments: staff 403, admin can read but not onboard, owner onboards (account created once) and GET refreshes", async () => {
      await getDb().delete(schema.stripeConnectAccount).where(eq(schema.stripeConnectAccount.organizationId, DEMO_ORG_ID));
      try {
        expect((await adminPayments.GET(req("/api/admin/payments", { cookie: staffer.cookie }))).status).toBe(403);
        expect((await adminPayments.GET(req("/api/admin/payments", { cookie: admin.cookie }))).status).toBe(200);
        expect((await adminPayments.POST(req("/api/admin/payments", { method: "POST", body: { action: "onboard" }, cookie: admin.cookie }))).status).toBe(403);
        expect((await adminPayments.POST(req("/api/admin/payments", { method: "POST", body: {}, cookie: owner.cookie }))).status).toBe(400);
        const r = await (await adminPayments.POST(req("/api/admin/payments", { method: "POST", body: { action: "onboard" }, cookie: owner.cookie }))).json();
        expect(r.url).toBe("https://connect.stripe.test/onboard");
        const createArgs = fake.v2.core.accounts.create.mock.calls[0] as unknown as [Record<string, unknown>, { idempotencyKey: string }];
        expect(createArgs[0]).toMatchObject({ dashboard: "full", defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } }, configuration: { merchant: { capabilities: { card_payments: { requested: true } } } } });
        expect(createArgs[1].idempotencyKey).toBe(`flowops-connect-account-${DEMO_ORG_ID}`);
        await adminPayments.POST(req("/api/admin/payments", { method: "POST", body: { action: "onboard" }, cookie: owner.cookie }));
        expect(fake.v2.core.accounts.create).toHaveBeenCalledTimes(1);
        const g = await (await adminPayments.GET(req("/api/admin/payments", { cookie: owner.cookie }))).json();
        expect(g.payments).toMatchObject({ connected: true, accountId: ACCT, chargesEnabled: true, detailsSubmitted: true, configured: true });
      } finally {
        await getDb()
          .insert(schema.stripeConnectAccount)
          .values({ organizationId: DEMO_ORG_ID, stripeAccountId: ACCT, chargesEnabled: true, detailsSubmitted: true })
          .onConflictDoUpdate({ target: schema.stripeConnectAccount.organizationId, set: { chargesEnabled: true } });
      }
    });

    it("service PATCH validates payment settings against the stored row", async () => {
      const patch = (body: unknown) => serviceRoute.PATCH(req(`/api/admin/services/svc_demo_survey`, { method: "PATCH", body, cookie: owner.cookie }), params({ id: "svc_demo_survey" }));
      expect((await patch({ paymentMode: "fixed" })).status).toBe(400);
      expect((await patch({ paymentMode: "percent", depositPercent: 30 })).status).toBe(400);
      expect((await patch({ priceCents: 15000 })).status).toBe(200);
      const ok = await (await patch({ paymentMode: "percent", depositPercent: 30 })).json();
      expect(ok.service).toMatchObject({ paymentMode: "percent", priceCents: 15000, depositPercent: 30 });
      expect((await patch({ paymentMode: "none" })).status).toBe(200);
    });
  });
});
