// LIVE Stripe SANDBOX check of patch 0005 (review fixes on PR #20, docs/BILLING.md §11). TEST MODE ONLY.
//   A. trial add with a declining card → 402; switch to a good card → retry → paid (per-attempt idempotency key)
//   B. removing an add-on during a trial keeps trial_end (schedule phases carry trial_end); trial-end invoice = plan only
//   C. crash after the trial charge (item write + refund fail) → addon_charge row stays paid → sweep refunds once
//   STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres, migrated> \
//     npx tsx --conditions=react-server scripts/billing-sandbox-0005.ts
// Every clock and customer it creates is deleted at the end. The secret key is never printed.
import Stripe from "stripe";
import { asc, eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { dbAddonChargeLedger, sweepAddonCharges } from "../src/lib/billing/addon-charges-db";
import { processStripeEvent } from "../src/lib/billing/webhook";
import { retrieveSubscriptionComplete, setAddonQuantity, TRIAL_ADDON_POLICY, type AddonStripe } from "../src/lib/billing/addons";
import { getEntitlements } from "../src/lib/billing/org-entitlements";
import { findLiveSubscription } from "../src/lib/billing/status";
import { defaultHours } from "../src/lib/tenancy/defaults";
import { EXPECT_ACCOUNT } from "./sandbox-final-prices";

const key = process.env.STRIPE_SECRET_KEY_TEST_US;
if (!key?.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY_TEST_US (a sk_test_ key) is required");
if (!process.env.DATABASE_URL || /neon\.tech|vercel|amazonaws/.test(process.env.DATABASE_URL)) throw new Error("A throwaway LOCAL DATABASE_URL is required");
const stripe = new Stripe(key, { appInfo: { name: "FlowOps 0005 review sandbox check" } });

const P = {
  pro_month: "price_1UUvY35iQFiJ57ypBQeXz1q5",
  seat_month: "price_1UVB9h5iQFiJ57ypTZbo5ZBn",
  location_month: "price_1UVB9h5iQFiJ57ypGYTvNWjm",
  branding_month: "price_1UVB9i5iQFiJ57ypFfJkhTj1",
  seat_year: "price_1UVE2W5iQFiJ57ypv2kubP9f",
  location_year: "price_1UVE2X5iQFiJ57ypVp72DG7L",
  branding_year: "price_1UVE2Y5iQFiJ57ypXa4T0Nuh",
  text_pack: "price_1UVE2Y5iQFiJ57ypZKKDswAr",
};
const env = {
  ...process.env,
  BILLING_ENABLED: "true",
  STRIPE_PRICE_PRO: P.pro_month,
  STRIPE_ADDON_PRICE_SEAT: P.seat_month, STRIPE_ADDON_PRICE_LOCATION: P.location_month, STRIPE_ADDON_PRICE_BRANDING: P.branding_month,
  STRIPE_ADDON_PRICE_SEAT_ANNUAL: P.seat_year, STRIPE_ADDON_PRICE_LOCATION_ANNUAL: P.location_year, STRIPE_ADDON_PRICE_BRANDING_ANNUAL: P.branding_year,
  STRIPE_ADDON_PRICE_TEXTS_1000: P.text_pack,
};
Object.assign(process.env, env);

let failed = 0, passed = 0;
const check = (label: string, okv: unknown, detail?: unknown) => {
  const ok = !!okv;
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = Date.now();
const clocks: string[] = [];
const orgs: string[] = [];
const db = getDb();
const RECORD: Record<string, unknown> = {};

async function advance(clockId: string, to: number) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    if ((await stripe.testHelpers.testClocks.retrieve(clockId)).status === "ready") return;
  }
  throw new Error("test clock did not become ready");
}

async function world(label: string, cardToken = "pm_card_visa") {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `flowops-0005-${label}-${n}` });
  clocks.push(clock.id);
  const ORG = `org_0005_${label}_${n}`;
  orgs.push(ORG);
  await db.insert(schema.organization).values({ id: ORG, slug: `p0005-${label}-${n}`, name: `0005 ${label}`, hours: defaultHours() });
  const customer = await stripe.customers.create({ name: `FlowOps 0005 test ${label}`, email: `p0005-${label}-${n}@example.test`, test_clock: clock.id, payment_method: cardToken, metadata: { organizationId: ORG, flowops_test: "0005" } });
  const pms = await stripe.paymentMethods.list({ customer: customer.id, type: "card" });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pms.data[0].id } });
  const seen = new Set<string>();
  const drain = async () => {
    await sleep(2500);
    const all: Stripe.Event[] = [];
    for await (const e of stripe.events.list({ limit: 100, types: ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"] })) {
      if ((e.data.object as { customer?: string }).customer === customer.id) all.push(e);
      if (all.length > 80 || e.created < Math.floor(n / 1000) - 5) break;
    }
    const fresh = all.filter((e) => !seen.has(e.id)).reverse();
    for (const e of fresh) { seen.add(e.id); await processStripeEvent(e, { fetchSubscription: (id) => retrieveSubscriptionComplete(stripe, id) }); }
    console.log(`  [${label}] processed ${fresh.length} real events`);
  };
  const now = async () => new Date((await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time * 1000);
  const live = async () => findLiveSubscription((await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 10 })).data)!;
  const invoices = async () => (await stripe.invoices.list({ customer: customer.id, limit: 30 })).data;
  const seats = async () => { const r = await getEntitlements(ORG, { now: await now(), env }); return r.enforced ? r.entitlements.seats : -1; };
  const ledger = dbAddonChargeLedger(db, ORG);
  const apply = async (addon: string, quantity: number, client: AddonStripe = stripe as unknown as AddonStripe) => setAddonQuantity({ stripe: client, subscription: await live(), addon, quantity, env, now: await now(), ledger });
  const rows = async () => db.select().from(schema.addonCharge).where(eq(schema.addonCharge.organizationId, ORG)).orderBy(asc(schema.addonCharge.createdAt));
  const qty = async (price: string) => (await stripe.subscriptions.retrieve((await live()).id)).items.data.find((i) => i.price.id === price)?.quantity ?? 0;
  return { clock, ORG, customer, drain, now, live, invoices, seats, apply, qty, ledger, rows };
}

