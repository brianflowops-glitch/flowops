// Webhook processing against a THROWAWAY local Postgres (never production), Stripe mocked (no network):
//   DATABASE_URL=postgres://…/scratch npm run test:billing:db
// Requires migrations applied to that database (npm run db:migrate) — uses the demo org.
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { processStripeEvent, type SubscriptionFetcher } from "../src/lib/billing/webhook";
import { getBillingAccess, requireBillingAccess } from "../src/lib/billing/access";
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
    items: { data: [{ price: { id: "price_test_x" }, current_period_end: 1800000000 }] },
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

  console.log(`\n${failed ? `${failed} failed` : "all passed"} (billing, local database, Stripe mocked)`);
  await getConn().pool.end();
  process.exit(failed ? 1 : 0);
})();
