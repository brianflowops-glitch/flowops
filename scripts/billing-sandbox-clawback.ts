// LIVE Stripe SANDBOX check of text-pack clawback (refund / dispute) and in-app plan changes (docs/BILLING.md §13-14).
// TEST MODE ONLY, never production:
//   STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres, migrated> \
//     npx tsx --conditions=react-server scripts/billing-sandbox-clawback.ts
// Real FlowOps code (purchaseTextPack, processStripeEvent + the real charge fetcher, changePlan, setCancelAtPeriodEnd)
// against real Stripe objects on TEST CLOCKS (every clock it creates is deleted at the end, which deletes its customers).
// The secret key is never printed.
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { dbAddonChargeLedger } from "../src/lib/billing/addon-charges-db";
import { processStripeEvent } from "../src/lib/billing/webhook";
import { retrieveSubscriptionComplete, setAddonQuantity } from "../src/lib/billing/addons";
import { findLiveSubscription } from "../src/lib/billing/status";
import { purchaseTextPack, consumeTexts, activePaidPacks, type PackStripe } from "../src/lib/billing/text-packs";
import { stripeChargeContextFetcher, packRevocationLog } from "../src/lib/billing/clawback";
import { changePlan, changePlanUnderPolicy, setCancelAtPeriodEnd, UPGRADE_POLICY } from "../src/lib/billing/plan-change";
import { defaultHours } from "../src/lib/tenancy/defaults";
import { ensureFinalPrices, EXPECT_ACCOUNT } from "./sandbox-final-prices";

const key = process.env.STRIPE_SECRET_KEY_TEST_US;
if (!key?.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY_TEST_US (a sk_test_ key) is required");
if (!process.env.DATABASE_URL || /neon\.tech|vercel|amazonaws/.test(process.env.DATABASE_URL)) throw new Error("A throwaway LOCAL DATABASE_URL is required");
const stripe = new Stripe(key, { appInfo: { name: "FlowOps clawback + plan-change sandbox check" } });

let failed = 0;
let passed = 0;
const check = (label: string, okv: unknown, detail?: unknown) => {
  const ok = !!okv;
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = Date.now();
const clocks: string[] = [];
const db = getDb();
const orgs: string[] = [];
const fetchChargeContext = stripeChargeContextFetcher(stripe);
const SUB_EVENTS = ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"];
const CHARGE_EVENTS = ["charge.refunded", "charge.dispute.created", "charge.dispute.closed"];

async function advance(clockId: string, to: number) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    if ((await stripe.testHelpers.testClocks.retrieve(clockId)).status === "ready") return;
  }
  throw new Error("test clock did not become ready");
}

