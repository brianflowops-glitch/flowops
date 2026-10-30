// Webhook processing against a THROWAWAY local Postgres (never production), Stripe mocked (no network):
//   DATABASE_URL=postgres://…/scratch npm run test:billing:db
// Requires migrations applied to that database (npm run db:migrate) — uses the demo org.
import type Stripe from "stripe";
import { asc, eq, sql } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { processStripeEvent, type SubscriptionFetcher } from "../src/lib/billing/webhook";
import { getBillingAccess, requireBillingAccess } from "../src/lib/billing/access";
import { getEntitlements } from "../src/lib/billing/org-entitlements";
import { activePaidPacks, consumeTexts, purchaseTextPack, type PackStripe } from "../src/lib/billing/text-packs";
import { textPackExpiry } from "../src/lib/billing/text-pack-rules";
import type { ChargeContext } from "../src/lib/billing/clawback";
import { trialEligibility } from "../src/lib/billing/checkout";
import { subscriptionFields } from "../src/lib/billing/webhook";
import { DEMO_ORG_ID, defaultHours } from "../src/lib/tenancy/defaults";
import { AddonChangeBusy, AddonLockUnavailable, addonLockFailureResponse, dbAddonChargeLedger, sweepAddonCharges, withAddonChangeLock } from "../src/lib/billing/addon-charges-db";
import { Pool } from "pg";
import { connectSession, getSessionPool, isPoolTimeout, type SessionClient } from "../src/lib/db";
import { setAddonQuantity, setAddonQuantityUnderPolicy, type AddonStripe } from "../src/lib/billing/addons";

if (/neon\.tech|vercel|amazonaws/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against a hosted database");

let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
};
const n = Date.now();
const T0 = Math.floor(n / 1000);
const CUS = `cus_test_${n}`;

const sub = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    object: "subscription",
    customer: CUS,
    status,
    cancel_at_period_end: false,
    metadata: {},
    items: { data: [{ id: `si_${id}`, price: { id: "price_test_x" }, current_period_end: 1800000000 }] },
    ...extra,
  }) as unknown as Stripe.Subscription;

/** Mock Stripe: "current" state per subscription id, settable by the test. Counts calls. */
const stripeState = new Map<string, Stripe.Subscription>();
let fetches = 0;
const fetchSubscription: SubscriptionFetcher = async (id) => {
  fetches++;
  const s = stripeState.get(id);
  if (!s) throw new Error(`mock: no such subscription ${id}`);
  return s;
};

let evtSeq = 0;
const ev = (type: string, object: unknown, created = T0) =>
  ({ id: `evt_${n}_${++evtSeq}`, type, object: "event", created, data: { object } }) as unknown as Stripe.Event;
const run = (e: Stripe.Event) => processStripeEvent(e, { fetchSubscription });
const row = async (id: string) => (await getDb().select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, id)))[0];

const expectUnique = async (db: ReturnType<typeof getDb>, invoiceId: string) => {
  let threw = false;
  try {
    await db.insert(schema.textPack).values({ id: `tp_dup_${invoiceId}`, organizationId: DEMO_ORG_ID, packKey: "texts_1000", textsPerPack: 1000, quantity: 1, status: "pending", stripeInvoiceId: invoiceId, periodStart: new Date(), periodEnd: new Date() });
  } catch {
    threw = true;
  }
  check("text_pack: stripe_invoice_id is unique (one pack per invoice)", threw);
};