(async () => {
  const acct = await stripe.accounts.retrieveCurrent();
  check(`connected to the expected US sandbox account (${EXPECT_ACCOUNT}), test mode`, acct.id === EXPECT_ACCOUNT);
  if (acct.id !== EXPECT_ACCOUNT) process.exit(1);
  check("TRIAL_ADDON_POLICY = charge_now (default)", TRIAL_ADDON_POLICY === "charge_now");
  const customers: string[] = [];
  const trialSub = (w: Awaited<ReturnType<typeof world>>) => stripe.subscriptions.create({ customer: w.customer.id, items: [{ price: P.pro_month }], trial_period_days: 14, trial_settings: { end_behavior: { missing_payment_method: "cancel" } }, metadata: { organizationId: w.ORG, flowops_test: "0005" } });
  try {
    // ═══ A. decline → retry with a good card → paid ═══
    console.log("\n── A. Trial add: declined, then retried with a good card ──");
    const a = await world("retry", "pm_card_chargeCustomerFail");
    customers.push(a.customer.id);
    const aSub = await trialSub(a);
    await advance(a.clock.id, aSub.trial_start! + 7 * 86400);
    await a.drain();
    let r = await a.apply("seat", 2);
    let rows = await a.rows();
    const declined = rows[0]?.stripeInvoiceId ? await stripe.invoices.retrieve(rows[0].stripeInvoiceId) : null;
    RECORD.declineInvoice = declined && { id: declined.id, status: declined.status, amount_due: declined.amount_due, attempt: declined.metadata?.flowops_addon_charge_id, pm: rows[0].paymentMethod };
    check("declining card → 402 payment_failed; its invoice is VOID; attempt row failed; no seat item", !r.ok && r.status === 402 && r.code === "payment_failed" && declined?.status === "void" && rows.length === 1 && rows[0].status === "failed" && (await a.qty(P.seat_month)) === 0, { r, rec: RECORD.declineInvoice, rows: rows.map((x) => x.status) });
    const visa = await stripe.paymentMethods.attach("pm_card_visa", { customer: a.customer.id });
    await stripe.customers.update(a.customer.id, { invoice_settings: { default_payment_method: visa.id } });
    r = await a.apply("seat", 2);
    rows = await a.rows();
    const paid = r.ok && r.charge ? await stripe.invoices.retrieve(r.charge.invoiceId) : null;
    RECORD.retryInvoice = paid && { id: paid.id, status: paid.status, amount_paid: paid.amount_paid, attempt: paid.metadata?.flowops_addon_charge_id, pm: rows[1]?.paymentMethod };
    check("retry with a good card → a NEW invoice, PAID; seats 2; second attempt row applied", r.ok && r.charge?.kind === "trial_proration" && paid?.status === "paid" && paid.id !== declined?.id && (paid.amount_paid ?? 0) > 0 && (await a.qty(P.seat_month)) === 2 && rows.length === 2 && rows[1].status === "applied", { r, rec: RECORD.retryInvoice });
    check("the two attempts carry different attempt ids and payment methods", rows[0].id !== rows[1].id && rows[0].paymentMethod !== rows[1].paymentMethod && declined?.metadata?.flowops_addon_charge_id === rows[0].id && paid?.metadata?.flowops_addon_charge_id === rows[1].id);
    const aS = await stripe.subscriptions.retrieve(aSub.id);
    check("still trialing, trial_end unchanged", aS.status === "trialing" && aS.trial_end === aSub.trial_end);

    // ═══ B. removal during a trial keeps trial_end ═══
    console.log("\n── B. Remove an add-on during the trial: trial_end unchanged ──");
    const invsB = (await a.invoices()).length;
    r = await a.apply("seat", 0);
    const bS = await stripe.subscriptions.retrieve(aSub.id);
    const sched = bS.schedule ? await stripe.subscriptionSchedules.retrieve(typeof bS.schedule === "string" ? bS.schedule : bS.schedule.id) : null;
    RECORD.trialEnd = { before: aSub.trial_end, after: bS.trial_end, status: bS.status, schedule: sched?.id, phases: sched?.phases.map((p) => ({ start: p.start_date, end: p.end_date, trial_end: p.trial_end, items: p.items.map((i) => `${typeof i.price === "string" ? i.price : i.price.id}×${i.quantity}`) })) };
    check("seat 2 → 0 in a trial: scheduled for the trial end, no invoice, nothing charged or refunded", r.ok && r.action === "scheduled" && r.effectiveAt === aSub.trial_end && (await a.invoices()).length === invsB, r);
    check("subscription still trialing with trial_end UNCHANGED; seats still 2 until then", bS.status === "trialing" && bS.trial_end === aSub.trial_end && (await a.qty(P.seat_month)) === 2, RECORD.trialEnd);
    check("schedule: current phase keeps trial_end = the trial end; next phase starts there without seats", !!sched && sched.phases[0].trial_end === aSub.trial_end && sched.phases[0].end_date === aSub.trial_end && sched.phases[1]?.start_date === aSub.trial_end && !sched.phases[1].items.some((i) => (typeof i.price === "string" ? i.price : i.price.id) === P.seat_month), RECORD.trialEnd);
    await advance(a.clock.id, aSub.trial_end! + 3600);
    await a.drain();
    const first = (await a.invoices()).find((i) => i.billing_reason === "subscription_cycle");
    const cS = await stripe.subscriptions.retrieve(aSub.id);
    RECORD.trialEndInvoice = first && { id: first.id, status: first.status, amount_paid: first.amount_paid, created: first.created };
    check("at the trial end: active, first invoice = Pro $99 only (seat dropped at trial end), seats 0", cS.status === "active" && first?.status === "paid" && first.amount_paid === 9900 && (await a.qty(P.seat_month)) === 0, { st: cS.status, inv: RECORD.trialEndInvoice });

    // ═══ C. crash after the trial charge → sweep refunds exactly once ═══
    console.log("\n── C. Crash after the trial charge, settled by the sweep ──");
    const c = await world("crash");
    customers.push(c.customer.id);
    const cSub = await trialSub(c);
    await advance(c.clock.id, cSub.trial_start! + 3 * 86400);
    const fault = { item: true, refund: true };
    const crashy = {
      subscriptions: stripe.subscriptions,
      subscriptionSchedules: stripe.subscriptionSchedules,
      subscriptionItems: {
        list: (p: Stripe.SubscriptionItemListParams) => stripe.subscriptionItems.list(p),
        update: (id: string, p: Stripe.SubscriptionItemUpdateParams) => stripe.subscriptionItems.update(id, p),
        create: async (p: Stripe.SubscriptionItemCreateParams) => { if (fault.item) { fault.item = false; throw new Error("simulated crash after the trial charge"); } return stripe.subscriptionItems.create(p); },
      },
      invoices: stripe.invoices,
      invoiceItems: stripe.invoiceItems,
      prices: stripe.prices,
      customers: stripe.customers,
      creditNotes: {
        list: (p: Stripe.CreditNoteListParams) => stripe.creditNotes.list(p),
        create: async (p: Stripe.CreditNoteCreateParams, o?: Stripe.RequestOptions) => { if (fault.refund) { fault.refund = false; throw new Error("simulated Stripe outage"); } return stripe.creditNotes.create(p, o); },
      },
    } as unknown as AddonStripe;
    const thrown = await c.apply("seat", 1, crashy).then(() => "no error", (e: Error) => e.message);
    let cr = await c.rows();
    const cInv = cr[0]?.stripeInvoiceId ? await stripe.invoices.retrieve(cr[0].stripeInvoiceId) : null;
    RECORD.crashInvoice = cInv && { id: cInv.id, status: cInv.status, amount_paid: cInv.amount_paid };
    check("crash: the charge was collected, the seat was NOT added, the row is left PAID", thrown.startsWith("simulated crash") && cr.length === 1 && cr[0].status === "paid" && cInv?.status === "paid" && (await c.qty(P.seat_month)) === 0, { thrown, rows: cr.map((x) => x.status), inv: RECORD.crashInvoice });
    let sw = await sweepAddonCharges(db, stripe as unknown as AddonStripe, { olderThanMs: 0 });
    cr = await c.rows();
    const cns = (await stripe.creditNotes.list({ invoice: cInv!.id!, limit: 10 })).data;
    RECORD.crashRefund = { sweep: sw.filter((x) => x.orgId === c.ORG), creditNotes: cns.map((n) => ({ id: n.id, amount: n.amount, refund: n.refunds?.[0]?.amount_refunded ?? null, metadata: n.metadata })) };
    check("sweep: refunds it with ONE credit note for the full amount (tagged with the attempt), row refunded, seat still not granted", cr[0].status === "refunded" && cns.length === 1 && cns[0].amount === cInv!.amount_paid && cns[0].metadata?.flowops_addon_charge_id === cr[0].id && cr[0].stripeCreditNoteId === cns[0].id && (await c.qty(P.seat_month)) === 0, RECORD.crashRefund);
    await db.update(schema.addonCharge).set({ status: "paid" }).where(eq(schema.addonCharge.id, cr[0].id)); // lost DB update
    sw = await sweepAddonCharges(db, stripe as unknown as AddonStripe, { olderThanMs: 0 });
    const cns2 = (await stripe.creditNotes.list({ invoice: cInv!.id!, limit: 10 })).data;
    check("sweep again (even with the row reset to paid): still ONE credit note (never refunds twice)", cns2.length === 1 && (await c.rows())[0].status === "refunded", { n: cns2.length });
    const ok = await c.apply("seat", 1);
    check("the next add (no faults) charges and applies normally", ok.ok && ok.charge?.kind === "trial_proration" && (await c.qty(P.seat_month)) === 1, ok);
  } catch (e) {
    failed++;
    console.log("ERROR", e instanceof Error ? e.message : e);
  } finally {
    console.log("\nRECORD", JSON.stringify(RECORD, null, 2));
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch((e) => console.log("clock delete:", id, e.message));
    for (const org of orgs) await db.delete(schema.organization).where(eq(schema.organization.id, org)).catch(() => undefined);
    console.log(`\nclocks deleted: ${clocks.length} (${clocks.join(", ")}); customers on them: ${customers.join(", ")}`);
    console.log(`${failed ? `${failed} failed` : "all passed"} · ${passed} passed (0005 review fixes, live Stripe sandbox)`);
    await getConn().pool.end().catch(() => undefined);
    process.exit(failed ? 1 : 0);
  }
})();
