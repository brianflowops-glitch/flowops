// LIVE Stripe SANDBOX check of patch 0004 (docs/BILLING.md §11): mid-period add-on increases are charged NOW,
// prorated (always_invoice + pending_if_incomplete); a declined proration grants nothing; trial adds are charged
// for the rest of the trial; removals still wait for the renewal. TEST MODE ONLY, never production.
//   STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres, migrated> \
//     npx tsx --conditions=react-server scripts/billing-sandbox-0004.ts
// Real FlowOps code (setAddonQuantity, processStripeEvent, getEntitlements) against real Stripe objects on TEST
// CLOCKS; every clock and customer it creates is deleted at the end. The secret key is never printed.
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { processStripeEvent } from "../src/lib/billing/webhook";
import { retrieveSubscriptionComplete, setAddonQuantity } from "../src/lib/billing/addons";
import { getEntitlements } from "../src/lib/billing/org-entitlements";
import { findLiveSubscription } from "../src/lib/billing/status";
import { defaultHours } from "../src/lib/tenancy/defaults";
import { EXPECT_ACCOUNT } from "./sandbox-final-prices";

const key = process.env.STRIPE_SECRET_KEY_TEST_US;
if (!key?.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY_TEST_US (a sk_test_ key) is required");
if (!process.env.DATABASE_URL || /neon\.tech|vercel|amazonaws/.test(process.env.DATABASE_URL)) throw new Error("A throwaway LOCAL DATABASE_URL is required");
const stripe = new Stripe(key, { appInfo: { name: "FlowOps 0004 proration sandbox check" } });

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

async function world(label: string) {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `flowops-0004-${label}-${n}` });
  clocks.push(clock.id);
  const ORG = `org_0004_${label}_${n}`;
  orgs.push(ORG);
  await db.insert(schema.organization).values({ id: ORG, slug: `p0004-${label}-${n}`, name: `0004 ${label}`, hours: defaultHours() });
  const customer = await stripe.customers.create({ name: `FlowOps 0004 test ${label}`, email: `p0004-${label}-${n}@example.test`, test_clock: clock.id, payment_method: "pm_card_visa", metadata: { organizationId: ORG, flowops_test: "0004" } });
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
  const apply = async (addon: string, quantity: number) => setAddonQuantity({ stripe, subscription: await live(), addon, quantity, env, now: await now() });
  const qty = async (price: string) => (await stripe.subscriptions.retrieve((await live()).id)).items.data.find((i) => i.price.id === price)?.quantity ?? 0;
  return { clock, ORG, customer, drain, now, live, invoices, seats, apply, qty };
}

