// Webhook processing against a THROWAWAY local Postgres (never production), Stripe mocked (no network):
//   DATABASE_URL=postgres://…/scratch npm run test:billing:db
// Requires migrations applied to that database (npm run db:migrate) — uses the demo org.
import type Stripe from "stripe";
import { asc, eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { processStripeEvent, type SubscriptionFetcher } from "../src/lib/billing/webhook";
import { getBillingAccess, requireBillingAccess } from "../src/lib/billing/access";
import { getEntitlements } from "../src/lib/billing/org-entitlements";
import { subscriptionFields } from "../src/lib/billing/webhook";
import { DEMO_ORG_ID, defaultHours } from "../src/lib/tenancy/defaults";

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

  const ign = await run(ev("charge.refunded", {}));
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
    STRIPE_ADDON_PRICE_SEAT: "price_t_seat", STRIPE_ADDON_PRICE_LOCATION: "price_t_loc", STRIPE_ADDON_PRICE_TEXTS_1000: "price_t_t1k", STRIPE_ADDON_PRICE_BRANDING: "price_t_brand",
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

  // Failed card: locked org → zero entitlements (the lock already blocks it).
  stripeState.set(SA, asub("past_due", [{ id: "si_plan2", price: "price_t_pro" }, { id: "si_seat", price: "price_t_seat", q: 5 }]));
  await run(ev("invoice.payment_failed", { id: "in_pf2", parent: { subscription_details: { subscription: SA } } }, AT + 40));
  r = await ent();
  check("entitlements: past_due → enforced with zero limits (reason not_active)", r.enforced && r.reason === "not_active" && r.entitlements.seats === 0, r);

  // Canceled is terminal: later events do not touch items.
  stripeState.set(SA, asub("canceled", [{ id: "si_plan2", price: "price_t_pro" }]));
  await run(ev("customer.subscription.deleted", asub("canceled", []), AT + 50));
  stripeState.set(SA, asub("active", [{ id: "si_plan3", price: "price_t_starter" }]));
  const zomb = await run(ev("customer.subscription.updated", asub("active", []), AT + 60));
  check("webhook: canceled subscription's items are not rewritten by a later event", zomb.status === "stale" && !(await items()).some((x) => x.startsWith("si_plan3")), { zomb, items: await items() });
  const [subRow] = await db.select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, SA));
  await db.delete(schema.organization).where(eq(schema.organization.id, AORG));
  const left = subRow ? await db.select().from(schema.subscriptionItem).where(eq(schema.subscriptionItem.subscriptionId, subRow.id)) : [];
  check("org delete cascades subscription_item rows", left.length === 0);
  for (const k of Object.keys(process.env)) if (!(k in envPrev)) delete process.env[k];
  Object.assign(process.env, envPrev);

  console.log(`\n${failed ? `${failed} failed` : "all passed"} (billing, local database, Stripe mocked)`);
  await getConn().pool.end();
  process.exit(failed ? 1 : 0);
})();