async function world(label: string) {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `flowops-clawback-${label}-${n}` });
  clocks.push(clock.id);
  const ORG = `org_cb_${label}_${n}`;
  orgs.push(ORG);
  await db.insert(schema.organization).values({ id: ORG, slug: `cb-${label}-${n}`, name: `Clawback test ${label}`, hours: defaultHours() });
  const customer = await stripe.customers.create({ name: `FlowOps clawback test ${label}`, email: `clawback-${label}-${n}@example.test`, test_clock: clock.id, payment_method: "pm_card_visa", metadata: { organizationId: ORG, flowops_test: "clawback" } });
  const pms = await stripe.paymentMethods.list({ customer: customer.id, type: "card" });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pms.data[0].id } });
  const seen = new Set<string>();
  const results: { type: string; status: string; clawback?: unknown }[] = [];
  /** Feed the REAL events for this customer (subscription / invoice / charge / dispute) into the local DB. */
  const drain = async (wait = 2500) => {
    await sleep(wait);
    const charges = new Set((await stripe.charges.list({ customer: customer.id, limit: 50 })).data.map((c) => c.id));
    const all: Stripe.Event[] = [];
    for await (const e of stripe.events.list({ limit: 100, types: [...SUB_EVENTS, ...CHARGE_EVENTS] })) {
      const o = e.data.object as { customer?: string; charge?: string | { id: string } };
      const ch = typeof o.charge === "string" ? o.charge : o.charge?.id;
      if (o.customer === customer.id || (ch && charges.has(ch))) all.push(e);
      if (all.length > 80 || e.created < Math.floor(n / 1000) - 5) break;
    }
    const fresh = all.filter((e) => !seen.has(e.id)).reverse();
    for (const e of fresh) {
      seen.add(e.id);
      const r = await processStripeEvent(e, { fetchSubscription: (id) => retrieveSubscriptionComplete(stripe, id), fetchChargeContext });
      if (e.type.startsWith("charge.")) results.push({ type: e.type, status: r.status, clawback: (r as { clawback?: unknown }).clawback });
    }
    console.log(`  [${label}] processed ${fresh.length} real events (${fresh.map((e) => e.type.replace("customer.subscription.", "sub.")).join(", ")})`);
    return fresh;
  };
  const now = async () => new Date((await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time * 1000);
  const subs = async () => (await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 10 })).data;
  const live = async () => findLiveSubscription(await subs())!;
  const invoices = async () => (await stripe.invoices.list({ customer: customer.id, limit: 30 })).data;
  const buy = async () => purchaseTextPack({ stripe: stripe as unknown as PackStripe, db, orgId: ORG, customerId: customer.id, subscription: await live(), pack: "texts_1000", quantity: 1, now: await now() });
  const apply = async (addon: string, quantity: number) => setAddonQuantity({ stripe, subscription: await live(), addon, quantity, ledger: dbAddonChargeLedger(db, ORG) });
  const pack = async (invoiceId: string) => (await db.select().from(schema.textPack).where(eq(schema.textPack.stripeInvoiceId, invoiceId)))[0];
  const usable = async () => (await activePaidPacks(db, ORG, await now())).reduce((a, p) => a + p.remaining, 0);
  const chargeOf = async (invoiceId: string) => {
    const pays = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 5 });
    const pi = pays.data.find((p) => p.status === "paid")?.payment.payment_intent;
    const piId = typeof pi === "string" ? pi : pi!.id;
    const intent = await stripe.paymentIntents.retrieve(piId);
    return { piId, chargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge!.id };
  };
  const sched = async () => {
    const s = await stripe.subscriptions.retrieve((await live()).id);
    const id = typeof s.schedule === "string" ? s.schedule : s.schedule?.id;
    return id ? stripe.subscriptionSchedules.retrieve(id) : null;
  };
  return { clock, ORG, customer, drain, results, now, live, invoices, buy, apply, pack, usable, chargeOf, sched };
}

const priceIds = (s: Stripe.Subscription) => s.items.data.map((i) => `${i.price.id}:${i.quantity}`).sort();
const phaseIds = (p?: Stripe.SubscriptionSchedule.Phase) => (p ? p.items.map((i) => `${typeof i.price === "string" ? i.price : i.price.id}:${i.quantity}`).sort() : []);

