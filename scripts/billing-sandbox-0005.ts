// LIVE Stripe SANDBOX check of patch 0005 (review fixes on PR #20, docs/BILLING.md §11). TEST MODE ONLY.
//   A. trial add with a declining card → 402; switch to a good card → retry → paid (per-attempt idempotency key)
//   B. removing an add-on during a trial keeps trial_end (schedule phases carry trial_end); trial-end invoice = plan only
//   C. crash after the trial charge (item write + refund fail) → addon_charge row stays paid → sweep refunds once
//   D. (0006 fix 3) item write confirmed, then a later step (schedule re-read) fails → row already applied → never refunded
//   A, C, D exercise the "charge_now" BRANCH explicitly (0008 made "at_trial_end" the default):
//   E. (0008, DEFAULT at_trial_end) trial add → no invoice now, no attempt row; the first invoice at the trial end bills
//      the plan + the add-ons in full
//   STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres, migrated> \
//     npx tsx --conditions=react-server scripts/billing-sandbox-0005.ts
// Every clock and customer it creates is deleted at the end. The secret key is never printed.
import Stripe from "stripe";
import { asc, eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { dbAddonChargeLedger, sweepAddonCharges } from "../src/lib/billing/addon-charges-db";
import { processStripeEvent } from "../src/lib/billing/webhook";
import { retrieveSubscriptionComplete, setAddonQuantity, setAddonQuantityUnderPolicy, TRIAL_ADDON_POLICY, type AddonStripe, type TrialAddonPolicy } from "../src/lib/billing/addons";
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
  // A/C/D: the charge_now branch, pinned. applyDefault: exactly what the route calls (TRIAL_ADDON_POLICY).
  const apply = async (addon: string, quantity: number, client: AddonStripe = stripe as unknown as AddonStripe, policy: TrialAddonPolicy = "charge_now") => setAddonQuantityUnderPolicy(policy, { stripe: client, subscription: await live(), addon, quantity, env, now: await now(), ledger });
  const applyDefault = async (addon: string, quantity: number) => setAddonQuantity({ stripe: stripe as unknown as AddonStripe, subscription: await live(), addon, quantity, env, now: await now(), ledger });
  const rows = async () => db.select().from(schema.addonCharge).where(eq(schema.addonCharge.organizationId, ORG)).orderBy(asc(schema.addonCharge.createdAt));
  const qty = async (price: string) => (await stripe.subscriptions.retrieve((await live()).id)).items.data.find((i) => i.price.id === price)?.quantity ?? 0;
  return { clock, ORG, customer, drain, now, live, invoices, seats, apply, applyDefault, qty, ledger, rows };
}