(async () => {
  const acct = await stripe.accounts.retrieveCurrent();
  check(`connected to the expected US sandbox account (${EXPECT_ACCOUNT}), test mode`, acct.id === EXPECT_ACCOUNT);
  if (acct.id !== EXPECT_ACCOUNT) process.exit(1);
  const customers: string[] = [];
  try {
    // ═══ A. Active Pro monthly, half-way through the period: add 2 seats → charged NOW, prorated ═══
    console.log("\n── A. Active Pro monthly: mid-period add charged now, prorated ──");
    const a = await world("active");
    customers.push(a.customer.id);
    const sub = await stripe.subscriptions.create({ customer: a.customer.id, items: [{ price: P.pro_month }], metadata: { organizationId: a.ORG, flowops_test: "0004" } });
    await a.drain();
    const pStart = sub.items.data[0].current_period_start, pEnd = sub.items.data[0].current_period_end;
    check("Pro monthly active, first invoice $99 paid", sub.status === "active" && (await a.invoices())[0].amount_paid === 9900, { st: sub.status });
    const half = pStart + Math.floor((pEnd - pStart) / 2);
    await advance(a.clock.id, half);
    await a.drain();
    const invsBefore = (await a.invoices()).length;
    const seatsBefore = await a.seats();
    let r = await a.apply("seat", 2);
    check("add 2 seats mid-period → ok, created, proration always_invoice, charge returned", r.ok && r.action === "created" && r.proration === "always_invoice" && r.charge?.kind === "proration", r);
    const invId = r.ok ? r.charge?.invoiceId : undefined;
    const inv = invId ? await stripe.invoices.retrieve(invId, { expand: ["lines"] }) : undefined;
    const expected = Math.round(2 * 1000 * (pEnd - half) / (pEnd - pStart));
    const lines = inv?.lines.data.map((l) => ({ id: l.id, amount: l.amount, desc: l.description, proration: (l as unknown as { parent?: { subscription_item_details?: { proration?: boolean } } }).parent?.subscription_item_details?.proration })) ?? [];
    RECORD.prorationInvoice = { id: inv?.id, status: inv?.status, billing_reason: inv?.billing_reason, amount_due: inv?.amount_due, amount_paid: inv?.amount_paid, expected, lines };
    check(`Stripe created and PAID an immediate invoice (subscription_update) for ≈ ${expected}¢ (2 × $10 × remaining/period)`, inv?.status === "paid" && inv.billing_reason === "subscription_update" && Math.abs((inv.amount_paid ?? 0) - expected) <= 5 && (inv.amount_paid ?? 0) > 900 && (inv.amount_paid ?? 0) < 1100, RECORD.prorationInvoice);
    check("the invoice lines are prorations for the seat price", lines.length >= 1 && lines.every((l) => l.proration === true) && inv!.lines.data.every((l) => (l as unknown as { pricing?: { price_details?: { price?: string } } }).pricing?.price_details?.price === P.seat_month), lines);
    check("exactly one new invoice", (await a.invoices()).length === invsBefore + 1);
    const s1 = await stripe.subscriptions.retrieve(sub.id);
    check("subscription: seats item 2, no pending_update, still active", (await a.qty(P.seat_month)) === 2 && !s1.pending_update && s1.status === "active", { pu: s1.pending_update, st: s1.status });
    await a.drain();
    check("entitlements: +2 seats immediately", (await a.seats()) === seatsBefore + 2, { before: seatsBefore, after: await a.seats() });

    // ═══ B. Failing card: an add grants nothing ═══
    console.log("\n── B. Declined proration grants nothing ──");
    const bad = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: a.customer.id });
    await stripe.customers.update(a.customer.id, { invoice_settings: { default_payment_method: bad.id } });
    const invsB = (await a.invoices()).length;
    r = await a.apply("seat", 4);
    check("add 2 more seats with a card that declines → 402 payment_failed, portal pointer", !r.ok && r.status === 402 && r.code === "payment_failed" && r.portal === true, r);
    const s2 = await stripe.subscriptions.retrieve(sub.id);
    const bInvs = await a.invoices();
    const failedInv = bInvs[0]; // newest first
    RECORD.declinedInvoice = { id: failedInv.id, status: failedInv.status, amount_due: failedInv.amount_due, amount_paid: failedInv.amount_paid };
    check("Stripe kept the update PENDING and it was discarded: no pending_update, seats still 2", !s2.pending_update && (await a.qty(P.seat_month)) === 2 && s2.status === "active", { pu: s2.pending_update, q: await a.qty(P.seat_month), st: s2.status });
    check("the declined proration invoice is VOIDED (cannot be collected later), nothing paid", bInvs.length === invsB + 1 && failedInv.status === "void" && failedInv.amount_paid === 0, RECORD.declinedInvoice);
    await a.drain();
    check("entitlements unchanged after the declined add", (await a.seats()) === seatsBefore + 2, await a.seats());
    // restore a good card
    const good = await stripe.paymentMethods.attach("pm_card_visa", { customer: a.customer.id });
    await stripe.customers.update(a.customer.id, { invoice_settings: { default_payment_method: good.id } });

    // ═══ C. Removal unchanged; an increase over a pending decrease is charged and keeps the schedule coherent ═══
    console.log("\n── C. Removal still waits for the renewal ──");
    const invsC = (await a.invoices()).length;
    r = await a.apply("seat", 1);
    check("seat 2 → 1: scheduled for the renewal, no invoice, no credit note", r.ok && r.action === "scheduled" && r.currentQuantity === 2 && r.effectiveAt === pEnd && r.charge === null && (await a.invoices()).length === invsC && (await stripe.creditNotes.list({ customer: a.customer.id, limit: 5 })).data.length === 0, r);
    r = await a.apply("seat", 3);
    const cInv = r.ok && r.charge ? await stripe.invoices.retrieve(r.charge.invoiceId) : undefined;
    const s3 = await stripe.subscriptions.retrieve(sub.id);
    RECORD.increaseOverPendingDecrease = { result: r.ok ? { action: r.action, charge: r.charge } : r, invoice: cInv && { id: cInv.id, status: cInv.status, amount_paid: cInv.amount_paid }, schedule: s3.schedule };
    check("then seat → 3: charged now for the ONE extra seat (≈ half of $10), quantity 3 now", r.ok && cInv?.status === "paid" && Math.abs(cInv.amount_paid - Math.round(1000 * (pEnd - half) / (pEnd - pStart))) <= 5 && (await a.qty(P.seat_month)) === 3, RECORD.increaseOverPendingDecrease);
    let nextQty: number | null = 3;
    if (s3.schedule) {
      const sch = await stripe.subscriptionSchedules.retrieve(typeof s3.schedule === "string" ? s3.schedule : s3.schedule.id);
      const nxt = sch.phases.find((p) => p.start_date >= pEnd);
      nextQty = nxt?.items.find((i) => (typeof i.price === "string" ? i.price : i.price.id) === P.seat_month)?.quantity ?? 0;
    }
    check("the stale pending decrease is superseded: the renewal keeps 3 seats (schedule released or next phase = 3)", nextQty === 3, { schedule: s3.schedule, nextQty });
    await advance(a.clock.id, pEnd + 3600);
    await a.drain();
    const ren = (await a.invoices()).find((i) => i.billing_reason === "subscription_cycle");
    RECORD.renewal = ren && { id: ren.id, status: ren.status, amount_paid: ren.amount_paid };
    check("RENEWAL: $99 + 3 × $10 = $129, no double charge for the prorated seats", ren?.status === "paid" && ren.amount_paid === 12900, RECORD.renewal);

    // ═══ D. Trial: add charged for the rest of the trial; no card → 402 ═══
    console.log("\n── D. Trial add-on charge ──");
    const t = await world("trial");
    customers.push(t.customer.id);
    const tSub = await stripe.subscriptions.create({ customer: t.customer.id, items: [{ price: P.pro_month }], trial_period_days: 14, trial_settings: { end_behavior: { missing_payment_method: "cancel" } }, metadata: { organizationId: t.ORG, flowops_test: "0004" } });
    await t.drain();
    await advance(t.clock.id, tSub.trial_start! + 7 * 86400);
    const tNow = Math.floor((await t.now()).getTime() / 1000);
    r = await t.apply("seat", 1);
    const tInv = r.ok && r.charge ? await stripe.invoices.retrieve(r.charge.invoiceId) : undefined;
    const monthFromNow = Date.UTC(new Date(tNow * 1000).getUTCFullYear(), new Date(tNow * 1000).getUTCMonth() + 1, new Date(tNow * 1000).getUTCDate(), new Date(tNow * 1000).getUTCHours(), new Date(tNow * 1000).getUTCMinutes(), new Date(tNow * 1000).getUTCSeconds()) / 1000;
    const tExpected = Math.round(1000 * (tSub.trial_end! - tNow) / (monthFromNow - tNow));
    RECORD.trialInvoice = tInv && { id: tInv.id, status: tInv.status, amount_paid: tInv.amount_paid, expected: tExpected, metadata: tInv.metadata };
    check(`trialing + 1 seat → charged NOW on our own invoice for the rest of the trial (≈ ${tExpected}¢), item added`, r.ok && r.charge?.kind === "trial_proration" && tInv?.status === "paid" && Math.abs(tInv.amount_paid - tExpected) <= 2 && (await t.qty(P.seat_month)) === 1, { r, inv: RECORD.trialInvoice });
    const tS = await stripe.subscriptions.retrieve(tSub.id);
    check("still trialing, trial end unchanged", tS.status === "trialing" && tS.trial_end === tSub.trial_end);
    // no card at all
    await stripe.customers.update(t.customer.id, { invoice_settings: { default_payment_method: "" } });
    for (const pm of (await stripe.paymentMethods.list({ customer: t.customer.id, type: "card" })).data) await stripe.paymentMethods.detach(pm.id);
    const tInvs = (await t.invoices()).length;
    r = await t.apply("seat", 2);
    check("trialing, no card on file → 402 no_payment_method, nothing created, seats still 1", !r.ok && r.status === 402 && r.code === "no_payment_method" && (await t.invoices()).length === tInvs && (await t.qty(P.seat_month)) === 1, r);
  } catch (err) {
    failed++;
    console.log("FAIL  script error:", err instanceof Error ? err.stack ?? err.message : err);
  } finally {
    console.log("\nRECORD", JSON.stringify(RECORD, null, 2));
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch((e) => console.log("clock delete:", id, e.message));
    for (const org of orgs) await db.delete(schema.organization).where(eq(schema.organization.id, org)).catch(() => undefined);
    console.log(`\nclocks deleted: ${clocks.length} (${clocks.join(", ")}); customers on them: ${customers.join(", ")}`);
    console.log(`${failed ? `${failed} failed` : "all passed"} · ${passed} passed (0004 proration, live Stripe sandbox)`);
    await getConn().pool.end().catch(() => undefined);
    process.exit(failed ? 1 : 0);
  }
})();
