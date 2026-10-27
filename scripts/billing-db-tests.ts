// Webhook processing against a THROWAWAY local Postgres (never production), Stripe mocked (no network):
//   DATABASE_URL=postgres://…/scratch npm run test:billing:db
// Requires migrations applied to that database (npm run db:migrate) — uses the demo org.
import type Stripe from "stripe";
import { asc, eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { processStripeEvent, type SubscriptionFetcher } from "../src/lib/billing/webhook";
import { getBillingAccess, requireBillingAccess } from "../src/lib/billing/access";
import { getEntitlements } from "../src/lib/billing/org-entitlements";
import { activePaidPacks, consumeTexts, purchaseTextPack, type PackStripe } from "../src/lib/billing/text-packs";
import { textPackExpiry } from "../src/lib/billing/text-pack-rules";
import { trialEligibility } from "../src/lib/billing/checkout";
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
  process.exit(failed ? 1 : 0);
})();