(async () => {
  const acct = await stripe.accounts.retrieveCurrent();
  check(`connected to the expected US sandbox account (${EXPECT_ACCOUNT}), test mode`, acct.id === EXPECT_ACCOUNT);
  if (acct.id !== EXPECT_ACCOUNT) process.exit(1);
  check("TRIAL_ADDON_POLICY = at_trial_end (default since 0008); A, C, D pin the charge_now branch", TRIAL_ADDON_POLICY === "at_trial_end");
  const customers: string[] = [];
  const trialSub = (w: Awaited<ReturnType<typeof world>>) => stripe.subscriptions.create({ customer: w.customer.id, items: [{ price: P.pro_month }], trial_period_days: 14, trial_settings: { end_behavior: { missing_payment_method: "cancel" } }, metadata: { organizationId: w.ORG, flowops_test: "0005" } });
  try {
    // ═══ A. decline → retry with a good card → paid ═══
    console.log("\n── A. (charge_now branch) Trial add: declined, then retried with a good card ──");
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
    console.log("\n── C. (charge_now branch) Crash after the trial charge, settled by the sweep ──");
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

    // ═══ D. 0006 fix 3: applied as soon as Stripe confirms the item, so a later failure never refunds ═══
    console.log("\n── D. (0006, charge_now branch) Item confirmed, then a later step fails ──");
    const dec = await c.apply("seat", 0); // pending removal at the trial end → a schedule with a next phase
    check("D setup: seat 1 → 0 in the trial is scheduled (schedule with a next phase)", dec.ok && dec.action === "scheduled", dec);
    let schedReads = 0;
    const lateFail = {
      ...(crashy as unknown as Record<string, unknown>),
      subscriptionItems: stripe.subscriptionItems,
      creditNotes: stripe.creditNotes,
      subscriptionSchedules: {
        create: (p: Stripe.SubscriptionScheduleCreateParams) => stripe.subscriptionSchedules.create(p),
        update: (id: string, p: Stripe.SubscriptionScheduleUpdateParams) => stripe.subscriptionSchedules.update(id, p),
        release: (id: string) => stripe.subscriptionSchedules.release(id),
        retrieve: async (id: string) => { if (++schedReads >= 2) throw new Error("simulated failure after the item write"); return stripe.subscriptionSchedules.retrieve(id); },
      },
    } as unknown as AddonStripe;
    const before = (await c.rows()).length;
    const thrownD = await c.apply("seat", 3, lateFail).then(() => "no error", (e: Error) => e.message);
    const dRows = (await c.rows()).slice(before);
    const dInv = dRows[0]?.stripeInvoiceId ? await stripe.invoices.retrieve(dRows[0].stripeInvoiceId) : null;
    RECORD.lateFail = { thrown: thrownD, rows: dRows.map((x) => ({ id: x.id, status: x.status, note: x.note })), invoice: dInv && { id: dInv.id, status: dInv.status, amount_paid: dInv.amount_paid } };
    check("0006 fix3: charged, seats 3 on Stripe, the later step's error surfaces, and the row is ALREADY applied", thrownD.startsWith("simulated failure after the item write") && dRows.length === 1 && dRows[0].status === "applied" && dInv?.status === "paid" && (await c.qty(P.seat_month)) === 3, RECORD.lateFail);
    sw = await sweepAddonCharges(db, stripe as unknown as AddonStripe, { olderThanMs: 0 });
    const dCns = (await stripe.creditNotes.list({ invoice: dInv!.id!, limit: 10 })).data;
    check("0006 fix3: the sweep leaves it alone: no credit note, row still applied, seats still 3", dCns.length === 0 && (await c.rows())[before].status === "applied" && !sw.some((x) => x.id === dRows[0].id) && (await c.qty(P.seat_month)) === 3, { sweep: sw.filter((x) => x.orgId === c.ORG), cns: dCns.length });

    // ═══ E. 0008 DEFAULT (at_trial_end): free now, billed in full on the first invoice at the trial end ═══
    console.log("\n── E. (0008, default at_trial_end) Trial add: no invoice now; billed on the first invoice at the trial end ──");
    const e = await world("trialend");
    customers.push(e.customer.id);
    const eSub = await trialSub(e);
    await advance(e.clock.id, eSub.trial_start! + 5 * 86400);
    await e.drain();
    const invs0 = await e.invoices();
    RECORD.e_invoicesBefore = invs0.map((i) => ({ id: i.id, reason: i.billing_reason, amount_paid: i.amount_paid, total: i.total }));
    const r1 = await e.applyDefault("seat", 2);
    const r2 = await e.applyDefault("location", 1);
    const invs1 = await e.invoices();
    const eS = await stripe.subscriptions.retrieve(eSub.id);
    RECORD.e_adds = { r1: r1.ok ? { action: r1.action, proration: r1.proration, charge: r1.charge, freeUntil: r1.freeUntil } : r1, r2: r2.ok ? { action: r2.action, proration: r2.proration, charge: r2.charge, freeUntil: r2.freeUntil } : r2, invoicesAfter: invs1.map((i) => ({ id: i.id, reason: i.billing_reason, amount_paid: i.amount_paid })), pending: eS.pending_update ?? null };
    check("default trial add (2 seats, 1 location) → ok, created, proration none, charge null, freeUntil = trial_end", r1.ok && r1.action === "created" && r1.proration === "none" && r1.charge === null && r1.freeUntil === eSub.trial_end && r2.ok && r2.action === "created" && r2.charge === null && r2.freeUntil === eSub.trial_end, RECORD.e_adds);
    // Stripe itself issues a $0 "Free trial for N × …" invoice (billing_reason subscription_update) for an item change during
    // a free trial (docs.stripe.com/billing/subscriptions/prorations: "updating a subscription during a free trial period …
    // creates a non-proration debit"). Nothing is charged: every such invoice is $0 and there are no charges.
    const newInvs = invs1.filter((i) => !invs0.some((x) => x.id === i.id));
    const chargesNow = (await stripe.charges.list({ customer: e.customer.id, limit: 10 })).data;
    RECORD.e_newInvoices = newInvs.map((i) => ({ id: i.id, reason: i.billing_reason, total: i.total, amount_paid: i.amount_paid, lines: i.lines.data.map((l) => [l.amount, l.description]) }));
    check("NO immediate charge: no invoice above $0 (Stripe's own $0 'Free trial for …' subscription_update invoices only), no Stripe charge, no addon_charge rows", invs1.every((i) => i.total === 0 && i.amount_paid === 0) && newInvs.every((i) => i.billing_reason === "subscription_update" && i.lines.data.every((l) => l.amount === 0 && /^Free trial for/.test(l.description ?? ""))) && chargesNow.length === 0 && (await e.rows()).length === 0, { newInvoices: RECORD.e_newInvoices, charges: chargesNow.length });
    check("items active now (seats 2, location 1), still trialing with trial_end unchanged, no pending update", (await e.qty(P.seat_month)) === 2 && (await e.qty(P.location_month)) === 1 && eS.status === "trialing" && eS.trial_end === eSub.trial_end && !eS.pending_update, { st: eS.status });
    const [proP, seatP, locP] = await Promise.all([P.pro_month, P.seat_month, P.location_month].map((id) => stripe.prices.retrieve(id)));
    const expectFirst = proP.unit_amount! + 2 * seatP.unit_amount! + locP.unit_amount!;
    const preview = await stripe.invoices.createPreview({ customer: e.customer.id, subscription: eSub.id });
    RECORD.e_preview = { total: preview.total, period_start: preview.period_start, lines: preview.lines.data.map((l) => ({ amount: l.amount, desc: l.description })) };
    check(`upcoming invoice (preview) at the trial end = Pro + 2 seats + 1 location = ${expectFirst}¢, no proration lines`, preview.total === expectFirst && preview.lines.data.every((l) => !(l as unknown as { proration?: boolean }).proration && !(l as unknown as { parent?: { subscription_item_details?: { proration?: boolean } } }).parent?.subscription_item_details?.proration), RECORD.e_preview);
    await advance(e.clock.id, eSub.trial_end! + 3600);
    await e.drain();
    const eInvs = await e.invoices();
    const eFirst = eInvs.find((i) => i.billing_reason === "subscription_cycle");
    const eA = await stripe.subscriptions.retrieve(eSub.id);
    RECORD.e_firstInvoice = eFirst && { id: eFirst.id, status: eFirst.status, amount_paid: eFirst.amount_paid, created: eFirst.created, period_start: eFirst.period_start, lines: eFirst.lines.data.map((l) => ({ amount: l.amount, qty: l.quantity, desc: l.description })) };
    RECORD.e_invoicesAll = eInvs.map((i) => ({ id: i.id, reason: i.billing_reason, amount_paid: i.amount_paid, status: i.status }));
    check(`at the trial end: active; FIRST invoice PAID = ${expectFirst}¢ (Pro ${proP.unit_amount} + 2 × ${seatP.unit_amount} + ${locP.unit_amount}), created at the trial end`, eA.status === "active" && eFirst?.status === "paid" && eFirst.amount_paid === expectFirst && Math.abs(eFirst.created - eSub.trial_end!) < 2 * 3600, RECORD.e_firstInvoice);
    const eCharges = (await stripe.charges.list({ customer: e.customer.id, limit: 10 })).data;
    RECORD.e_charges = eCharges.map((c) => ({ id: c.id, amount: c.amount, status: c.status }));
    check("the trial-end invoice is the ONLY non-zero invoice and the only charge: the add-ons were never charged separately", eInvs.filter((i) => i.amount_paid > 0).length === 1 && eInvs.filter((i) => i.amount_paid > 0)[0].id === eFirst?.id && eCharges.length === 1 && eCharges[0].amount === expectFirst, { invoices: RECORD.e_invoicesAll, charges: RECORD.e_charges });
    const eSeats = await e.seats();
    check("entitlements after the trial (webhook mirror): Pro 10 + 2 add-on seats = 12", eSeats === 12, eSeats);
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
