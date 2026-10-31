/**
 * No-card free trial (Brian, 2026-10-31): Checkout params, the add-a-card banner, the lock-screen copy, the
 * trial_will_end reminder, the portal's add-card deep link and the webhook wiring. Nothing here reaches Stripe:
 * every Stripe call goes to an in-test fake.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { initTestDb } from "./helpers/db";
import { memberOf, moveToOrg, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { getDb, schema } from "@/lib/db";
import { checkoutSessionParams } from "@/lib/billing/checkout-params";
import { daysLeft, defaultPaymentMethod, trialBanner, trialEndingEmail } from "@/lib/billing/trial-rules";
import { lockScreenCopy } from "@/lib/billing/lock-copy";
import { HANDLED_EVENTS } from "@/lib/billing/webhook";
import { sendTrialEndingReminder } from "@/lib/billing/trial-reminder";
import * as stripeLib from "@/lib/billing/stripe";
import * as checkoutLib from "@/lib/billing/checkout";
import * as trialReminder from "@/lib/billing/trial-reminder";
import * as trialRoute from "@/app/api/billing/trial/route";
import * as portalRoute from "@/app/api/billing/portal/route";
import * as webhookRoute from "@/app/api/billing/webhook/route";

const NOW = new Date("2026-11-01T12:00:00Z");
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe("checkout params", () => {
  it("trial: no card required (if_required), 14 days, cancel if still no card at the end", () => {
    const p = checkoutSessionParams({ orgId: "org_1", customer: "cus_1", priceId: "price_s", origin: "https://x.test", trialDays: 14 });
    expect(p.payment_method_collection).toBe("if_required");
    expect(p.subscription_data?.trial_period_days).toBe(14);
    expect(p.subscription_data?.trial_settings?.end_behavior?.missing_payment_method).toBe("cancel");
    expect(p.mode).toBe("subscription");
    // unchanged: no tax, org metadata
    expect((p as Record<string, unknown>).automatic_tax).toBeUndefined();
    expect(p.subscription_data?.metadata?.organizationId).toBe("org_1");
  });
  it("no trial (trial already used): the card is still always collected", () => {
    const p = checkoutSessionParams({ orgId: "org_1", customer: "cus_1", priceId: "price_s", origin: "https://x.test", trialDays: 0 });
    expect(p.payment_method_collection).toBe("always");
    expect(p.subscription_data?.trial_period_days).toBeUndefined();
    expect(p.subscription_data?.trial_settings).toBeUndefined();
  });
});

describe("trial rules", () => {
  it("daysLeft rounds up and stops at 0", () => {
    expect(daysLeft(new Date("2026-11-01T15:00:00Z"), NOW)).toBe(1);
    expect(daysLeft(new Date("2026-11-15T12:00:00Z"), NOW)).toBe(14);
    expect(daysLeft(new Date("2026-10-31T12:00:00Z"), NOW)).toBe(0);
  });
  it("defaultPaymentMethod: subscription's own, else the customer's default, else null", () => {
    const sub = (pm: string | null) => ({ default_payment_method: pm, default_source: null }) as unknown as Stripe.Subscription;
    const cust = (pm: string | null) => ({ deleted: undefined, invoice_settings: { default_payment_method: pm }, default_source: null }) as unknown as Stripe.Customer;
    expect(defaultPaymentMethod(sub("pm_sub"), cust("pm_cus"))).toBe("pm_sub");
    expect(defaultPaymentMethod(sub(null), cust("pm_cus"))).toBe("pm_cus");
    expect(defaultPaymentMethod(sub(null), cust(null))).toBeNull();
    expect(defaultPaymentMethod(sub(null), { id: "cus_x", deleted: true } as Stripe.DeletedCustomer)).toBeNull();
    expect(defaultPaymentMethod(sub(null), null)).toBeNull();
  });
  it("banner: add_card with days left when there is no card; quiet info with a card; null when not trialing", () => {
    const b = trialBanner({ status: "trialing", trialEnd: at("2026-11-11T12:00:00Z"), hasPaymentMethod: false, now: NOW });
    expect(b).toMatchObject({ tone: "add_card", daysLeft: 10, hasPaymentMethod: false });
    expect(b!.message).toMatch(/10 days left/);
    expect(b!.message).toMatch(/Add a card/);
    const one = trialBanner({ status: "trialing", trialEnd: at("2026-11-02T00:00:00Z"), hasPaymentMethod: false, now: NOW });
    expect(one!.message).toMatch(/1 day left/);
    const info = trialBanner({ status: "trialing", trialEnd: at("2026-11-11T12:00:00Z"), hasPaymentMethod: true, now: NOW });
    expect(info).toMatchObject({ tone: "info", hasPaymentMethod: true });
    expect(trialBanner({ status: "active", trialEnd: at("2026-11-11T12:00:00Z"), hasPaymentMethod: false, now: NOW })).toBeNull();
    expect(trialBanner({ status: "trialing", trialEnd: null, hasPaymentMethod: false, now: NOW })).toBeNull();
  });
  it("reminder email: names the org and date, links to billing, uses the billing@ address, no grokbot address", () => {
    const m = trialEndingEmail({ orgName: "Acme Plumbing", trialEnd: at("2026-11-14T12:00:00Z"), appUrl: "https://flowopsagent.ai/" });
    expect(m.subject).toMatch(/Nov 14/);
    expect(m.text).toContain("Acme Plumbing");
    expect(m.text).toContain("https://flowopsagent.ai/admin#billing");
    expect(m.text).toContain("billing@flowopsagent.ai");
    expect(m.text).not.toMatch(/grokbot/i);
  });
});

describe("lock screen copy", () => {
  it("first plan with a trial: says no card required", () => {
    const c = lockScreenCopy({ reason: "no_subscription", canManageBilling: true }, { trialDays: 14 });
    expect(c.action).toBe("choose_plan");
    expect(c.title).toMatch(/14-day free trial/);
    expect(c.message).toMatch(/No card required/);
  });
  it("without trialDays (or 0) and for other reasons the copy is unchanged", () => {
    expect(lockScreenCopy({ reason: "no_subscription", canManageBilling: true }).title).toBe("Choose a plan to continue");
    expect(lockScreenCopy({ reason: "no_subscription", canManageBilling: true }, { trialDays: 0 }).title).toBe("Choose a plan to continue");
    expect(lockScreenCopy({ reason: "canceled", canManageBilling: true }, { trialDays: 14 }).title).toBe("Your plan has ended");
    expect(lockScreenCopy({ reason: "no_subscription", canManageBilling: false }, { trialDays: 14 }).action).toBe("contact_admin");
  });
});

describe("trial_will_end is a handled (deduped) webhook event", () => {
  it("is in HANDLED_EVENTS", () => {
    expect(HANDLED_EVENTS).toContain("customer.subscription.trial_will_end");
  });
});

describe("routes and reminder (PGlite)", () => {
  let owner: TestUser, admin: TestUser, staffer: TestUser;
  let orgId: string;
  const spies: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    await signUp("demo-owner@trial.test"); // first sign-up claims the demo org
    owner = await signUp("owner@trial.test", { businessName: "Trial Co" });
    orgId = (await memberOf(owner.id)).organizationId;
    admin = await signUp("admin@trial.test");
    staffer = await signUp("staff@trial.test");
    await moveToOrg(admin.id, orgId, "admin");
    await moveToOrg(staffer.id, orgId, "staff");
  });
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });
  afterAll(() => vi.unstubAllEnvs());

  const fakeStripe = (o: { status?: string; trialEnd?: number; subPm?: string | null; custPm?: string | null } = {}) => {
    const subscriptions = { retrieve: vi.fn(async (id: string) => ({ id, status: o.status ?? "trialing", trial_end: o.trialEnd ?? at("2026-12-01T00:00:00Z"), customer: "cus_trial", default_payment_method: o.subPm ?? null, default_source: null, metadata: { organizationId: orgId } })) };
    const customers = { retrieve: vi.fn(async () => ({ id: "cus_trial", invoice_settings: { default_payment_method: o.custPm ?? null }, default_source: null })) };
    return { subscriptions, customers } as unknown as Stripe & { subscriptions: typeof subscriptions; customers: typeof customers };
  };

  it("GET /api/billing/trial: 404 while billing is off", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    expect((await trialRoute.GET(req("/api/billing/trial", { cookie: owner.cookie }))).status).toBe(404);
  });

  describe("billing on", () => {
    beforeAll(() => {
      vi.stubEnv("BILLING_ENABLED", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_never_used");
    });

    it("401 signed out, 403 for staff", async () => {
      expect((await trialRoute.GET(req("/api/billing/trial"))).status).toBe(401);
      expect((await trialRoute.GET(req("/api/billing/trial", { cookie: staffer.cookie }))).status).toBe(403);
    });

    it("no trialing subscription → { trial: null } with no Stripe call", async () => {
      const gs = vi.spyOn(stripeLib, "getStripe").mockImplementation(() => {
        throw new Error("must not call Stripe");
      });
      spies.push(gs);
      const res = await trialRoute.GET(req("/api/billing/trial", { cookie: owner.cookie }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ trial: null });
      expect(gs).not.toHaveBeenCalled();
    });

    it("trialing with no card → add_card banner for Owner and Admin; with a card → info", async () => {
      await getDb().insert(schema.billingCustomer).values({ organizationId: orgId, stripeCustomerId: "cus_trial" }).onConflictDoNothing();
      await getDb().insert(schema.subscription).values({ id: "sub_row_trial", organizationId: orgId, stripeSubscriptionId: "sub_trial", status: "trialing" }).onConflictDoNothing();
      const s = fakeStripe({ trialEnd: Math.floor(Date.now() / 1000) + 5 * 86400 });
      spies.push(vi.spyOn(stripeLib, "getStripe").mockReturnValue(s));
      for (const u of [owner, admin]) {
        const body = await (await trialRoute.GET(req("/api/billing/trial", { cookie: u.cookie }))).json();
        expect(body.trial).toMatchObject({ tone: "add_card", hasPaymentMethod: false, daysLeft: 5 });
      }
      spies.pop()!.mockRestore();
      spies.push(vi.spyOn(stripeLib, "getStripe").mockReturnValue(fakeStripe({ custPm: "pm_card" })));
      const withCard = await (await trialRoute.GET(req("/api/billing/trial", { cookie: owner.cookie }))).json();
      expect(withCard.trial).toMatchObject({ tone: "info", hasPaymentMethod: true });
    });

    it("POST /api/billing/portal {flow: payment_method_update} deep-links to add a card; plain POST unchanged", async () => {
      const create = vi.fn(async (p: Stripe.BillingPortal.SessionCreateParams) => ({ url: `https://billing.stripe.test/${p.flow_data?.type ?? "home"}` }));
      spies.push(vi.spyOn(checkoutLib, "getOrCreateCustomer").mockResolvedValue("cus_trial"));
      spies.push(vi.spyOn(stripeLib, "getStripe").mockReturnValue({ billingPortal: { sessions: { create } } } as never));
      const a = await (await portalRoute.POST(req("/api/billing/portal", { method: "POST", body: { flow: "payment_method_update" }, cookie: owner.cookie }))).json();
      expect(a.url).toMatch(/payment_method_update$/);
      expect(create.mock.calls[0][0].flow_data).toEqual({ type: "payment_method_update" });
      const b = await (await portalRoute.POST(req("/api/billing/portal", { method: "POST", cookie: owner.cookie }))).json();
      expect(b.url).toMatch(/home$/);
      expect(create.mock.calls[1][0].flow_data).toBeUndefined();
      expect((await portalRoute.POST(req("/api/billing/portal", { method: "POST", body: { flow: "payment_method_update" }, cookie: staffer.cookie }))).status).toBe(403);
    });

    it("trial_will_end reminder: emails Owner + Admin (not Staff) when there's no card; skips with a card or once active", async () => {
      const send = vi.fn(async () => ({ sent: true }));
      const r = await sendTrialEndingReminder("sub_trial", { stripe: fakeStripe(), send, appUrl: "https://app.test" });
      expect(r).toEqual({ status: "sent", recipients: 2 });
      expect(send.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(["admin@trial.test", "owner@trial.test"]);
      expect(await sendTrialEndingReminder("sub_trial", { stripe: fakeStripe({ subPm: "pm_x" }), send })).toEqual({ status: "skipped", reason: "has_payment_method" });
      expect(await sendTrialEndingReminder("sub_trial", { stripe: fakeStripe({ status: "active" }), send })).toEqual({ status: "skipped", reason: "not_trialing" });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("trial reminder skips demo orgs", async () => {
      const [demo] = await getDb().select().from(schema.organization).where(eq(schema.organization.isDemo, true)).limit(1);
      const s = fakeStripe();
      s.subscriptions.retrieve.mockResolvedValueOnce({ id: "sub_demo", status: "trialing", trial_end: at("2026-12-01T00:00:00Z"), customer: "cus_demo", default_payment_method: null, default_source: null, metadata: { organizationId: demo.id } } as never);
      const send = vi.fn(async () => ({ sent: true }));
      expect(await sendTrialEndingReminder("sub_demo", { stripe: s, send })).toEqual({ status: "skipped", reason: "demo" });
      expect(send).not.toHaveBeenCalled();
    });

    it("webhook: trial_will_end runs the reminder on first delivery only (duplicate delivery doesn't re-send)", async () => {
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_dummy_never_used");
      const event = { id: "evt_trial_will_end_1", type: "customer.subscription.trial_will_end", created: Math.floor(Date.now() / 1000), data: { object: { id: "sub_trial" } } };
      spies.push(vi.spyOn(stripeLib, "getStripe").mockReturnValue({ webhooks: { constructEventAsync: async () => event } } as never));
      const remind = vi.spyOn(trialReminder, "sendTrialEndingReminder").mockResolvedValue({ status: "sent", recipients: 2 });
      spies.push(remind);
      const post = () => webhookRoute.POST(new Request("http://localhost:3000/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: JSON.stringify(event) }));
      const first = await (await post()).json();
      expect(first).toMatchObject({ received: true, status: "processed" });
      const second = await (await post()).json();
      expect(second).toMatchObject({ status: "duplicate" });
      expect(remind).toHaveBeenCalledTimes(1);
      expect(remind.mock.calls[0][0]).toBe("sub_trial");
    });

    it("webhook: a failing reminder never fails the webhook", async () => {
      const event = { id: "evt_trial_will_end_2", type: "customer.subscription.trial_will_end", created: Math.floor(Date.now() / 1000), data: { object: { id: "sub_trial" } } };
      spies.push(vi.spyOn(stripeLib, "getStripe").mockReturnValue({ webhooks: { constructEventAsync: async () => event } } as never));
      spies.push(vi.spyOn(trialReminder, "sendTrialEndingReminder").mockRejectedValue(new Error("resend down")));
      spies.push(vi.spyOn(console, "error").mockImplementation(() => {}));
      const res = await webhookRoute.POST(new Request("http://localhost:3000/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: "{}" }));
      expect(res.status).toBe(200);
    });
  });
});