(async () => {
  const acct = await stripe.accounts.retrieveCurrent();
  check(`connected to the expected US sandbox account (${EXPECT_ACCOUNT})`, acct.id === EXPECT_ACCOUNT);
  if (acct.id !== EXPECT_ACCOUNT) process.exit(1);
  const P = await ensureFinalPrices(stripe, () => undefined);
  Object.assign(process.env, {
    BILLING_ENABLED: "true",
    STRIPE_PRICE_STARTER: P.starter_month, STRIPE_PRICE_PRO: P.pro_month, STRIPE_PRICE_BUSINESS: P.business_month,
    STRIPE_PRICE_STARTER_ANNUAL: P.flowops_starter_annual, STRIPE_PRICE_PRO_ANNUAL: P.flowops_pro_annual, STRIPE_PRICE_BUSINESS_ANNUAL: P.flowops_business_annual,
    STRIPE_ADDON_PRICE_SEAT: P.seat_month, STRIPE_ADDON_PRICE_LOCATION: P.location_month, STRIPE_ADDON_PRICE_BRANDING: P.branding_month,
    STRIPE_ADDON_PRICE_SEAT_ANNUAL: P.flowops_addon_seat_annual, STRIPE_ADDON_PRICE_LOCATION_ANNUAL: P.flowops_addon_location_annual, STRIPE_ADDON_PRICE_BRANDING_ANNUAL: P.flowops_addon_branding_annual,
    STRIPE_ADDON_PRICE_TEXTS_1000: P.flowops_texts_1000_pack,
  });
  for (const k of Object.keys(process.env)) if (k.startsWith("PLAN_LIMITS_") || k.startsWith("STRIPE_ADDON_MAX_") || k === "TRIAL_DAYS") delete process.env[k];

  try {
    // ═══ 1. Refunds ═══
    console.log("\n── 1. Text pack: partial refund → full refund ──");
    const r = await world("refund");
    await stripe.subscriptions.create({ customer: r.customer.id, items: [{ price: P.pro_month }], metadata: { organizationId: r.ORG } });
    await r.drain();
    const b1 = await r.buy();
    check("pack bought: 1000 texts, $15 charged", b1.ok && b1.amountPaid === 1500, b1);
    if (!b1.ok) throw new Error("pack purchase failed");
    await r.drain();
    const c1 = await r.chargeOf(b1.invoiceId);
    const used = await consumeTexts(db, { orgId: r.ORG, allowance: 0, sentBefore: 0, count: 200, now: await r.now() });
    check("200 texts sent from the pack (800 left)", used.denied === 0 && (await r.usable()) === 800, { used, u: await r.usable() });
    await stripe.refunds.create({ payment_intent: c1.piId, amount: 750, metadata: { flowops_test: "clawback" } });
    await r.drain();
    let p = await r.pack(b1.invoiceId);
    check("50% refund ($7.50) → charge.refunded processed → 500 texts revoked, 300 left, reason partial_refund", p.textsRevoked === 500 && p.revokedReason === "partial_refund" && p.amountRefunded === 750 && p.stripeChargeId === c1.chargeId && (await r.usable()) === 300, p);
    await stripe.refunds.create({ payment_intent: c1.piId, metadata: { flowops_test: "clawback" } });
    await r.drain();
    p = await r.pack(b1.invoiceId);
    const log1 = await packRevocationLog(db, p.id);
    check("full refund → remaining 800 revoked (never the 200 already used), 0 left, reason refund", p.textsRevoked === 800 && p.revokedReason === "refund" && p.amountRefunded === 1500 && (await r.usable()) === 0, p);
    check("revocation log: 2 rows (500, then 800 with 200 used over the revocation logged)", log1.length === 2 && log1[1].textsRevokedAfter === 800 && log1[1].textsUsedOverRevocation === 200, log1);
    const denied = await consumeTexts(db, { orgId: r.ORG, allowance: 0, sentBefore: 0, count: 1, now: await r.now() });
    check("sending from the revoked pack is denied; the plan allowance is untouched", denied.denied === 1);
    // re-delivery of the same real events → no change
    const events = (await stripe.events.list({ type: "charge.refunded", limit: 20 })).data.filter((e) => (e.data.object as Stripe.Charge).id === c1.chargeId);
    for (const e of events) await processStripeEvent(e, { fetchSubscription: (id) => retrieveSubscriptionComplete(stripe, id), fetchChargeContext });
    const p2 = await r.pack(b1.invoiceId);
    check(`re-delivering the ${events.length} real charge.refunded events is a no-op`, events.length === 2 && p2.textsRevoked === 800 && (await packRevocationLog(db, p.id)).length === 2, { n: events.length, rev: p2.textsRevoked });
    // a subscription-invoice charge refund is ignored
    const subInv = (await r.invoices()).find((i) => i.billing_reason === "subscription_create")!;
    const sc = await r.chargeOf(subInv.id);
    await stripe.refunds.create({ payment_intent: sc.piId, amount: 100, metadata: { flowops_test: "clawback" } });
    await r.drain();
    const last = r.results.at(-1);
    check("refund on the subscription invoice's charge → ignored (not a pack)", last?.type === "charge.refunded" && last.status === "ignored", r.results);
    check("every charge event was accepted (processed/ignored, never error)", r.results.every((x) => x.status === "processed" || x.status === "ignored" || x.status === "duplicate"), r.results);

    // ═══ 2. Disputes ═══
    console.log("\n── 2. Text pack: dispute opened → won (restored); dispute → lost (stays revoked) ──");
    const d = await world("dispute");
    await stripe.subscriptions.create({ customer: d.customer.id, items: [{ price: P.pro_month }], metadata: { organizationId: d.ORG } });
    await d.drain();
    const disputeCard = await stripe.paymentMethods.attach("pm_card_createDispute", { customer: d.customer.id });
    await stripe.customers.update(d.customer.id, { invoice_settings: { default_payment_method: disputeCard.id } });
    const runDispute = async (evidence: "winning_evidence" | "losing_evidence") => {
      const b = await d.buy();
      if (!b.ok) throw new Error(`pack purchase failed: ${JSON.stringify(b)}`);
      const c = await d.chargeOf(b.invoiceId);
      let dis: Stripe.Dispute | undefined;
      for (let i = 0; i < 20 && !dis; i++) { await sleep(2000); dis = (await stripe.disputes.list({ charge: c.chargeId, limit: 1 })).data[0]; }
      await d.drain();
      const open = await d.pack(b.invoiceId);
      check(`dispute ${dis?.id} opened (${dis?.status}) → all 1000 texts revoked, reason dispute`, !!dis && open.textsRevoked === 1000 && open.revokedReason === "dispute" && open.disputeStatus === dis.status, open);
      await stripe.disputes.update(dis!.id, { evidence: { uncategorized_text: evidence } });
      let st = "";
      for (let i = 0; i < 30; i++) { await sleep(2000); st = (await stripe.disputes.retrieve(dis!.id)).status; if (st === "won" || st === "lost") break; }
      await d.drain(3000);
      return { b, st, after: await d.pack(b.invoiceId) };
    };
    const won = await runDispute("winning_evidence");
    check("dispute WON (charge.dispute.closed) → 1000 texts restored, reason restored_dispute_won", won.st === "won" && won.after.textsRevoked === 0 && won.after.revokedReason === "restored_dispute_won" && won.after.disputeStatus === "won", { st: won.st, p: won.after });
    const lost = await runDispute("losing_evidence");
    check("dispute LOST → stays revoked (1000), reason dispute_lost", lost.st === "lost" && lost.after.textsRevoked === 1000 && lost.after.revokedReason === "dispute_lost", { st: lost.st, p: lost.after });
    check("dispute world: usable texts = 1000 (the won pack only)", (await d.usable()) === 1000, await d.usable());
    check("dispute events all processed/ignored", d.results.length >= 4 && d.results.every((x) => x.status !== "error"), d.results);

    // ═══ 3. Plan changes ═══
    console.log(`\n── 3. Plan changes (UPGRADE_POLICY default = ${UPGRADE_POLICY}) ──`);
    check("UPGRADE_POLICY default is prorate_now", UPGRADE_POLICY === "prorate_now");
    // 3a. upgrade now with a pending seat removal
    const u = await world("upgrade");
    await stripe.subscriptions.create({ customer: u.customer.id, items: [{ price: P.starter_month }], metadata: { organizationId: u.ORG } });
    await u.drain();
    await u.apply("seat", 2);
    const sr = await u.apply("seat", 1);
    check("starter + 2 seats, 2→1 seat pending at renewal (schedule)", sr.ok && sr.action === "scheduled", sr);
    const uEnd = (await u.live()).items.data[0].current_period_end;
    const invBefore = (await u.invoices()).length;
    let pc = await changePlan({ stripe, subscription: await u.live(), plan: "pro", interval: "month" });
    let s = await u.live();
    let sch = await u.sched();
    check("Starter → Pro (upgrade, prorate_now): applied now, charged a prorated invoice", pc.ok && pc.action === "applied" && pc.kind === "upgrade" && pc.proration === "always_invoice" && !!pc.charge && pc.charge.amountPaid > 0 && pc.charge.amountPaid <= 5000 && (await u.invoices()).length === invBefore + 1, pc);
    check("items now Pro + 2 seats; pending seat removal kept in the next phase (Pro + 1 seat)", JSON.stringify(priceIds(s)) === JSON.stringify([`${P.pro_month}:1`, `${P.seat_month}:2`].sort()) && JSON.stringify(phaseIds(sch?.phases[1])) === JSON.stringify([`${P.pro_month}:1`, `${P.seat_month}:1`].sort()), { items: priceIds(s), next: phaseIds(sch?.phases[1]) });
    await u.drain();
    const [mir] = await db.select().from(schema.subscription).where(eq(schema.subscription.organizationId, u.ORG));
    check("webhook mirror shows the Pro price", mir?.priceId === P.pro_month, mir?.priceId);
    await advance(u.clock.id, uEnd + 3600);
    await u.drain();
    const uRen = (await u.invoices()).find((i) => i.billing_reason === "subscription_cycle");
    check("renewal invoice = Pro $99 + 1 seat $10 = $109", uRen?.status === "paid" && uRen.amount_paid === 10900, uRen && [uRen.status, uRen.amount_paid]);

    // 3b. monthly → annual with add-ons (charged now, add-ons switch interval)
    const a = await world("annual");
    await stripe.subscriptions.create({ customer: a.customer.id, items: [{ price: P.pro_month }, { price: P.location_month, quantity: 1 }], metadata: { organizationId: a.ORG } });
    await a.drain();
    pc = await changePlan({ stripe, subscription: await a.live(), plan: "pro", interval: "year" });
    s = await a.live();
    check("Pro monthly → Pro annual (+1 location): upgrade applied now, charged prorated (≈ $990 + $290 − credit)", pc.ok && pc.action === "applied" && pc.kind === "upgrade" && !!pc.charge && pc.charge.amountPaid > 100000 && pc.charge.amountPaid <= 128000, pc);
    check("items: Pro annual + annual location price, interval year", JSON.stringify(priceIds(s)) === JSON.stringify([`${P.flowops_pro_annual}:1`, `${P.flowops_addon_location_annual}:1`].sort()) && s.items.data.every((i) => i.price.recurring?.interval === "year"), priceIds(s));
    // 3c. annual → monthly waits for renewal
    pc = await changePlan({ stripe, subscription: await a.live(), plan: "pro", interval: "month" });
    sch = await a.sched();
    check("Pro annual → Pro monthly: scheduled at renewal, nothing charged, next phase uses MONTHLY add-on prices", pc.ok && pc.action === "scheduled" && pc.kind === "downgrade" && !pc.charge && JSON.stringify(phaseIds(sch?.phases[1])) === JSON.stringify([`${P.pro_month}:1`, `${P.location_month}:1`].sort()) && sch?.phases[1]?.items.length === 2, { pc, next: phaseIds(sch?.phases[1]) });
    pc = await changePlan({ stripe, subscription: await a.live(), plan: "pro", interval: "year" });
    check("choosing the current plan again cancels the pending change (schedule released)", pc.ok && pc.action === "pending_cleared" && !(await a.sched()), pc);

    // 3d. downgrade at renewal + schedule-safe cancel / resume
    const dn = await world("down");
    await stripe.subscriptions.create({ customer: dn.customer.id, items: [{ price: P.business_month }, { price: P.seat_month, quantity: 2 }], metadata: { organizationId: dn.ORG } });
    await dn.drain();
    const dEnd = (await dn.live()).items.data[0].current_period_end;
    const dInv = (await dn.invoices()).length;
    pc = await changePlan({ stripe, subscription: await dn.live(), plan: "starter", interval: "month" });
    check("Business → Starter: scheduled at renewal, no charge, no credit", pc.ok && pc.action === "scheduled" && pc.effectiveAt === dEnd && (await dn.invoices()).length === dInv && (await stripe.creditNotes.list({ customer: dn.customer.id, limit: 3 })).data.length === 0, pc);
    let cr = await setCancelAtPeriodEnd(stripe, await dn.live(), true);
    sch = await dn.sched();
    check("cancel with a schedule attached: schedule end_behavior=cancel, one phase, the next phase saved", cr.ok && sch?.end_behavior === "cancel" && sch.phases.length === 1 && !!sch.metadata?.flowops_resume_next, { cr, eb: sch?.end_behavior, ph: sch?.phases.length });
    cr = await setCancelAtPeriodEnd(stripe, await dn.live(), false);
    sch = await dn.sched();
    check("resume: the pending downgrade phase is restored (Starter + 2 seats), end_behavior release", cr.ok && sch?.end_behavior === "release" && JSON.stringify(phaseIds(sch?.phases[1])) === JSON.stringify([`${P.starter_month}:1`, `${P.seat_month}:2`].sort()), { cr, next: phaseIds(sch?.phases[1]) });
    await advance(dn.clock.id, dEnd + 3600);
    await dn.drain();
    const dRen = (await dn.invoices()).find((i) => i.billing_reason === "subscription_cycle");
    check("renewal invoice = Starter $49 + 2 seats $20 = $69; subscription still active", dRen?.status === "paid" && dRen.amount_paid === 6900 && (await dn.live()).status === "active", dRen && [dRen.status, dRen.amount_paid]);
    // cancel without a schedule
    cr = await setCancelAtPeriodEnd(stripe, await dn.live(), true);
    const dl = await dn.live();
    check("cancel without a schedule → cancel_at_period_end", cr.ok && (dl.cancel_at_period_end || !!dl.cancel_at), cr);
    pc = await changePlan({ stripe, subscription: dl, plan: "pro", interval: "month" });
    check("plan change while cancelling → 409 cancel_pending", !pc.ok && pc.status === 409 && pc.code === "cancel_pending", pc);
    cr = await setCancelAtPeriodEnd(stripe, await dn.live(), false);
    check("resume without a schedule", cr.ok && !(await dn.live()).cancel_at_period_end, cr);

    // 3e. declined card → no change
    const f = await world("decline");
    await stripe.subscriptions.create({ customer: f.customer.id, items: [{ price: P.starter_month }], metadata: { organizationId: f.ORG } });
    await f.drain();
    const bad = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: f.customer.id });
    await stripe.customers.update(f.customer.id, { invoice_settings: { default_payment_method: bad.id } });
    const fs = await f.live();
    if (fs.default_payment_method) await stripe.subscriptions.update(fs.id, { default_payment_method: bad.id });
    pc = await changePlan({ stripe, subscription: await f.live(), plan: "business", interval: "month" });
    s = await stripe.subscriptions.retrieve(fs.id);
    const fInv = (await f.invoices())[0];
    check("upgrade with a declining card → 402 payment_failed, plan unchanged, no pending update, proration invoice voided", !pc.ok && pc.status === 402 && JSON.stringify(priceIds(s)) === JSON.stringify([`${P.starter_month}:1`]) && !s.pending_update && fInv.status === "void", { pc, items: priceIds(s), pu: s.pending_update, inv: fInv.status });

    // 3f. trial: upgrade (incl. interval) applies free, trial continues
    const t = await world("trial");
    const ts = await stripe.subscriptions.create({ customer: t.customer.id, items: [{ price: P.starter_month }, { price: P.seat_month, quantity: 1 }], trial_period_days: 14, trial_settings: { end_behavior: { missing_payment_method: "cancel" } }, metadata: { organizationId: t.ORG } });
    await t.drain();
    pc = await changePlan({ stripe, subscription: await t.live(), plan: "business", interval: "year" });
    s = await t.live();
    const nonZero = (await t.invoices()).filter((i) => i.amount_due > 0);
    check("trial: Starter monthly → Business annual applied, no charge, still trialing with the same trial_end", pc.ok && pc.action === "applied" && !pc.charge && s.status === "trialing" && s.trial_end === ts.trial_end && nonZero.length === 0, { pc, st: s.status, te: [s.trial_end, ts.trial_end], nz: nonZero.length });
    check("trial: items Business annual + annual seat price", JSON.stringify(priceIds(s)) === JSON.stringify([`${P.flowops_business_annual}:1`, `${P.flowops_addon_seat_annual}:1`].sort()), priceIds(s));
    pc = await changePlan({ stripe, subscription: await t.live(), plan: "pro", interval: "year" });
    check("trial: downgrade → scheduled at the trial end, no charge", pc.ok && pc.action === "scheduled" && pc.effectiveAt === ts.trial_end && (await t.invoices()).filter((i) => i.amount_due > 0).length === 0, pc);

    // 3g. at_renewal policy (kept, not default)
    const ar = await world("atrenewal");
    await stripe.subscriptions.create({ customer: ar.customer.id, items: [{ price: P.starter_month }], metadata: { organizationId: ar.ORG } });
    await ar.drain();
    const arInv = (await ar.invoices()).length;
    pc = await changePlanUnderPolicy("at_renewal", { stripe, subscription: await ar.live(), plan: "pro", interval: "month" });
    sch = await ar.sched();
    check("UPGRADE_POLICY=at_renewal: Starter → Pro scheduled at renewal, nothing charged", pc.ok && pc.action === "scheduled" && pc.kind === "upgrade" && (await ar.invoices()).length === arInv && JSON.stringify(phaseIds(sch?.phases[1])) === JSON.stringify([`${P.pro_month}:1`]), { pc, next: phaseIds(sch?.phases[1]) });
  } catch (err) {
    failed++;
    console.log("FAIL  script error:", err instanceof Error ? err.stack ?? err.message : err);
  } finally {
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch((e) => console.log("clock delete:", id, e.message));
    for (const org of orgs) await db.delete(schema.organization).where(eq(schema.organization.id, org)).catch(() => undefined);
    console.log(`\nclocks deleted: ${clocks.length} (${clocks.join(", ")})`);
    console.log(`${failed ? `${failed} failed` : "all passed"} · ${passed} passed (clawback + plan change, live Stripe sandbox)`);
    await getConn().pool.end().catch(() => undefined);
    process.exit(failed ? 1 : 0);
  }
})();