(async () => {
  const db = getDb();
  const S1 = `sub_test_${n}`;

  // ── basic lifecycle ──
  const r1 = await run(ev("checkout.session.completed", { id: "cs_test", client_reference_id: DEMO_ORG_ID, customer: CUS, metadata: {} }));
  check("checkout.session.completed processed", r1.status === "processed", r1);
  const [c] = await db.select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, DEMO_ORG_ID));
  check("customer linked to org", c?.stripeCustomerId === CUS, c);

  stripeState.set(S1, sub(S1, "active", { cancel_at_period_end: true }));
  const created = ev("customer.subscription.created", sub(S1, "incomplete"), T0);
  const r2 = await run(created);
  let s = await row(S1);
  check("subscription.created writes FETCHED state (active), not payload (incomplete)", r2.status === "processed" && s?.status === "active" && s.cancelAtPeriodEnd, s);
  check("current_period_end from item", s?.currentPeriodEnd?.getTime() === 1800000000 * 1000, s?.currentPeriodEnd);
  check("last_event_created stored", s?.lastEventCreated?.getTime() === T0 * 1000, s?.lastEventCreated);

  const before = fetches;
  const dup = await run(created);
  check("duplicate event id skipped without a Stripe call", dup.status === "duplicate" && fetches === before, { dup, fetches, before });

  // ── out of order: newer update delivered first, older one late ──
  const S2 = `sub_order_${n}`;
  stripeState.set(S2, sub(S2, "past_due"));
  const newer = ev("customer.subscription.updated", sub(S2, "past_due"), T0 + 20);
  const older = ev("customer.subscription.updated", sub(S2, "active"), T0 + 10);
  await run(newer);
  // Even if Stripe's read were stale for the late event, the timestamp guard must hold.
  stripeState.set(S2, sub(S2, "active"));
  const late = await run(older);
  s = await row(S2);
  check("reverse order: newer status (past_due) wins over late older event", s?.status === "past_due" && late.status === "stale", { s, late });
  check("reverse order: last_event_created stays at newer event", s?.lastEventCreated?.getTime() === (T0 + 20) * 1000, s?.lastEventCreated);

  // ── tie: same-second event → fetched (current) state wins ──
  stripeState.set(S2, sub(S2, "active"));
  const tie = await run(ev("invoice.paid", { id: "in_tie", parent: { subscription_details: { subscription: S2 } } }, T0 + 20));
  s = await row(S2);
  check("same-second tie: fetched state (active) overwrites", tie.status === "processed" && s?.status === "active", { tie, s });

  // ── invoice.payment_failed refreshes from Stripe ──
  stripeState.set(S2, sub(S2, "past_due"));
  await run(ev("invoice.payment_failed", { id: "in_pf", parent: { subscription_details: { subscription: S2 } } }, T0 + 30));
  s = await row(S2);
  check("invoice.payment_failed → fetched past_due written", s?.status === "past_due", s);
  const oneOff = await run(ev("invoice.paid", { id: "in_oneoff", parent: null }, T0 + 31));
  check("invoice without subscription just recorded", oneOff.status === "processed", oneOff);

  // ── canceled is terminal ──
  stripeState.set(S1, sub(S1, "canceled"));
  await run(ev("customer.subscription.deleted", sub(S1, "canceled"), T0 + 40));
  s = await row(S1);
  check("subscription.deleted → canceled", s?.status === "canceled", s);
  stripeState.set(S1, sub(S1, "active"));
  const resurrect = await run(ev("customer.subscription.updated", sub(S1, "active"), T0 + 50));
  s = await row(S1);
  check("canceled stays canceled even for a newer event", s?.status === "canceled" && resurrect.status === "stale", { s, resurrect });

  // ── failures roll back / don't record the event ──
  const S3 = `sub_orphan_${n}`;
  stripeState.set(S3, { ...sub(S3, "active"), customer: `cus_unknown_${n}` } as Stripe.Subscription);
  const orphanEv = ev("customer.subscription.updated", sub(S3, "active"));
  let threw = false;
  try {
    await run(orphanEv);
  } catch {
    threw = true;
  }
  let [e] = await db.select().from(schema.stripeEvent).where(eq(schema.stripeEvent.id, orphanEv.id));
  check("unknown org → error and event NOT recorded (Stripe retries)", threw && !e);

  const failEv = ev("customer.subscription.updated", sub(`sub_missing_${n}`, "active"));
  threw = false;
  try {
    await run(failEv);
  } catch {
    threw = true;
  }
  [e] = await db.select().from(schema.stripeEvent).where(eq(schema.stripeEvent.id, failEv.id));
  check("Stripe retrieve fails → error, event NOT recorded", threw && !e);

  const ign = await run(ev("charge.succeeded", {}));
  check("unhandled type ignored", ign.status === "ignored", ign);

  // ── billing access lock: failed card → locked, paid → full (docs/BILLING.md §6) ──
  const ORG = `org_lock_${n}`;
  await db.insert(schema.organization).values({ id: ORG, slug: `lock-${n}`, name: "Lock test", hours: defaultHours() });
  const ON = { BILLING_ENABLED: "true" };
  const access = (role: "owner" | "admin" | "staff" = "owner", env: Record<string, string> = ON) => getBillingAccess(ORG, role, { env });
  let a = await access();
  check("lock: no subscription row → locked/no_subscription", a.access === "locked" && a.reason === "no_subscription" && a.status === null, a);
  a = await access("owner", { ...ON, BILLING_EXEMPT_ORG_IDS: `org_other,${ORG}` });
  check("lock: org in BILLING_EXEMPT_ORG_IDS → full/exempt", a.access === "full" && a.reason === "exempt", a);
  a = await access("owner", {});
  check("lock: BILLING_ENABLED off → full/billing_disabled", a.access === "full" && a.reason === "billing_disabled", a);


  // is_demo orgs always have access (same orgs the add-on cron skips); read from the DB or from the passed org row.
  const DORG = `org_lockdemo_${n}`;
  await db.insert(schema.organization).values({ id: DORG, slug: `lockdemo-${n}`, name: "Lock demo test", hours: defaultHours(), isDemo: true });
  a = await getBillingAccess(DORG, "staff", { env: ON });
  check("lock: is_demo org (id, looked up), no subscription → full/demo", a.access === "full" && a.reason === "demo" && a.status === null, a);
  a = await getBillingAccess({ id: DORG, isDemo: true }, "owner", { env: ON });
  check("lock: is_demo org (row passed) → full/demo", a.access === "full" && a.reason === "demo", a);
  await db.insert(schema.subscription).values({ id: `subrow_demo_${n}`, organizationId: DORG, stripeSubscriptionId: `sub_demo_${n}`, status: "past_due" });
  a = await getBillingAccess(DORG, "owner", { env: ON });
  check("lock: is_demo org with past_due → still full/demo", a.access === "full" && a.reason === "demo" && a.status === "past_due", a);
  a = await getBillingAccess(DORG, "owner", { env: {} });
  check("lock: is_demo org, BILLING_ENABLED off → full/billing_disabled", a.access === "full" && a.reason === "billing_disabled", a);
  a = await getBillingAccess({ id: ORG, isDemo: false }, "owner", { env: ON });
  check("lock: non-demo org (row passed), no subscription → locked/no_subscription", a.access === "locked" && a.reason === "no_subscription", a);
  {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    const [demoRow] = await db.select().from(schema.organization).where(eq(schema.organization.id, DORG));
    check("guard: is_demo org passes requireBillingAccess (no 402)", (await requireBillingAccess(new Request("http://localhost/api/state"), { org: demoRow, role: "staff" })) === null);
    const [plainRow] = await db.select().from(schema.organization).where(eq(schema.organization.id, ORG));
    const g0 = await requireBillingAccess(new Request("http://localhost/api/state"), { org: plainRow, role: "owner" });
    check("guard: non-demo org with no subscription → 402 no_subscription", g0?.status === 402 && (await g0.json())?.reason === "no_subscription");
    if (prev === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = prev;
  }
  await db.delete(schema.organization).where(eq(schema.organization.id, DORG)); // test org only (cascades its subscription row)

  const SL = `sub_lock_${n}`;
  const lockSub = (status: string) => sub(SL, status, { customer: `cus_lock_${n}`, metadata: { organizationId: ORG } });
  stripeState.set(SL, lockSub("active"));
  await run(ev("customer.subscription.created", lockSub("active"), T0 + 100));
  a = await access();
  check("lock: active subscription → full/ok", a.access === "full" && a.reason === "ok" && a.status === "active", a);

  const invoice = (id: string) => ({ id, object: "invoice", customer: `cus_lock_${n}`, parent: { subscription_details: { subscription: SL } } });
  stripeState.set(SL, lockSub("past_due"));
  const failRes = await run(ev("invoice.payment_failed", invoice(`in_fail_${n}`), T0 + 110));
  a = await access("owner");
  check("lock: invoice.payment_failed webhook → past_due → locked", failRes.status === "processed" && a.access === "locked" && a.reason === "past_due", { failRes, a });
  check("lock: Owner can still manage billing while locked", a.canManageBilling === true, a);
  check("lock: Admin can still manage billing while locked", (await access("admin")).canManageBilling === true);
  check("lock: Staff is locked and cannot manage billing", (await access("staff")).access === "locked" && (await access("staff")).canManageBilling === false);

  // Shared guard (requireApi calls this): 402 on normal API routes, billing/auth routes exempt.
  const prevFlag = process.env.BILLING_ENABLED;
  process.env.BILLING_ENABLED = "true";
  const ctxLike = { org: { id: ORG } as typeof schema.organization.$inferSelect, role: "admin" as const };
  const g = await requireBillingAccess(new Request("http://localhost/api/state"), ctxLike);
  const gBody = g ? await g.json() : null;
  check("guard: locked org → 402 {error:billing_locked, reason:past_due}", g?.status === 402 && gBody?.error === "billing_locked" && gBody?.reason === "past_due", gBody);
  check("guard: /api/billing/portal exempt while locked", (await requireBillingAccess(new Request("http://localhost/api/billing/portal"), ctxLike)) === null);
  check("guard: /api/auth/sign-out exempt while locked", (await requireBillingAccess(new Request("http://localhost/api/auth/sign-out"), ctxLike)) === null);
  check("guard: /api/billing/webhook exempt while locked", (await requireBillingAccess(new Request("http://localhost/api/billing/webhook"), ctxLike)) === null);

  const [orgStill] = await db.select().from(schema.organization).where(eq(schema.organization.id, ORG));
  check("lock: org data kept while locked (nothing deleted)", Boolean(orgStill) && Boolean(await row(SL)));

  stripeState.set(SL, lockSub("active"));
  const paidRes = await run(ev("invoice.paid", invoice(`in_paid_${n}`), T0 + 120));
  a = await access();
  check("lock: invoice.paid webhook → active → full again", paidRes.status === "processed" && a.access === "full" && a.reason === "ok", { paidRes, a });
  check("guard: paid org passes", (await requireBillingAccess(new Request("http://localhost/api/state"), ctxLike)) === null);

  stripeState.set(SL, lockSub("unpaid"));
  await run(ev("customer.subscription.updated", lockSub("unpaid"), T0 + 130));
  a = await access();
  check("lock: unpaid → locked/unpaid", a.access === "locked" && a.reason === "unpaid", a);
  stripeState.set(SL, lockSub("canceled"));
  await run(ev("customer.subscription.deleted", lockSub("canceled"), T0 + 140));
  a = await access();
  check("lock: canceled → locked/canceled", a.access === "locked" && a.reason === "canceled", a);
  if (prevFlag === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = prevFlag;
  await db.delete(schema.organization).where(eq(schema.organization.id, ORG)); // test org only (cascades its subscription rows)

  // ── add-ons: plan item by price id, item mirroring, entitlements (docs/BILLING.md §11) ──
  const envPrev = { ...process.env };
  Object.assign(process.env, {
    STRIPE_PRICE_STARTER: "price_t_starter", STRIPE_PRICE_PRO: "price_t_pro",
    STRIPE_ADDON_PRICE_SEAT: "price_t_seat", STRIPE_ADDON_PRICE_LOCATION: "price_t_loc", STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000: "price_t_t1k", STRIPE_ADDON_PRICE_TEXTS_1000: "price_t_pack", STRIPE_ADDON_PRICE_BRANDING: "price_t_brand",
  });
  delete process.env.PLAN_LIMITS_STARTER;
  delete process.env.PLAN_LIMITS_PRO;
  const AORG = `org_addon_${n}`;
  await db.insert(schema.organization).values({ id: AORG, slug: `addon-${n}`, name: "Add-on test", hours: defaultHours() });
  const SA = `sub_addon_${n}`;
  type It = { id: string; price: string; q?: number };
  const asub = (status: string, items: It[], extra: Record<string, unknown> = {}) =>
    ({
      id: SA, object: "subscription", customer: `cus_addon_${n}`, status, cancel_at_period_end: false, metadata: { organizationId: AORG },
      items: { data: items.map((i) => ({ id: i.id, price: { id: i.price }, quantity: i.q ?? 1, current_period_end: 1800000000 })), has_more: false }, ...extra,
    }) as unknown as Stripe.Subscription;
  const items = async () => {
    const [sr] = await db.select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, SA));
    return sr ? (await db.select().from(schema.subscriptionItem).where(eq(schema.subscriptionItem.subscriptionId, sr.id)).orderBy(asc(schema.subscriptionItem.stripeItemId))).map((i) => `${i.stripeItemId}:${i.priceId}:${i.quantity}`) : [];
  };
  const ent = async (e: Record<string, string> = { BILLING_ENABLED: "true" }) => getEntitlements(AORG, { env: { ...process.env, ...e } });
  const plain = (r: Awaited<ReturnType<typeof ent>>) => (r.enforced ? { reason: r.reason, seats: r.entitlements.seats, locations: r.entitlements.locations, texts: r.entitlements.monthlyTexts, branding: r.entitlements.brandingRemoved, plan: r.entitlements.planKey } : r);
  const AT = T0 + 1000;
  const ae = ev;

  let r = await ent();
  check("entitlements: no subscription → enforced, all zero", r.enforced && r.reason === "no_subscription" && r.entitlements.seats === 0 && r.entitlements.monthlyTexts === 0, r);

  // Add-on item listed FIRST: the plan must still be identified by price id (not items[0]).
  stripeState.set(SA, asub("active", [{ id: "si_seat", price: "price_t_seat", q: 2 }, { id: "si_plan", price: "price_t_starter" }]));
  await run(ae("customer.subscription.created", asub("active", []), AT));
  s = await row(SA);
  check("webhook: subscription.price_id is the PLAN price even when an add-on is items[0]", s?.priceId === "price_t_starter", s);
  check("webhook: all items mirrored with quantities", JSON.stringify(await items()) === JSON.stringify(["si_plan:price_t_starter:1", "si_seat:price_t_seat:2"]), await items());
  check("subscriptionFields: plan item's price from env mapping", subscriptionFields(asub("active", [{ id: "a", price: "price_t_loc" }, { id: "b", price: "price_t_pro" }])).priceId === "price_t_pro");
  r = await ent();
  check("entitlements: starter + 2 seats = 5 seats / 1 location / 500 texts", JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 5, locations: 1, texts: 500, branding: false, plan: "starter" }), plain(r));
  check("entitlements: billing off → not enforced", JSON.stringify(await ent({})) === JSON.stringify({ enforced: false, reason: "billing_disabled" }));
  check("entitlements: exempt org → not enforced", JSON.stringify(await ent({ BILLING_ENABLED: "true", BILLING_EXEMPT_ORG_IDS: AORG })) === JSON.stringify({ enforced: false, reason: "exempt" }));
  const ov = await ent({ BILLING_ENABLED: "true", PLAN_LIMITS_STARTER: "seats=4" });
  check("entitlements: PLAN_LIMITS_STARTER override applies (4 + 2 seats)", ov.enforced && ov.entitlements.seats === 6, ov);

  const dupAdd = ae("customer.subscription.updated", asub("active", []), AT + 10);
  stripeState.set(SA, asub("active", [{ id: "si_plan", price: "price_t_starter" }, { id: "si_seat", price: "price_t_seat", q: 3 }, { id: "si_t", price: "price_t_t1k", q: 2 }, { id: "si_b", price: "price_t_brand" }]));
  await run(dupAdd);
  check("webhook: quantity change + new add-ons mirrored", JSON.stringify(await items()) === JSON.stringify(["si_b:price_t_brand:1", "si_plan:price_t_starter:1", "si_seat:price_t_seat:3", "si_t:price_t_t1k:2"]), await items());
  r = await ent();
  check("entitlements: starter + 3 seats + 2×1000 texts + branding = 6/1/2500/branding", JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 6, locations: 1, texts: 2500, branding: true, plan: "starter" }), plain(r));
  const before2 = fetches;
  const dd = await run(dupAdd);
  check("webhook: duplicate add-on event skipped (no Stripe call, items unchanged)", dd.status === "duplicate" && fetches === before2 && (await items()).length === 4);

  // Out of order: a late OLDER event must not rewrite items, even if Stripe's read were stale.
  stripeState.set(SA, asub("active", [{ id: "si_plan", price: "price_t_starter" }]));
  const lateOld = await run(ae("customer.subscription.updated", asub("active", []), AT + 5));
  check("webhook: late older event is stale and leaves add-on items untouched", lateOld.status === "stale" && (await items()).length === 4, { lateOld, items: await items() });

  // Removal prunes; newer event wins.
  const rm = await run(ae("customer.subscription.updated", asub("active", []), AT + 20));
  check("webhook: removed add-on items are pruned", rm.status === "processed" && JSON.stringify(await items()) === JSON.stringify(["si_plan:price_t_starter:1"]), await items());
  r = await ent();
  check("entitlements: back to plain starter after removal", JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 3, locations: 1, texts: 500, branding: false, plan: "starter" }), plain(r));

  // Same-second tie: fetched state wins (existing rule) and items follow it.
  stripeState.set(SA, asub("active", [{ id: "si_plan", price: "price_t_starter" }, { id: "si_loc", price: "price_t_loc", q: 1 }]));
  const tie2 = await run(ev("invoice.paid", { id: "in_tie2", parent: { subscription_details: { subscription: SA } } }, AT + 20));
  check("webhook: same-second tie → fetched items win", tie2.status === "processed" && JSON.stringify(await items()) === JSON.stringify(["si_loc:price_t_loc:1", "si_plan:price_t_starter:1"]), { tie2, items: await items() });

  // has_more: never prune from a truncated list.
  const trunc = asub("active", [{ id: "si_plan", price: "price_t_starter" }]);
  (trunc.items as { has_more: boolean }).has_more = true;
  stripeState.set(SA, trunc);
  await run(ev("customer.subscription.updated", trunc, AT + 25));
  check("webhook: truncated item list (has_more) does not prune existing items", (await items()).length === 2, await items());

  // Plan change (Starter → Pro) keeps add-ons; entitlements follow.
  stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 5 }]));
  await run(ev("customer.subscription.updated", asub("active", []), AT + 30));
  s = await row(SA);
  r = await ent();
  check("webhook: plan swap → price_id = pro, items replaced", s?.priceId === "price_t_pro" && JSON.stringify(await items()) === JSON.stringify(["si_plan2:price_t_pro:1", "si_seat:price_t_seat:5"]), { s, items: await items() });
  check("entitlements: pro + 5 seats = 15 / 1 / 2000 / branding", JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 15, locations: 1, texts: 2000, branding: true, plan: "pro" }), plain(r));

  // A decrease scheduled for the renewal (subscription schedule attached, next phase lower): the mirror and the
  // entitlements keep the CURRENT quantity until the renewal event delivers the new items.
  stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 5 }, { id: "si_t", price: "price_t_t1k", q: 2 }], { schedule: "sub_sched_test" }));
  const schedEv = await run(ev("customer.subscription.updated", asub("active", []), AT + 32));
  r = await ent();
  check("scheduled decrease: schedule attached, items unchanged → entitlements still 15 seats / 4000 texts", schedEv.status === "processed" && JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 15, locations: 1, texts: 4000, branding: true, plan: "pro" }), plain(r));
  stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 2 }]));
  await run(ev("customer.subscription.updated", asub("active", []), AT + 34));
  r = await ent();
  check("renewal event applies the scheduled decrease: seat 5 → 2 and the texts bundle pruned → 12 seats / 2000 texts", JSON.stringify(await items()) === JSON.stringify(["si_plan2:price_t_pro:1", "si_seat:price_t_seat:2"]) && JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 12, locations: 1, texts: 2000, branding: true, plan: "pro" }), { items: await items(), r: plain(r) });

  // A quantity above the cap mirrored from Stripe (set directly there, bypassing our route) never grants more than the cap.
  stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 1000 }, { id: "si_loc", price: "price_t_loc", q: 99 }, { id: "si_t", price: "price_t_t1k", q: 1000 }, { id: "si_b", price: "price_t_brand", q: 7 }]));
  const capEv = await run(ev("customer.subscription.updated", asub("active", []), AT + 36));
  r = await ent();
  check("add-on caps: the mirror keeps the raw quantities (seat 1000, texts_1000 1000)", capEv.status === "processed" && JSON.stringify(await items()) === JSON.stringify(["si_b:price_t_brand:7", "si_loc:price_t_loc:99", "si_plan2:price_t_pro:1", "si_seat:price_t_seat:1000", "si_t:price_t_t1k:1000"]), await items());
  check("add-on caps: entitlements clamp to the defaults (pro 10 + 50 seats, 1 + 10 locations, 2000 + 10×1000 texts)", JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 60, locations: 11, texts: 12000, branding: true, plan: "pro" }), plain(r));
  r = await ent({ BILLING_ENABLED: "true", STRIPE_ADDON_MAX_SEAT: "20", STRIPE_ADDON_MAX_TEXTS_1000: "bad" });
  check("add-on caps: STRIPE_ADDON_MAX_SEAT=20 applies; an invalid override falls back to the default", r.enforced && r.entitlements.seats === 30 && r.entitlements.monthlyTexts === 12000, r);
  stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 2 }]));
  await run(ev("customer.subscription.updated", asub("active", []), AT + 38));
  r = await ent();
  check("add-on caps: lowering the mirrored quantity below the cap grants exactly that (12 seats)", r.enforced && r.entitlements.seats === 12 && r.entitlements.monthlyTexts === 2000, plain(r));

  // ── one-time text packs (docs/BILLING.md §11): paid-only grants, cap per period, trial, webhook settlement ──
  // State here: pro + 2 seats, active → 12 seats / 2000 texts. Stripe is a stateful fake.
  {
    const nowD = new Date();
    const nowS = Math.floor(nowD.getTime() / 1000);
    let packSeq = 0;
    type FInv = { id: string; status: string; amount_paid: number; currency: string; params: Stripe.InvoiceCreateParams; items: Stripe.InvoiceItemCreateParams[] };
    const mkPackStripe = (o: { decline?: boolean; pm?: string | null; customerPm?: string | null; trialing?: boolean; failAfterCharge?: boolean } = {}) => {
      const invs = new Map<string, FInv>();
      const log: string[] = [];
      const subObj = { id: SA, status: o.trialing ? "trialing" : "active", default_payment_method: o.pm === undefined ? "pm_card" : o.pm, items: { data: [{ id: "si_plan2", current_period_start: nowS - 10 * 86400, current_period_end: nowS + 20 * 86400 }] } } as unknown as Stripe.Subscription;
      const stripe: PackStripe = {
        subscriptions: { retrieve: async () => subObj },
        customers: { retrieve: async () => ({ id: "cus_x", invoice_settings: { default_payment_method: o.customerPm ?? null } }) as unknown as Stripe.Customer },
        invoices: {
          create: async (params) => { const id = `in_pack_${n}_${++packSeq}`; invs.set(id, { id, status: "draft", amount_paid: 0, currency: "usd", params, items: [] }); log.push("invoice.create"); return { id, status: "draft" } as Stripe.Invoice; },
          finalizeInvoice: async (id) => { invs.get(id)!.status = "open"; log.push("finalize"); return { id, status: "open" } as Stripe.Invoice; },
          pay: async (id, p) => {
            log.push(`pay ${p?.payment_method}`);
            const inv = invs.get(id)!;
            if (o.decline) throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", rawType: "card_error", code: "card_declined" });
            inv.status = "paid"; inv.amount_paid = 1500 * Number((inv.params.metadata as Record<string, string>).quantity);
            if (o.failAfterCharge) throw new Error("socket hang up after the charge");
            return { id, status: "paid", amount_paid: inv.amount_paid, currency: "usd" } as Stripe.Invoice;
          },
          retrieve: async (id) => ({ ...invs.get(id)! }) as unknown as Stripe.Invoice,
          voidInvoice: async (id) => { invs.get(id)!.status = "void"; log.push("void"); return {} as Stripe.Invoice; },
          del: async (id) => { invs.get(id)!.status = "deleted"; log.push("delete"); return {}; },
        },
        invoiceItems: { create: async (p) => { const inv = [...invs.values()].find((i) => i.id === p.invoice)!; inv.items.push(p); log.push("item"); return {} as Stripe.InvoiceItem; } },
      };
      return { stripe, invs, log };
    };
    const buy = (fake: ReturnType<typeof mkPackStripe>, quantity: number, subStatus = "active", pack = "texts_1000") =>
      purchaseTextPack({ stripe: fake.stripe, db, orgId: AORG, customerId: "cus_x", subscription: { id: SA, status: subStatus as Stripe.Subscription.Status }, pack, quantity, now: nowD });
    const packRows = async () => (await db.select().from(schema.textPack).where(eq(schema.textPack.organizationId, AORG))).map((x) => `${x.status}:${x.quantity}`).sort();
    const texts = async () => { const x = await ent(); return x.enforced ? x.entitlements.monthlyTexts : -1; };

    check("packs: before any purchase → plan texts only (2000)", (await texts()) === 2000);

    // paid → granted
    let f = mkPackStripe();
    let pr = await buy(f, 2);
    const inv1 = [...f.invs.values()][0];
    check("pack paid: ok, texts 2000, charged in full as its own invoice (one item, price_t_pack × 2), paid with the card on file, auto_advance off", pr.ok && pr.texts === 2000 && pr.amountPaid === 3000 && inv1.items.length === 1 && inv1.items[0].quantity === 2 && JSON.stringify(inv1.items[0].pricing) === JSON.stringify({ price: "price_t_pack" }) && inv1.params.auto_advance === false && inv1.params.collection_method === "charge_automatically" && f.log.join(",") === "invoice.create,item,finalize,pay pm_card", { pr, log: f.log });
    check("pack paid: row is paid, entitlements = plan 2000 + 2000", JSON.stringify(await packRows()) === '["paid:2"]' && (await texts()) === 4000, await packRows());
    const expectExpiry = textPackExpiry(new Date((nowS - 10 * 86400) * 1000), new Date((nowS + 20 * 86400) * 1000), nowD);
    check("pack paid: bought in this window (windowEnd = period end), usable until the end of the NEXT window (validUntil = rollover expiry)", pr.ok && pr.windowEnd === new Date((nowS + 20 * 86400) * 1000).toISOString() && pr.validUntil === expectExpiry.toISOString() && expectExpiry.getTime() > (nowS + 45 * 86400) * 1000 && !pr.duringTrial, { pr, expectExpiry });
    const [paidRow] = await db.select().from(schema.textPack).where(eq(schema.textPack.organizationId, AORG));
    check("pack paid: the row stores expires_at (rollover) and texts_used 0", paidRow?.expiresAt?.toISOString() === expectExpiry.toISOString() && paidRow.textsUsed === 0, paidRow);

    // declined card → nothing granted, invoice voided, no pending/active pack left
    f = mkPackStripe({ decline: true });
    pr = await buy(f, 3);
    const invD = [...f.invs.values()][0];
    check("pack declined: 402 payment_failed pointing at the portal, nothing charged", !pr.ok && pr.status === 402 && pr.code === "payment_failed" && pr.portal === true, pr);
    check("pack declined: the unpaid invoice is VOIDED (cannot be paid later)", invD.status === "void" && f.log.includes("void"), { st: invD.status, log: f.log });
    check("pack declined: row failed, no pending pack, entitlements unchanged (4000)", JSON.stringify(await packRows()) === '["failed:3","paid:2"]' && (await texts()) === 4000, await packRows());
    // a declined attempt does not use up the cap
    f = mkPackStripe();
    pr = await buy(f, 8);
    check("pack cap: a failed attempt doesn't count; 2 + 8 = 10 is allowed", pr.ok && (await texts()) === 2000 + 10000, { pr, t: await texts() });
    f = mkPackStripe();
    pr = await buy(f, 1);
    check("pack cap: the 11th pack in the period → 400 with a clear message, nothing created in Stripe", !pr.ok && pr.status === 400 && pr.code === "cap" && /At most 10/.test(pr.error) && f.log.length === 0, { pr, log: f.log });
    pr = await buy(mkPackStripe(), 11);
    check("pack cap: quantity above the cap in one request → 400", !pr.ok && pr.status === 400, pr);
    check("pack cap: rows after all that", JSON.stringify(await packRows()) === '["failed:3","paid:2","paid:8"]', await packRows());
    await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));
    check("packs gone → back to 2000", (await texts()) === 2000);

    // concurrent purchases can't both slip under the cap
    const fa = mkPackStripe(), fb = mkPackStripe();
    const [ra, rb] = await Promise.all([buy(fa, 6), buy(fb, 6)]);
    check("pack cap: two simultaneous 6-pack purchases → exactly one succeeds", [ra, rb].filter((x) => x.ok).length === 1 && [ra, rb].filter((x) => !x.ok && x.code === "cap").length === 1, { ra, rb });
    await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));

    // no payment method → 402, nothing created
    f = mkPackStripe({ pm: null, customerPm: null });
    pr = await buy(f, 1);
    check("pack without a payment method → 402 no_payment_method (portal), no Stripe invoice, no row", !pr.ok && pr.status === 402 && pr.code === "no_payment_method" && f.log.length === 0 && (await packRows()).length === 0, { pr, log: f.log });
    f = mkPackStripe({ pm: null, customerPm: "pm_cust" });
    pr = await buy(f, 1);
    check("pack: falls back to the customer's default payment method", pr.ok && f.log.includes("pay pm_cust"), { pr, log: f.log });
    await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));

    // trial: charged in full immediately, never free or deferred
    f = mkPackStripe({ trialing: true });
    pr = await buy(f, 1, "trialing");
    check("pack during a trial: charged in full NOW on its own invoice (paid before granting), duringTrial flagged", pr.ok && pr.amountPaid === 1500 && pr.duringTrial && [...f.invs.values()][0].status === "paid" && f.log.at(-1)!.startsWith("pay "), { pr, log: f.log });
    f = mkPackStripe({ trialing: true, pm: null });
    pr = await buy(f, 1, "trialing");
    check("pack during a trial without a payment method → 402, nothing granted", !pr.ok && pr.status === 402 && pr.code === "no_payment_method", pr);
    await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));

    // not an active subscription
    for (const st of ["past_due", "canceled", "unpaid", "incomplete", "paused"]) {
      pr = await buy(mkPackStripe(), 1, st);
      check(`pack on a ${st} subscription → 409, nothing created`, !pr.ok && pr.status === 409 && (await packRows()).length === 0, pr);
    }
    pr = await buy(mkPackStripe(), 1, "active", "seat");
    check("pack: an unknown pack key (seat) → 400", !pr.ok && pr.status === 400, pr);

    // timeout after Stripe actually collected → we see it's paid and grant (no double charge, no missing texts)
    f = mkPackStripe({ failAfterCharge: true });
    pr = await buy(f, 1);
    check("pack: network error after the charge went through → reconciled as paid and granted", pr.ok && (await packRows()).join() === "paid:1" && (await texts()) === 3000, { pr, rows: await packRows() });
    await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));

    // grants only for paid rows inside their window
    const win = (a: number, b: number) => ({ periodStart: new Date(nowD.getTime() + a * 86400000), periodEnd: new Date(nowD.getTime() + b * 86400000) });
    const mkRow = (id: string, status: string, a: number, b: number, extra: Record<string, unknown> = {}) => db.insert(schema.textPack).values({ id, organizationId: AORG, packKey: "texts_1000", textsPerPack: 1000, quantity: 1, status, ...win(a, b), ...extra } as typeof schema.textPack.$inferInsert);
    await mkRow(`tp_a_${n}`, "pending", -1, 20, { stripeInvoiceId: `in_pend_${n}` });
    await mkRow(`tp_b_${n}`, "failed", -1, 20);
    await mkRow(`tp_c_${n}`, "paid", -40, -10); // an earlier period
    await mkRow(`tp_d_${n}`, "paid", 10, 40); // a later window
    check("entitlements: pending, failed, expired and future-window packs grant nothing", (await texts()) === 2000, await texts());
    await mkRow(`tp_e_${n}`, "paid", -1, 20);
    check("entitlements: a paid pack inside its window grants 1000", (await texts()) === 3000, await texts());

    // webhook settlement (the pending row above has invoice in_pend_<n>)
    const pend = { id: `in_pend_${n}`, amount_paid: 1500, metadata: { flowops_text_pack: `tp_a_${n}` } };
    const wf0 = fetches;
    let wr = await run(ev("invoice.paid", pend, AT + 100));
    check("webhook invoice.paid on a pack invoice → pack paid (no subscription fetch)", wr.status === "processed" && fetches === wf0 && (await texts()) === 4000, { wr, t: await texts() });
    const evd = ev("invoice.paid", pend, AT + 101);
    await run(evd);
    wr = await run(evd);
    check("webhook: duplicate pack event deduped; replays don't double-grant", wr.status === "duplicate" && (await texts()) === 4000, wr);
    await run(ev("invoice.payment_failed", pend, AT + 102));
    check("webhook: a late payment_failed never downgrades a paid pack", (await texts()) === 4000, await texts());
    await mkRow(`tp_f_${n}`, "pending", -1, 20, { stripeInvoiceId: `in_fail_${n}` });
    await run(ev("invoice.payment_failed", { id: `in_fail_${n}`, metadata: { flowops_text_pack: `tp_f_${n}` } }, AT + 103));
    const [ff] = await db.select().from(schema.textPack).where(eq(schema.textPack.id, `tp_f_${n}`));
    check("webhook invoice.payment_failed on a pack → pack failed, nothing granted", ff?.status === "failed" && (await texts()) === 4000, ff);
    await mkRow(`tp_g_${n}`, "pending", -1, 20, { stripeInvoiceId: `in_unpaid_${n}` });
    await run(ev("invoice.paid", { id: `in_unpaid_${n}`, amount_paid: 1500, metadata: { flowops_text_pack: `tp_g_${n}` } }, AT + 104));
    await run(ev("invoice.payment_failed", { id: `in_unpaid_${n}`, metadata: { flowops_text_pack: `tp_g_${n}` } }, AT + 105));
    check("webhook: a pack that was marked failed but Stripe later reports paid is recovered", (await texts()) === 5000, await texts());
    await expectUnique(db, `in_pend_${n}`);
    await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));

    // ── 0004 rollover: a pack is usable in its window and ONE more, then expires; plan allowance first, then packs soonest-expiring first ──
    {
      const D = (days: number) => new Date(nowD.getTime() + days * 86400000);
      const at = (d: Date) => getEntitlements(AORG, { env: { ...process.env, BILLING_ENABLED: "true" }, now: d });
      const txt = async (d: Date) => { const x = await at(d); return x.enforced ? x.entitlements.monthlyTexts : -1; };
      // Pack bought in window N = [-10d, +20d), rollover window N+1 = [+20d, +50d) → expires at +50d.
      await mkRow(`tp_r1_${n}`, "paid", -10, 20, { expiresAt: D(50), createdAt: D(-5) });
      check("rollover: usable in its own window (N)", (await txt(D(0))) === 3000, await txt(D(0)));
      check("rollover: still usable in the next window (N+1), incl. 1 ms before expiry", (await txt(D(25))) === 3000 && (await txt(new Date(D(50).getTime() - 1))) === 3000);
      check("rollover: expired at the end of N+1 (exactly one extra period)", (await txt(D(50))) === 2000 && (await txt(D(60))) === 2000);
      const lateRow = await db.select().from(schema.textPack).where(eq(schema.textPack.id, `tp_r1_${n}`));
      check("rollover: a row from before 0010 (expires_at null) expires with its own window", (await db.update(schema.textPack).set({ expiresAt: null }).where(eq(schema.textPack.id, `tp_r1_${n}`)).returning({ id: schema.textPack.id })).length === 1 && (await txt(D(0))) === 3000 && (await txt(D(25))) === 2000, lateRow);
      await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));

      // Rolled-over pack (bought last window, expires at +20d) + this window's pack (expires at +50d).
      await mkRow(`tp_old_${n}`, "paid", -40, -10, { expiresAt: D(20), createdAt: D(-30) });
      await mkRow(`tp_new_${n}`, "paid", -10, 20, { expiresAt: D(50), createdAt: D(-2) });
      check("rollover: both packs usable now → 2000 plan + 2000 pack texts", (await txt(D(0))) === 4000);
      let c = await consumeTexts(db, { orgId: AORG, allowance: 2000, sentBefore: 1500, count: 400, now: D(0) });
      check("consumption: within the plan allowance → nothing drawn from packs", c.fromPlan === 400 && c.fromPacks.length === 0 && c.denied === 0, c);
      c = await consumeTexts(db, { orgId: AORG, allowance: 2000, sentBefore: 1990, count: 500, now: D(0) });
      check("consumption: plan allowance first (10), then the SOONEST-EXPIRING pack (the rolled-over one) for 490", c.fromPlan === 10 && JSON.stringify(c.fromPacks) === JSON.stringify([{ id: `tp_old_${n}`, texts: 490 }]) && c.denied === 0, c);
      c = await consumeTexts(db, { orgId: AORG, allowance: 2000, sentBefore: 2500, count: 700, now: D(0) });
      check("consumption: the rolled-over pack is emptied (510) before the new one is touched (190)", JSON.stringify(c.fromPacks) === JSON.stringify([{ id: `tp_old_${n}`, texts: 510 }, { id: `tp_new_${n}`, texts: 190 }]), c);
      const left = await activePaidPacks(db, AORG, D(0));
      check("consumption: texts_used persisted; remaining 0 + 810; entitlements show only unused pack texts", JSON.stringify(left.map((p) => [p.id, p.remaining])) === JSON.stringify([[`tp_old_${n}`, 0], [`tp_new_${n}`, 810]]) && (await txt(D(0))) === 2000 + 810, left);
      c = await consumeTexts(db, { orgId: AORG, allowance: 2000, sentBefore: 3200, count: 1000, now: D(0) });
      check("consumption: more than the packs hold → denied, nothing drawn", c.denied === 190 && c.fromPacks.length === 0 && (await activePaidPacks(db, AORG, D(0))).find((p) => p.id === `tp_new_${n}`)?.remaining === 810, c);
      const [c1, c2] = await Promise.all([1, 2].map(() => consumeTexts(db, { orgId: AORG, allowance: 0, sentBefore: 0, count: 500, now: D(0) })));
      check("consumption: two concurrent 500-text draws on 810 left → exactly one succeeds (row lock), never overdrawn", [c1, c2].filter((x) => x.denied === 0).length === 1 && (await activePaidPacks(db, AORG, D(0))).find((p) => p.id === `tp_new_${n}`)?.remaining === 310, { c1, c2 });
      check("consumption: after the rolled-over pack expires only the newer pack's unused texts count", (await txt(D(25))) === 2000 + 310);
      await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));

      // Cap with rollover: packs bought LAST window don't count toward this window's cap.
      const curStart = new Date((nowS - 10 * 86400) * 1000);
      await db.insert(schema.textPack).values({ id: `tp_cap_${n}`, organizationId: AORG, packKey: "texts_1000", textsPerPack: 1000, quantity: 10, status: "paid", periodStart: new Date(curStart.getTime() - 30 * 86400000), periodEnd: curStart, expiresAt: D(20) });
      const pc = await buy(mkPackStripe(), 10);
      check("rollover cap: 10 rolled-over packs + 10 new ones in this window are both allowed and both usable (2000 + 20000)", pc.ok && (await texts()) === 2000 + 20000, { pc, t: await texts() });
      const pc2 = await buy(mkPackStripe(), 1);
      check("rollover cap: the 11th pack bought in THIS window is still refused", !pc2.ok && pc2.code === "cap", pc2);
      await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));
    }

    // ── 0012 clawback: charge.refunded / charge.dispute.* on a pack's charge revoke (or restore) its texts ──
    {
      const charges = new Map<string, ChargeContext>();
      const setCharge = (id: string, c: Partial<ChargeContext>) => charges.set(id, { chargeId: id, amount: 1500, amountRefunded: 0, refunded: false, invoiceIds: [], disputeStatuses: [], ...charges.get(id), ...c });
      let chargeFetches = 0;
      const fetchChargeContext = async (id: string) => { chargeFetches++; const c = charges.get(id); if (!c) throw new Error(`mock: no charge ${id}`); return c; };
      const runC = (e: Stripe.Event, now?: Date) => processStripeEvent(e, { fetchSubscription, fetchChargeContext, now });
      const refundEv = (ch: string, t: number) => ev("charge.refunded", { id: ch, object: "charge" }, t);
      const disputeEv = (type: "charge.dispute.created" | "charge.dispute.closed", ch: string, t: number) => ev(type, { id: `dp_${ch}_${t}`, object: "dispute", charge: ch }, t);
      const pack = async (id: string) => (await db.select().from(schema.textPack).where(eq(schema.textPack.id, id)))[0];
      const remaining = async (id: string) => (await activePaidPacks(db, AORG, nowD)).find((p) => p.id === id)?.remaining;
      const logRows = async (id: string) => db.select().from(schema.textPackRevocation).where(eq(schema.textPackRevocation.textPackId, id));
      const warn = console.warn;
      const warned: string[] = [];
      console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
      const info = console.info;
      console.info = () => {};
      try {
        // Partial refunds (cumulative), used texts never revoked, idempotent on replays.
        await mkRow(`tp_cb1_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb1_${n}`, amountPaid: 1500 });
        await consumeTexts(db, { orgId: AORG, allowance: 0, sentBefore: 0, count: 300, now: nowD });
        setCharge(`ch_cb1_${n}`, { invoiceIds: [`in_cb1_${n}`], amountRefunded: 750 });
        const e1 = refundEv(`ch_cb1_${n}`, AT + 300);
        let r = await runC(e1);
        let p = await pack(`tp_cb1_${n}`);
        check("clawback: 50% refund → floor(1000 × 0.5) = 500 revoked; 200 left (300 already used)", r.status === "processed" && p.textsRevoked === 500 && p.revokedReason === "partial_refund" && !!p.revokedAt && p.amountRefunded === 750 && p.stripeChargeId === `ch_cb1_${n}` && (await remaining(`tp_cb1_${n}`)) === 200, { r, p });
        check("clawback: plan allowance untouched; entitlements count only the 200 unrevoked pack texts", (await texts()) === 2000 + 200, await texts());
        const f0 = chargeFetches;
        r = await runC(e1);
        check("clawback: the same event delivered again → duplicate, no Stripe call, nothing changes", r.status === "duplicate" && chargeFetches === f0 && (await pack(`tp_cb1_${n}`)).textsRevoked === 500 && (await logRows(`tp_cb1_${n}`)).length === 1);
        r = await runC(refundEv(`ch_cb1_${n}`, AT + 301));
        check("clawback: a new event with the same Stripe state → still 500 (absolute, not incremented)", r.status === "processed" && (await pack(`tp_cb1_${n}`)).textsRevoked === 500, await pack(`tp_cb1_${n}`));
        setCharge(`ch_cb1_${n}`, { amountRefunded: 1200 });
        r = await runC(refundEv(`ch_cb1_${n}`, AT + 302));
        p = await pack(`tp_cb1_${n}`);
        const lr = (await logRows(`tp_cb1_${n}`)).find((x) => x.stripeEventId === r.eventId);
        check("clawback: cumulative refund 80% → 800 wanted, capped at 700 (300 used are not revoked); remaining 0", p.textsRevoked === 700 && (await remaining(`tp_cb1_${n}`)) === 0, p);
        check("clawback: the 100 already-used texts are logged for Brian (row + structured warn)", lr?.textsUsedOverRevocation === 100 && lr.textsUsed === 300 && lr.textsRevokedBefore === 500 && lr.textsRevokedAfter === 700 && warned.some((w) => w.includes(`tp_cb1_${n}`) && w.includes('"usedOverRevocation":100')), { lr, warned });
        const c = await consumeTexts(db, { orgId: AORG, allowance: 0, sentBefore: 0, count: 1, now: nowD });
        check("clawback: consumeTexts never draws revoked texts", c.denied === 1 && c.fromPacks.length === 0, c);

        // Charges that didn't pay a pack invoice are ignored (subscription invoices, unknown invoices, no invoice).
        setCharge(`ch_sub_${n}`, { invoiceIds: [`in_subscription_${n}`], amountRefunded: 1500, refunded: true });
        setCharge(`ch_none_${n}`, { invoiceIds: [], amountRefunded: 1500, refunded: true });
        const ig1 = await runC(refundEv(`ch_sub_${n}`, AT + 303));
        const ig2 = await runC(disputeEv("charge.dispute.created", `ch_none_${n}`, AT + 304));
        check("clawback: non-pack charges → ignored, no pack touched", ig1.status === "ignored" && ig2.status === "ignored" && (await db.select().from(schema.textPackRevocation).where(eq(schema.textPackRevocation.stripeChargeId, `ch_sub_${n}`))).length === 0, { ig1, ig2 });

        // Full refund: every remaining text revoked immediately.
        await mkRow(`tp_cb2_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb2_${n}` });
        setCharge(`ch_cb2_${n}`, { invoiceIds: [`in_cb2_${n}`], amountRefunded: 1500, refunded: true });
        await runC(refundEv(`ch_cb2_${n}`, AT + 305));
        p = await pack(`tp_cb2_${n}`);
        check("clawback: full refund → all 1000 revoked (reason refund)", p.textsRevoked === 1000 && p.revokedReason === "refund" && (await remaining(`tp_cb2_${n}`)) === 0, p);

        // Dispute opened → revoked; won → restored; delivered out of order still converges.
        await mkRow(`tp_cb3_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb3_${n}`, textsUsed: 100 });
        setCharge(`ch_cb3_${n}`, { invoiceIds: [`in_cb3_${n}`], disputeStatuses: ["needs_response"] });
        await runC(disputeEv("charge.dispute.created", `ch_cb3_${n}`, AT + 306));
        p = await pack(`tp_cb3_${n}`);
        check("clawback: dispute opened → the 900 remaining revoked at once", p.textsRevoked === 900 && p.revokedReason === "dispute" && p.disputeStatus === "needs_response" && (await remaining(`tp_cb3_${n}`)) === 0, p);
        setCharge(`ch_cb3_${n}`, { disputeStatuses: ["won"] });
        await runC(disputeEv("charge.dispute.closed", `ch_cb3_${n}`, AT + 307));
        p = await pack(`tp_cb3_${n}`);
        check("clawback: dispute won (pack not expired, not refunded) → restored (900 usable again)", p.textsRevoked === 0 && p.revokedAt === null && p.revokedReason === "restored_dispute_won" && (await remaining(`tp_cb3_${n}`)) === 900, p);
        await runC(disputeEv("charge.dispute.created", `ch_cb3_${n}`, AT + 299)); // a late, older 'created' delivery: Stripe's current state is still "won"
        check("clawback: a late dispute.created after the win does not revoke again (current state wins)", (await pack(`tp_cb3_${n}`)).textsRevoked === 0);

        // Dispute lost → stays revoked.
        await mkRow(`tp_cb4_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb4_${n}` });
        setCharge(`ch_cb4_${n}`, { invoiceIds: [`in_cb4_${n}`], disputeStatuses: ["under_review"] });
        await runC(disputeEv("charge.dispute.created", `ch_cb4_${n}`, AT + 308));
        setCharge(`ch_cb4_${n}`, { disputeStatuses: ["lost"] });
        await runC(disputeEv("charge.dispute.closed", `ch_cb4_${n}`, AT + 309));
        p = await pack(`tp_cb4_${n}`);
        check("clawback: dispute lost → stays revoked (reason dispute_lost)", p.textsRevoked === 1000 && p.revokedReason === "dispute_lost", p);

        // Won after the pack expired → not restored. Won after a partial refund → restored only down to the refund's share.
        await mkRow(`tp_cb5_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb5_${n}` });
        setCharge(`ch_cb5_${n}`, { invoiceIds: [`in_cb5_${n}`], disputeStatuses: ["needs_response"] });
        await runC(disputeEv("charge.dispute.created", `ch_cb5_${n}`, AT + 310));
        setCharge(`ch_cb5_${n}`, { disputeStatuses: ["won"] });
        await runC(disputeEv("charge.dispute.closed", `ch_cb5_${n}`, AT + 311), new Date(nowD.getTime() + 30 * 86400000));
        check("clawback: dispute won after the pack expired → stays revoked", (await pack(`tp_cb5_${n}`)).textsRevoked === 1000, await pack(`tp_cb5_${n}`));
        await mkRow(`tp_cb6_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb6_${n}` });
        setCharge(`ch_cb6_${n}`, { invoiceIds: [`in_cb6_${n}`], amountRefunded: 375, disputeStatuses: ["needs_response"] });
        await runC(disputeEv("charge.dispute.created", `ch_cb6_${n}`, AT + 312));
        setCharge(`ch_cb6_${n}`, { disputeStatuses: ["won"] });
        await runC(disputeEv("charge.dispute.closed", `ch_cb6_${n}`, AT + 313));
        p = await pack(`tp_cb6_${n}`);
        check("clawback: dispute won on a 25%-refunded charge → restored down to the refund's 250 revoked", p.textsRevoked === 250 && p.revokedReason === "partial_refund" && (await remaining(`tp_cb6_${n}`)) === 750, p);

        // Inquiries (warning_*) withdraw no funds → nothing revoked.
        await mkRow(`tp_cb7_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb7_${n}` });
        setCharge(`ch_cb7_${n}`, { invoiceIds: [`in_cb7_${n}`], disputeStatuses: ["warning_needs_response"] });
        await runC(disputeEv("charge.dispute.created", `ch_cb7_${n}`, AT + 314));
        check("clawback: an inquiry (warning_needs_response) revokes nothing", (await pack(`tp_cb7_${n}`)).textsRevoked === 0);

        // Stripe 404 (resource_missing) on the charge / invoice lookup → logged and ignored (200), not a 500 retry loop.
        {
          const missing = Object.assign(new Error("No such charge: 'ch_gone'"), { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404 });
          const w0 = warned.length;
          const e404 = refundEv(`ch_gone_${n}`, AT + 316);
          const r404 = await processStripeEvent(e404, { fetchSubscription, fetchChargeContext: async () => { throw missing; }, now: nowD });
          check("clawback: Stripe 404 resource_missing on the charge lookup → ignored (200 handled) and logged, nothing written", r404.status === "ignored" && warned.slice(w0).some((w) => w.includes("resource_missing") && w.includes(e404.id)) && (await db.select().from(schema.textPackRevocation).where(eq(schema.textPackRevocation.stripeChargeId, `ch_gone_${n}`))).length === 0, { r404, warned: warned.slice(w0) });
          let threw = false;
          try {
            await processStripeEvent(refundEv(`ch_err_${n}`, AT + 317), { fetchSubscription, fetchChargeContext: async () => { throw Object.assign(new Error("api down"), { statusCode: 500 }); }, now: nowD });
          } catch {
            threw = true;
          }
          check("clawback: other Stripe errors still throw (→ 500, Stripe retries)", threw);
        }

        // Concurrency: a revocation and a send at the same moment never overdraw (both lock the org row).
        await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));
        await mkRow(`tp_cb8_${n}`, "paid", -1, 20, { stripeInvoiceId: `in_cb8_${n}` });
        setCharge(`ch_cb8_${n}`, { invoiceIds: [`in_cb8_${n}`], amountRefunded: 1500, refunded: true });
        const [sent] = await Promise.all([consumeTexts(db, { orgId: AORG, allowance: 0, sentBefore: 0, count: 400, now: nowD }), runC(refundEv(`ch_cb8_${n}`, AT + 315))]);
        p = await pack(`tp_cb8_${n}`);
        check("clawback: concurrent send + full refund → used + revoked = 1000 exactly", p.textsUsed + p.textsRevoked === 1000 && p.textsUsed === (sent.denied ? 0 : 400), { p, sent });
      } finally {
        console.warn = warn;
        console.info = info;
      }
      await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));
    }

    // legacy recurring texts item is still counted
    stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 2 }, { id: "si_t", price: "price_t_t1k", q: 2 }]));
    await run(ev("customer.subscription.updated", asub("active", []), AT + 110));
    check("legacy recurring texts add-on: still counted (+2000) alongside a paid pack", (await mkRow(`tp_h_${n}`, "paid", -1, 20), await texts()) === 5000, await texts());
    await db.delete(schema.textPack).where(eq(schema.textPack.organizationId, AORG));
    stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 2 }]));
    await run(ev("customer.subscription.updated", asub("active", []), AT + 111));

    // annual plan mapping (webhook + entitlements)
    process.env.STRIPE_PRICE_PRO_ANNUAL = "price_t_pro_y";
    process.env.STRIPE_ADDON_PRICE_SEAT_ANNUAL = "price_t_seat_y";
    stripeState.set(SA, asub("active", [{ id: "si_plan_y", price: "price_t_pro_y" }, { id: "si_seat_y", price: "price_t_seat_y", q: 3 }]));
    await run(ev("customer.subscription.updated", asub("active", []), AT + 120));
    s = await row(SA);
    r = await ent();
    check("annual subscription: webhook mirrors the annual plan price; entitlements = pro + 3 annual seats = 13 / 1 / 2000 / branding", s?.priceId === "price_t_pro_y" && JSON.stringify(plain(r)) === JSON.stringify({ reason: "ok", seats: 13, locations: 1, texts: 2000, branding: true, plan: "pro" }), { s: s?.priceId, p: plain(r) });
    stripeState.set(SA, asub("active", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 2 }]));
    await run(ev("customer.subscription.updated", asub("active", []), AT + 121));
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    delete process.env.STRIPE_ADDON_PRICE_SEAT_ANNUAL;
  }

  // ── one free trial per organization ──
  {
    const TORG = `org_trial_${n}`;
    await db.insert(schema.organization).values({ id: TORG, slug: `trial-${n}`, name: "Trial test", hours: defaultHours() });
    const subs: { status: string }[] = [];
    const fs = { subscriptions: { list: async () => ({ data: subs }) } };
    check("trial: a brand-new org (no subscription anywhere) is eligible", (await trialEligibility(TORG, "cus_t", { db, stripe: fs })).eligible === true);
    subs.push({ status: "incomplete_expired" });
    check("trial: an abandoned first payment (incomplete_expired) doesn't use the trial up", (await trialEligibility(TORG, "cus_t", { db, stripe: fs })).eligible === true);
    subs.push({ status: "canceled" });
    check("trial: a cancelled subscription in STRIPE (mirror empty / lagging) → no trial", (await trialEligibility(TORG, "cus_t", { db, stripe: fs })).eligible === false);
    subs.length = 0;
    await db.insert(schema.subscription).values({ id: `sr_${n}`, organizationId: TORG, stripeSubscriptionId: `sub_t_${n}`, status: "canceled", priceId: "price_t_starter" } as typeof schema.subscription.$inferInsert);
    check("trial: a cancelled subscription in OUR mirror (Stripe list empty) → no trial", (await trialEligibility(TORG, "cus_t", { db, stripe: fs })).eligible === false);
    await db.delete(schema.organization).where(eq(schema.organization.id, TORG));
  }


  // ── 0005: trial add-on charge attempts (addon_charge, migration 0011): ledger, crash → row survives, sweep ──
  {
    const CORG = `org_charge_${n}`;
    await db.insert(schema.organization).values({ id: CORG, slug: `charge-${n}`, name: "Charge test", hours: defaultHours() });
    const L = dbAddonChargeLedger(db, CORG);
    const base = { subscriptionId: `sub_c_${n}`, customerId: `cus_c_${n}`, addon: "seat", priceId: "price_c_seat", fromQuantity: 0, toQuantity: 2, amount: 467, currency: "usd", paymentMethod: "pm_card" };
    const T = schema.addonCharge;
    const rowOf = async (id: string) => (await db.select().from(T).where(eq(T.id, id)))[0];
    const age = (id: string) => db.update(T).set({ createdAt: new Date(Date.now() - 3600_000) }).where(eq(T.id, id));

    // Fake Stripe: subscription items, invoices (by id, list by metadata), credit notes with idempotency keys.
    const fx = { qty: 0, inv: new Map<string, { status: string; amount: number; metadata: Record<string, string> }>(), cns: [] as { id: string; invoice: string; metadata: Record<string, string> }[], cnKeys: new Map<string, string>(), throwItem: false, cnDown: 0, nInv: 0 };
    const fstripe = {
      subscriptions: { retrieve: async (id: string) => ({ id, status: "trialing", customer: base.customerId, trial_end: T0 + 7 * 86400, default_payment_method: "pm_card", latest_invoice: null, schedule: null, items: { has_more: false, data: [{ id: "si_plan", price: { id: "price_c_plan", unit_amount: 9900, recurring: { interval: "month" } }, quantity: 1, current_period_end: T0 + 7 * 86400 }, ...(fx.qty ? [{ id: "si_seat", price: { id: "price_c_seat", unit_amount: 1000 }, quantity: fx.qty, current_period_end: T0 + 7 * 86400 }] : [])] } }) as unknown as Stripe.Subscription },
      subscriptionItems: {
        list: () => ({ autoPagingToArray: async () => [] }),
        create: async (q: Stripe.SubscriptionItemCreateParams) => { if (fx.throwItem) throw new Error("crash"); fx.qty = q.quantity ?? 1; return { id: "si_seat" } as Stripe.SubscriptionItem; },
        update: async (id: string, q: Stripe.SubscriptionItemUpdateParams) => { fx.qty = q.quantity ?? fx.qty; return { id } as Stripe.SubscriptionItem; },
      },
      subscriptionSchedules: { retrieve: async () => { throw new Error("n/a"); }, create: async () => { throw new Error("n/a"); }, update: async () => { throw new Error("n/a"); }, release: async () => { throw new Error("n/a"); } },
      invoices: {
        create: async (q: Stripe.InvoiceCreateParams) => { const id = `in_c_${n}_${++fx.nInv}`; fx.inv.set(id, { status: "draft", amount: 0, metadata: q.metadata as Record<string, string> }); return { id, status: "draft" } as Stripe.Invoice; },
        finalizeInvoice: async (id: string) => (fx.inv.get(id)!.status = "open", { id, status: "open" } as Stripe.Invoice),
        pay: async (id: string) => { const v = fx.inv.get(id)!; v.status = "paid"; return { id, status: "paid", amount_paid: v.amount, currency: "usd" } as Stripe.Invoice; },
        retrieve: async (id: string) => { const v = fx.inv.get(id); return { id, status: v?.status ?? "void", amount_paid: v?.status === "paid" ? v.amount : 0, currency: "usd" } as Stripe.Invoice; },
        voidInvoice: async (id: string) => (fx.inv.get(id)!.status = "void", { id, status: "void" } as Stripe.Invoice),
        del: async () => ({}),
        list: async () => ({ data: [...fx.inv].map(([id, v]) => ({ id, status: v.status, amount_paid: v.status === "paid" ? v.amount : 0, metadata: v.metadata })) }),
      },
      invoiceItems: { create: async (q: Stripe.InvoiceItemCreateParams) => (fx.inv.get(q.invoice as string)!.amount = q.amount!, { id: "ii" } as Stripe.InvoiceItem) },
      prices: { retrieve: async (id: string) => ({ id, unit_amount: 1000, currency: "usd" }) as Stripe.Price },
      customers: { retrieve: async (id: string) => ({ id, invoice_settings: { default_payment_method: "pm_card" } }) as unknown as Stripe.Customer },
      creditNotes: {
        list: async (q: Stripe.CreditNoteListParams) => ({ data: fx.cns.filter((c) => c.invoice === q.invoice).map((c) => ({ ...c, status: "issued" })) }) as unknown as Stripe.ApiList<Stripe.CreditNote>,
        create: async (q: Stripe.CreditNoteCreateParams, o?: Stripe.RequestOptions) => {
          if (fx.cnDown > 0) { fx.cnDown--; throw new Error("unreachable"); }
          const seen = fx.cnKeys.get(o?.idempotencyKey ?? "");
          if (seen) return { id: seen } as Stripe.CreditNote;
          const id = `cn_c_${fx.cns.length + 1}`;
          fx.cns.push({ id, invoice: q.invoice, metadata: q.metadata as Record<string, string> });
          fx.cnKeys.set(o?.idempotencyKey ?? "", id);
          return { id } as Stripe.CreditNote;
        },
      },
    } as unknown as AddonStripe;

    await L.insert({ ...base, id: `adc_a_${n}` });
    await L.update(`adc_a_${n}`, { invoiceId: `in_dup_${n}` });
    let r0 = await rowOf(`adc_a_${n}`);
    check("addon_charge: inserted pending, invoice id stored, listed as unresolved", r0?.status === "pending" && r0.stripeInvoiceId === `in_dup_${n}` && (await L.unresolved()).some((x) => x.id === `adc_a_${n}`), r0);
    await L.insert({ ...base, id: `adc_b_${n}` });
    const dup = await L.update(`adc_b_${n}`, { invoiceId: `in_dup_${n}` }).then(() => "no error", (e: Error) => (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code ?? e.message);
    check("addon_charge: one Stripe invoice can belong to only one attempt (unique index)", dup === "23505", dup);
    await db.delete(T).where(eq(T.organizationId, CORG));

    // Crash INSIDE the route's locked section (0006: advisory lock + autocommit writes on one connection): the row survives as paid.
    fx.throwItem = true; fx.cnDown = 1;
    let attemptId = "";
    const crashed = await withAddonChangeLock(CORG, (ledger) =>
      // 0008: the trial-charge path is the charge_now BRANCH now (default at_trial_end never charges a trial add); pinned here.
      setAddonQuantityUnderPolicy("charge_now", { stripe: fstripe, subscription: { id: base.subscriptionId, status: "trialing" }, addon: "seat", quantity: 2, env: { STRIPE_ADDON_PRICE_SEAT: "price_c_seat", STRIPE_PRICE_PRO: "price_c_plan" }, now: new Date(T0 * 1000), ledger, newAttemptId: () => (attemptId = `adc_crash_${n}`) }),
    ).then(() => "no error", (e: Error) => e.message);
    r0 = await rowOf(attemptId);
    check("crash after the trial charge (item write fails, refund unreachable): error surfaces, lock released, addon_charge row survives as PAID", crashed === "crash" && r0?.status === "paid" && !!r0.stripeInvoiceId && fx.inv.get(r0.stripeInvoiceId!)?.status === "paid" && fx.qty === 0 && fx.cns.length === 0, { crashed, r0 });
    fx.throwItem = false;
    let sw = await sweepAddonCharges(db, fstripe);
    check("sweep: a fresh (< 10 min) attempt is left alone (a live request may own it)", !sw.some((x) => x.id === attemptId) && (await rowOf(attemptId))?.status === "paid", sw);
    await age(attemptId);
    // also: an old pending attempt whose invoice was paid but never recorded, and an old paid attempt that WAS applied
    await L.insert({ ...base, id: `adc_lost_${n}` });
    fx.inv.set(`in_lost_${n}`, { status: "paid", amount: 300, metadata: { flowops_addon_charge_id: `adc_lost_${n}` } });
    await age(`adc_lost_${n}`);
    sw = await sweepAddonCharges(db, fstripe);
    const st = async (id: string) => (await rowOf(id))?.status;
    check("sweep: old paid attempt without the add-on → refunded (credit note on its invoice, full amount)", (await st(attemptId)) === "refunded" && fx.cns.some((c) => c.invoice === r0?.stripeInvoiceId && c.metadata.flowops_addon_charge_id === attemptId) && !!(await rowOf(attemptId))?.stripeCreditNoteId, { sw, cns: fx.cns });
    check("sweep: old pending attempt whose invoice was paid (found by metadata) → refunded, invoice id recorded", (await st(`adc_lost_${n}`)) === "refunded" && (await rowOf(`adc_lost_${n}`))?.stripeInvoiceId === `in_lost_${n}`, await rowOf(`adc_lost_${n}`));
    const cnBefore = fx.cns.length;
    await db.update(T).set({ status: "paid" }).where(eq(T.id, attemptId)); // simulate a lost DB update after the refund
    await age(attemptId);
    sw = await sweepAddonCharges(db, fstripe);
    check("sweep: idempotent: re-running (even with a stale paid row) never refunds twice", fx.cns.length === cnBefore && (await st(attemptId)) === "refunded", { sw, cns: fx.cns });
    fx.qty = 2;
    await L.insert({ ...base, id: `adc_ok_${n}` });
    await L.update(`adc_ok_${n}`, { status: "paid", invoiceId: `in_ok_${n}` });
    fx.inv.set(`in_ok_${n}`, { status: "paid", amount: 467, metadata: {} });
    await age(`adc_ok_${n}`);
    sw = await sweepAddonCharges(db, fstripe);
    check("sweep: old paid attempt whose add-on IS on the subscription → applied, no refund (never takes back a granted add-on)", (await st(`adc_ok_${n}`)) === "applied" && fx.cns.length === cnBefore, sw);
    fx.qty = 0;

    // The sweep takes the org's add-on lock: while a request holds it the org is skipped ("busy"), never settled underneath it.
    await L.insert({ ...base, id: `adc_lock_${n}` });
    await age(`adc_lock_${n}`);
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((res) => (entered = res));
    const holding = withAddonChangeLock(CORG, async () => {
      entered();
      await new Promise<void>((res) => (release = res));
    });
    await inside;
    sw = await sweepAddonCharges(db, fstripe);
    const stillPending = (await st(`adc_lock_${n}`)) === "pending";
    release();
    await holding;
    check("sweep: an org whose add-on lock is held by a request is skipped (busy), its attempt untouched", stillPending && sw.some((x) => x.orgId === CORG && x.status === "busy"), sw);
    sw = await sweepAddonCharges(db, fstripe);
    check("sweep: next run (lock free) settles it (pending, no invoice → failed)", (await st(`adc_lock_${n}`)) === "failed", sw);
    await L.insert({ ...base, id: `adc_exempt_${n}` });
    await age(`adc_exempt_${n}`);
    sw = await sweepAddonCharges(db, fstripe, { skipOrgIds: new Set([CORG]) });
    check("sweep: exempt/demo orgs passed in skipOrgIds are never touched", sw.some((x) => x.orgId === CORG && x.status === "skipped_exempt") && (await st(`adc_exempt_${n}`)) === "pending", sw);
    sw = await sweepAddonCharges(db, fstripe, { deadline: Date.now() - 1 });
    check("sweep: past its time budget the remaining orgs are deferred to the next run, untouched", sw.some((x) => x.orgId === CORG && x.status === "deferred") && (await st(`adc_exempt_${n}`)) === "pending", sw);
    // 0007: orgs with organization.is_demo set are skipped when the caller asks (the cron always does).
    await db.update(schema.organization).set({ isDemo: true }).where(eq(schema.organization.id, CORG));
    sw = await sweepAddonCharges(db, fstripe, { skipDemoOrgs: true });
    check("0007 sweep: an org with is_demo set is skipped (skipped_demo) with skipDemoOrgs, its attempt untouched", sw.some((x) => x.orgId === CORG && x.status === "skipped_demo") && !sw.some((x) => x.orgId === CORG && x.status !== "skipped_demo") && (await st(`adc_exempt_${n}`)) === "pending", sw);
    await db.update(schema.organization).set({ isDemo: false }).where(eq(schema.organization.id, CORG));
    // 0007: misconfigured lock pool → the whole sweep throws (no silent "nothing to do"), before touching anything.
    {
      const saved = { u: process.env.DATABASE_URL, d: process.env.DATABASE_URL_UNPOOLED };
      process.env.DATABASE_URL = "postgres://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require";
      delete process.env.DATABASE_URL_UNPOOLED;
      const e1 = await sweepAddonCharges(db, fstripe).then(() => null, (e: unknown) => e);
      process.env.DATABASE_URL = saved.u;
      if (saved.d !== undefined) process.env.DATABASE_URL_UNPOOLED = saved.d;
      check("0007 sweep: a Neon -pooler DATABASE_URL without DATABASE_URL_UNPOOLED → throws AddonLockUnavailable naming DATABASE_URL_UNPOOLED; attempt untouched", e1 instanceof AddonLockUnavailable && /DATABASE_URL_UNPOOLED/.test(e1.message) && (await st(`adc_exempt_${n}`)) === "pending", String(e1));
      const e2 = await sweepAddonCharges(db, fstripe, { connect: async () => { throw new Error("timeout exceeded when trying to connect"); } }).then(() => null, (e: unknown) => e);
      check("0007 sweep: no session connection for an org (pool timeout) → the run throws AddonLockUnavailable instead of reporting a per-org 'error' with 200", e2 instanceof AddonLockUnavailable && (await st(`adc_exempt_${n}`)) === "pending", String(e2));
    }

    await db.delete(schema.organization).where(eq(schema.organization.id, CORG));
    check("org delete cascades addon_charge rows", (await db.select().from(T).where(eq(T.organizationId, CORG))).length === 0);
  }


  // ── 0006: one connection per add-on request (session advisory lock + autocommit ledger writes on that connection) ──
  {
    const ENV = { STRIPE_ADDON_PRICE_SEAT: "price_k_seat", STRIPE_PRICE_PRO: "price_k_plan" };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // A minimal trial subscription per org (Stripe calls take ~30 ms each, so requests really overlap).
    const mkFake = (org: string) => {
      const f = { qty: 0, paid: [] as string[], nInv: 0, inv: new Map<string, { status: string; amount: number }>() };
      const d = async <X>(x: X) => (await sleep(30), x);
      const stripe = {
        subscriptions: { retrieve: async (id: string) => d({ id, status: "trialing", customer: `cus_${org}`, trial_end: T0 + 7 * 86400, default_payment_method: "pm_card", latest_invoice: null, schedule: null, items: { has_more: false, data: [{ id: "si_plan", price: { id: "price_k_plan", unit_amount: 9900, recurring: { interval: "month" } }, quantity: 1, current_period_end: T0 + 7 * 86400 }, ...(f.qty ? [{ id: "si_seat", price: { id: "price_k_seat", unit_amount: 1000 }, quantity: f.qty, current_period_end: T0 + 7 * 86400 }] : [])] } } as unknown as Stripe.Subscription) },
        subscriptionItems: {
          list: () => ({ autoPagingToArray: async () => [] }),
          create: async (q: Stripe.SubscriptionItemCreateParams) => { await sleep(30); f.qty = q.quantity ?? 1; return { id: "si_seat" } as Stripe.SubscriptionItem; },
          update: async (id: string, q: Stripe.SubscriptionItemUpdateParams) => { await sleep(30); f.qty = q.quantity ?? f.qty; return { id } as Stripe.SubscriptionItem; },
        },
        subscriptionSchedules: { retrieve: async () => { throw new Error("n/a"); }, create: async () => { throw new Error("n/a"); }, update: async () => { throw new Error("n/a"); }, release: async () => { throw new Error("n/a"); } },
        invoices: {
          create: async () => { const id = `in_${org}_${++f.nInv}`; f.inv.set(id, { status: "draft", amount: 0 }); return d({ id, status: "draft" } as Stripe.Invoice); },
          finalizeInvoice: async (id: string) => (f.inv.get(id)!.status = "open", d({ id, status: "open" } as Stripe.Invoice)),
          pay: async (id: string) => { const v = f.inv.get(id)!; v.status = "paid"; f.paid.push(id); return d({ id, status: "paid", amount_paid: v.amount, currency: "usd" } as Stripe.Invoice); },
          retrieve: async (id: string) => { const v = f.inv.get(id); return { id, status: v?.status ?? "void", amount_paid: v?.status === "paid" ? v.amount : 0, currency: "usd" } as Stripe.Invoice; },
          voidInvoice: async (id: string) => (f.inv.get(id)!.status = "void", { id, status: "void" } as Stripe.Invoice),
          del: async () => ({}),
          list: async () => ({ data: [] }),
        },
        invoiceItems: { create: async (q: Stripe.InvoiceItemCreateParams) => (f.inv.get(q.invoice as string)!.amount = q.amount!, d({ id: "ii" } as Stripe.InvoiceItem)) },
        prices: { retrieve: async (id: string) => ({ id, unit_amount: 1000, currency: "usd" }) as Stripe.Price },
        customers: { retrieve: async (id: string) => ({ id, invoice_settings: { default_payment_method: "pm_card" } }) as unknown as Stripe.Customer },
        creditNotes: { list: async () => ({ data: [] }), create: async () => { throw new Error("no refunds expected"); } },
      } as unknown as AddonStripe;
      return { f, stripe };
    };
    const ORGS = ["a", "b", "c", "d"].map((k) => `org_conc_${k}_${n}`);
    for (const [i, id] of ORGS.entries()) await db.insert(schema.organization).values({ id, slug: `conc-${i}-${n}`, name: `Concurrency ${i}`, hours: defaultHours() });
    const fakes = new Map(ORGS.map((o) => [o, mkFake(o)]));
    const active = new Map<string, number>();
    const maxActive = new Map<string, number>();
    let global = 0;
    let maxGlobal = 0;
    const sessionPool = getSessionPool();
    let maxCheckedOut = 0;
    const sampler = setInterval(() => (maxCheckedOut = Math.max(maxCheckedOut, sessionPool.totalCount - sessionPool.idleCount)), 5);
    // What POST /api/billing/addons does after its guards: lock → setAddonQuantity with the ledger → unlock. Pinned to the
    // charge_now branch (0008) so the double-charge guarantee for trial charges stays covered; the default is checked below.
    const request = (org: string, quantity: number) =>
      withAddonChangeLock(org, async (ledger) => {
        active.set(org, (active.get(org) ?? 0) + 1);
        maxActive.set(org, Math.max(maxActive.get(org) ?? 0, active.get(org)!));
        maxGlobal = Math.max(maxGlobal, ++global);
        try {
          return await setAddonQuantityUnderPolicy("charge_now", { stripe: fakes.get(org)!.stripe, subscription: { id: `sub_${org}`, status: "trialing" }, addon: "seat", quantity, env: ENV, now: new Date(T0 * 1000), ledger });
        } finally {
          active.set(org, active.get(org)! - 1);
          global--;
        }
      }).then((r) => (r.ok ? r.action : `${r.status}`), (e: Error) => addonLockFailureResponse(e)?.status ?? `threw ${e.message}`);
    // 8 at once: 5 double-clicks for org A (all "seat → 2"), one each for B, C, D.
    const plan = [ORGS[0], ORGS[0], ORGS[1], ORGS[0], ORGS[2], ORGS[0], ORGS[3], ORGS[0]];
    const t0 = Date.now();
    const HANG = Symbol("hang");
    const outcome = await Promise.race([Promise.all(plan.map((o) => request(o, 2))), sleep(20_000).then(() => HANG)]);
    const took = Date.now() - t0;
    clearInterval(sampler);
    check("0006 concurrency: 8 simultaneous add-on requests (5 for one org, 3 for others) all finish, no hang", outcome !== HANG && took < 15_000, { took, outcome });
    const res = outcome === HANG ? [] : (outcome as (string | number)[]);
    const aRes = res.filter((_, i) => plan[i] === ORGS[0]);
    const A = fakes.get(ORGS[0])!.f;
    const rowsA = await db.select().from(schema.addonCharge).where(eq(schema.addonCharge.organizationId, ORGS[0]));
    check("0006 concurrency: same org strictly serialised (never two of its requests inside the lock at once)", maxActive.get(ORGS[0]) === 1 && ORGS.every((o) => maxActive.get(o) === 1), Object.fromEntries(maxActive));
    check("0006 concurrency: no double charge: org A charged exactly once (1 paid invoice, 1 attempt row → applied); the other 4 clicks are 'unchanged'", A.paid.length === 1 && A.qty === 2 && rowsA.length === 1 && rowsA[0].status === "applied" && aRes.filter((x) => x === "created").length === 1 && aRes.filter((x) => x === "unchanged").length === 4, { paid: A.paid, rowsA: rowsA.map((r) => r.status), aRes });
    let othersOk = true;
    for (const o of ORGS.slice(1)) {
      const rows = await db.select().from(schema.addonCharge).where(eq(schema.addonCharge.organizationId, o));
      othersOk &&= fakes.get(o)!.f.paid.length === 1 && rows.length === 1 && rows[0].status === "applied";
    }
    check("0006 concurrency: orgs B, C, D each charged once and applied; different orgs ran in parallel", othersOk && maxGlobal > 1, { maxGlobal });

    // 0008 default (at_trial_end) through the real lock + DB ledger: 3 simultaneous trial adds for one org → applied
    // once, NO invoice at all, NO addon_charge row.
    {
      const EORG = `org_conc_e_${n}`;
      await db.insert(schema.organization).values({ id: EORG, slug: `conc-e-${n}`, name: "Concurrency E", hours: defaultHours() });
      const fe = mkFake(EORG);
      const viaRoute = () => withAddonChangeLock(EORG, (ledger) => setAddonQuantity({ stripe: fe.stripe, subscription: { id: `sub_${EORG}`, status: "trialing" }, addon: "seat", quantity: 2, env: ENV, now: new Date(T0 * 1000), ledger }));
      const rs = await Promise.all([viaRoute(), viaRoute(), viaRoute()]);
      const rowsE = await db.select().from(schema.addonCharge).where(eq(schema.addonCharge.organizationId, EORG));
      check("0008 default at_trial_end (real lock + DB ledger): 3 simultaneous trial adds → created once + 2 unchanged, qty 2, no invoice created or paid, no addon_charge row", rs.filter((r) => r.ok && r.action === "created").length === 1 && rs.filter((r) => r.ok && r.action === "unchanged").length === 2 && rs.every((r) => r.ok && r.charge === null) && fe.f.qty === 2 && fe.f.nInv === 0 && fe.f.paid.length === 0 && rowsE.length === 0, { rs, f: { qty: fe.f.qty, nInv: fe.f.nInv }, rows: rowsE.length });
      ORGS.push(EORG);
    }
    check(`0006 concurrency: never more than ${sessionPool.options.max} session connections in use (one per request holding the lock; waiters hold none)`, maxCheckedOut >= 1 && maxCheckedOut <= (sessionPool.options.max ?? 0), { maxCheckedOut });
    console.log(`  0006 concurrency: 8 requests in ${took} ms, results ${JSON.stringify(res)}, max in-lock at once ${maxGlobal}, max session connections in use ${maxCheckedOut}/${sessionPool.options.max}`);
    await sleep(50);
    const [{ held }] = (await db.execute(sql`select count(*)::int as held from pg_locks where locktype = 'advisory' and objsubid = 2`)).rows as { held: number }[];
    check("0006 concurrency: afterwards every connection is back in the pool (none checked out, none waiting) and no advisory lock is held", sessionPool.totalCount === sessionPool.idleCount && sessionPool.waitingCount === 0 && getConn().pool.waitingCount === 0 && held === 0, { total: sessionPool.totalCount, idle: sessionPool.idleCount, waiting: sessionPool.waitingCount, held });

    // Error inside the locked section → the lock is still released (finally) and the connection returned.
    const boom = await withAddonChangeLock(ORGS[1], async () => { throw new Error("boom"); }).catch((e: Error) => e.message);
    const again = await withAddonChangeLock(ORGS[1], async () => "got it", { waitMs: 0 }).catch((e: Error) => e.constructor.name);
    check("0006 lock: an error inside the locked section releases the lock (next request gets it at once) and the connection", boom === "boom" && again === "got it" && sessionPool.totalCount === sessionPool.idleCount, { boom, again });

    // Lock held longer than the wait → AddonChangeBusy → 409 change_in_progress (and nothing ran).
    let releaseA!: () => void;
    let inA!: () => void;
    const entered = new Promise<void>((r) => (inA = r));
    const holder = withAddonChangeLock(ORGS[0], async () => { inA(); await new Promise<void>((r) => (releaseA = r)); });
    await entered;
    let ran = false;
    const busy = await withAddonChangeLock(ORGS[0], async () => { ran = true; }, { waitMs: 300 }).catch((e: unknown) => e);
    const busyRes = addonLockFailureResponse(busy);
    const otherOrg = await withAddonChangeLock(ORGS[2], async () => "free", { waitMs: 0 });
    releaseA();
    await holder;
    check("0006 lock: same org busy beyond the wait → 409 change_in_progress, nothing ran; another org is not blocked", busy instanceof AddonChangeBusy && busyRes?.status === 409 && (await busyRes.json()).code === "change_in_progress" && !ran && otherOrg === "free", { busy: String(busy), status: busyRes?.status });

    // No free connection within connectionTimeoutMillis → clean 503 (real pg-pool timeout on a pool of 1).
    const tiny = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 200 });
    const hog = await tiny.connect();
    const connect = async (): Promise<SessionClient> => { const c = await tiny.connect(); return { db: db, query: (t, p) => c.query(t, p) as never, release: (x) => c.release(x ? true : undefined) }; };
    const t1 = Date.now();
    const starved = await withAddonChangeLock(ORGS[3], async () => "ran", { connect }).catch((e: unknown) => e);
    const starvedRes = addonLockFailureResponse(starved);
    check("0006 pool: no connection within connectionTimeoutMillis → 503 db_unavailable within ~the timeout (no hang), nothing ran", starvedRes?.status === 503 && (await starvedRes.json()).code === "db_unavailable" && Date.now() - t1 < 2_000, { starved: String(starved), ms: Date.now() - t1 });
    check("0006 pool: isPoolTimeout recognises pg-pool's timeout error", isPoolTimeout(new Error("timeout exceeded when trying to connect")) && !isPoolTimeout(new Error("other")));
    hog.release();
    await tiny.end();

    // For contrast, the 0005 shape (lock held in a transaction + ledger write on a SECOND connection of the same pool of 5):
    // 5 at once each hold one connection and wait for a second. Without a timeout that is a permanent hang; here a 1 s
    // timeout shows every one of them is stuck.
    const old = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 1_000 });
    const oldShape = async () => {
      const c = await old.connect();
      try {
        await c.query("begin");
        await sleep(100); // all five now hold their first connection
        const c2 = await old.connect(); // the ledger write's second connection
        c2.release();
        return "ok";
      } catch (e) {
        return isPoolTimeout(e) ? "stuck" : `err ${(e as Error).message}`;
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    };
    const tStart = Date.now();
    const oldRes = await Promise.all([1, 2, 3, 4, 5].map((i) => oldShape().then((r) => ({ r, ms: Date.now() - tStart, i }))));
    await old.end();
    // 0007 (flake fix): once the first stuck request gives up after the 1 s timeout and returns its connection, one
    // waiter can grab it and finish ("ok") — a timing race (1 of 6 runs showed stuck×4). The deadlock is shown by: at
    // least 4 of 5 stuck, nothing else went wrong, and NO request got its 2nd connection before a timeout freed one
    // (any "ok" finished only after ~the 1 s timeout, i.e. it was unblocked by a timed-out peer, not by free capacity).
    const stuck = oldRes.filter((x) => x.r === "stuck").length;
    const oks = oldRes.filter((x) => x.r === "ok");
    console.log(`  0006 contrast: ${oldRes.map((x) => `${x.r}@${x.ms}ms`).join(", ")}`);
    check("0006 contrast: the 0005 two-connection shape with 5 concurrent requests on a pool of 5 gets stuck (≥ 4 of 5 time out waiting for a 2nd connection; any 'ok' only after a peer's timeout freed one)", stuck >= 4 && stuck + oks.length === 5 && oks.every((x) => x.ms >= 950), oldRes);

    // The session pool refuses Neon's pooled (PgBouncer transaction-mode) URL: a session lock there would leak.
    const { sessionDatabaseUrl } = await import("../src/lib/db");
    const pooled = "postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db";
    const direct = "postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/db";
    const refused = (() => { try { sessionDatabaseUrl({ DATABASE_URL: pooled }); return false; } catch { return true; } })();
    check("0006 session URL: DATABASE_URL_UNPOOLED preferred; a Neon -pooler DATABASE_URL alone is refused; a direct/local one is used", refused && sessionDatabaseUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct }) === direct && sessionDatabaseUrl({ DATABASE_URL: direct }) === direct);
    const s1 = await connectSession();
    const v = (await s1.query<{ idle_session_timeout: string }>("show idle_session_timeout")).rows[0]?.idle_session_timeout;
    s1.release();
    check("0006 session connections set idle_session_timeout (server drops a lock held by a frozen/killed function)", v === "2min" || v === "120s", v);

    for (const id of ORGS) await db.delete(schema.organization).where(eq(schema.organization.id, id));
  }

  // Failed card: locked org → zero entitlements (the lock already blocks it).
  stripeState.set(SA, asub("past_due", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 5 }]));
  await run(ev("invoice.payment_failed", { id: "in_pf2", parent: { subscription_details: { subscription: SA } } }, AT + 200));
  r = await ent();
  check("entitlements: past_due → enforced with zero limits (reason not_active)", r.enforced && r.reason === "not_active" && r.entitlements.seats === 0, r);

  // Canceled is terminal: later events do not touch items.
  stripeState.set(SA, asub("canceled", [{ id: "si_plan2", price: "price_t_pro" }]));
  await run(ev("customer.subscription.deleted", asub("canceled", []), AT + 210));
  stripeState.set(SA, asub("active", [{ id: "si_plan3", price: "price_t_starter" }]));
  const zomb = await run(ev("customer.subscription.updated", asub("active", []), AT + 220));
  check("webhook: canceled subscription's items are not rewritten by a later event", zomb.status === "stale" && !(await items()).some((x) => x.startsWith("si_plan3")), { zomb, items: await items() });
  const [subRow] = await db.select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, SA));
  await db.delete(schema.organization).where(eq(schema.organization.id, AORG));
  const left = subRow ? await db.select().from(schema.subscriptionItem).where(eq(schema.subscriptionItem.subscriptionId, subRow.id)) : [];
  check("org delete cascades subscription_item rows", left.length === 0);
  for (const k of Object.keys(process.env)) if (!(k in envPrev)) delete process.env[k];
  Object.assign(process.env, envPrev);

  console.log(`\n${failed ? `${failed} failed` : "all passed"} (billing, local database, Stripe mocked)`);
  await getConn().pool.end();
  await getSessionPool().end();
  process.exit(failed ? 1 : 0);
})();
