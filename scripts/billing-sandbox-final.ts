// LIVE Stripe SANDBOX check of the final pricing (docs/BILLING.md §11-12). TEST MODE ONLY, never production.
//   STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres, migrated> \
//     npx tsx --conditions=react-server scripts/billing-sandbox-final.ts
// Uses the real FlowOps code (setAddonQuantity, purchaseTextPack, processStripeEvent, trialEligibility,
// checkoutSessionParams, getEntitlements) against real Stripe objects on TEST CLOCKS, with the REAL events fed
// into the local DB. Every clock it creates is deleted at the end. The secret key is never printed.
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { dbAddonChargeLedger } from "../src/lib/billing/addon-charges-db";
import { processStripeEvent } from "../src/lib/billing/webhook";
import { retrieveSubscriptionComplete, scheduledChanges, setAddonQuantity } from "../src/lib/billing/addons";
import { getEntitlements } from "../src/lib/billing/org-entitlements";
import { findLiveSubscription } from "../src/lib/billing/status";
import { purchaseTextPack, type PackStripe } from "../src/lib/billing/text-packs";
import { trialEligibility } from "../src/lib/billing/checkout";
import { checkoutSessionParams } from "../src/lib/billing/checkout-params";
import { defaultHours } from "../src/lib/tenancy/defaults";
import { ensureFinalPrices, EXPECT_ACCOUNT } from "./sandbox-final-prices";

const key = process.env.STRIPE_SECRET_KEY_TEST_US;
if (!key?.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY_TEST_US (a sk_test_ key) is required");
if (!process.env.DATABASE_URL || /neon\.tech|vercel|amazonaws/.test(process.env.DATABASE_URL)) throw new Error("A throwaway LOCAL DATABASE_URL is required");
const stripe = new Stripe(key, { appInfo: { name: "FlowOps final-pricing sandbox check" } });

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

async function advance(clockId: string, to: number) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    if ((await stripe.testHelpers.testClocks.retrieve(clockId)).status === "ready") return;
  }
  throw new Error("test clock did not become ready");
}

/** A test-clock customer with a card on file, a local org, and helpers that feed the REAL Stripe events into the local DB. */
async function world(label: string, pm = "pm_card_visa") {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `flowops-final-${label}-${n}` });
  clocks.push(clock.id);
  const ORG = `org_fin_${label}_${n}`;
  orgs.push(ORG);
  await db.insert(schema.organization).values({ id: ORG, slug: `fin-${label}-${n}`, name: `Final pricing ${label}`, hours: defaultHours() });
  const customer = await stripe.customers.create({ name: `Final pricing ${label}`, email: `final-${label}-${n}@example.test`, test_clock: clock.id, payment_method: pm, metadata: { organizationId: ORG } });
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
    for (const e of fresh) {
      seen.add(e.id);
      await processStripeEvent(e, { fetchSubscription: (id) => retrieveSubscriptionComplete(stripe, id) });
    }
    console.log(`  [${label}] processed ${fresh.length} real events (${fresh.map((e) => e.type.replace("customer.subscription.", "sub.")).join(", ")})`);
  };
  const now = async () => new Date((await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time * 1000);
  const subs = async () => (await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 10 })).data;
  const live = async () => findLiveSubscription(await subs())!;
  const invoices = async () => (await stripe.invoices.list({ customer: customer.id, limit: 30 })).data;
  const mirrored = async () => {
    const [s] = await db.select().from(schema.subscription).where(eq(schema.subscription.organizationId, ORG));
    const it = s ? await db.select().from(schema.subscriptionItem).where(eq(schema.subscriptionItem.subscriptionId, s.id)) : [];
    return { s, items: it.map((i) => `${i.priceId}:${i.quantity}`).sort() };
  };
  const ent = async () => {
    const r = await getEntitlements(ORG, { now: await now() });
    return r.enforced ? { reason: r.reason, seats: r.entitlements.seats, locations: r.entitlements.locations, texts: r.entitlements.monthlyTexts, branding: r.entitlements.brandingRemoved } : r;
  };
  const buy = async (quantity: number, subscription?: { id: string; status: Stripe.Subscription.Status }, env?: Record<string, string | undefined>) =>
    purchaseTextPack({ stripe: stripe as unknown as PackStripe, db, orgId: ORG, customerId: customer.id, subscription: subscription ?? (await live()), pack: "texts_1000", quantity, now: await now(), ...(env ? { env } : {}) });
  const apply = async (addon: string, quantity: number, env?: Record<string, string | undefined>) => setAddonQuantity({ stripe, subscription: await live(), addon, quantity, ...(env ? { env } : {}), ledger: dbAddonChargeLedger(db, ORG) });
  return { clock, ORG, customer, drain, now, subs, live, invoices, mirrored, ent, buy, apply };
}

(async () => {
  const acct = await stripe.accounts.retrieveCurrent();
  check(`connected to the expected US sandbox account (${EXPECT_ACCOUNT})`, acct.id === EXPECT_ACCOUNT);
  if (acct.id !== EXPECT_ACCOUNT) process.exit(1);

  // ── prices ──
  const P = await ensureFinalPrices(stripe, () => undefined);
  const expect: [string, number, "month" | "year" | "one_time"][] = [
    ["starter_month", 4900, "month"], ["pro_month", 9900, "month"], ["business_month", 19900, "month"],
    ["flowops_starter_annual", 49000, "year"], ["flowops_pro_annual", 99000, "year"], ["flowops_business_annual", 199000, "year"],
    ["seat_month", 1000, "month"], ["location_month", 2900, "month"], ["branding_month", 1500, "month"],
    ["flowops_addon_seat_annual", 10000, "year"], ["flowops_addon_location_annual", 29000, "year"], ["flowops_addon_branding_annual", 15000, "year"],
    ["flowops_texts_1000_pack", 1500, "one_time"],
  ];
  for (const [k, cents, interval] of expect) {
    const pr = await stripe.prices.retrieve(P[k]);
    check(`price ${k} ${P[k]}: test-mode, active, ${cents}¢ ${interval}, flowops_final=true, placeholder=false`, !pr.livemode && pr.active && pr.unit_amount === cents && (interval === "one_time" ? pr.type === "one_time" : pr.recurring?.interval === interval) && pr.metadata.flowops_final === "true" && pr.metadata.placeholder === "false", { a: pr.unit_amount, m: pr.metadata, t: pr.type });
  }
  console.log("PRICES", JSON.stringify(P));

  const env = {
    BILLING_ENABLED: "true",
    STRIPE_PRICE_STARTER: P.starter_month, STRIPE_PRICE_PRO: P.pro_month, STRIPE_PRICE_BUSINESS: P.business_month,
    STRIPE_PRICE_STARTER_ANNUAL: P.flowops_starter_annual, STRIPE_PRICE_PRO_ANNUAL: P.flowops_pro_annual, STRIPE_PRICE_BUSINESS_ANNUAL: P.flowops_business_annual,
    STRIPE_ADDON_PRICE_SEAT: P.seat_month, STRIPE_ADDON_PRICE_LOCATION: P.location_month, STRIPE_ADDON_PRICE_BRANDING: P.branding_month,
    STRIPE_ADDON_PRICE_SEAT_ANNUAL: P.flowops_addon_seat_annual, STRIPE_ADDON_PRICE_LOCATION_ANNUAL: P.flowops_addon_location_annual, STRIPE_ADDON_PRICE_BRANDING_ANNUAL: P.flowops_addon_branding_annual,
    STRIPE_ADDON_PRICE_TEXTS_1000: P.flowops_texts_1000_pack,
  };
  Object.assign(process.env, env);
  for (const k of Object.keys(process.env)) if (k.startsWith("PLAN_LIMITS_") || k.startsWith("STRIPE_ADDON_MAX_") || k === "TRIAL_DAYS") delete process.env[k];
  const customersToDelete: string[] = [];

  try {
    // ═══ 1. Checkout Session parameters accepted by Stripe (trial + annual) ═══
    console.log("\n── 1. Checkout sessions ──");
    const plain = await stripe.customers.create({ email: `final-checkout-${n}@example.test`, metadata: { organizationId: `org_fin_checkout_${n}` } });
    customersToDelete.push(plain.id);
    const mk = (priceId: string, trialDays: number) => stripe.checkout.sessions.create(checkoutSessionParams({ orgId: `org_fin_checkout_${n}`, customer: plain.id, priceId, origin: "https://example.test", trialDays }));
    const sTrial = await mk(P.starter_month, 14);
    check("trial Checkout Session created by Stripe: subscription mode, card always collected", sTrial.mode === "subscription" && sTrial.payment_method_collection === "always" && !!sTrial.url && !sTrial.livemode, { m: sTrial.mode, p: sTrial.payment_method_collection });
    const sd = (sTrial as unknown as { subscription_data?: { trial_period_days?: number; trial_settings?: { end_behavior?: { missing_payment_method?: string } } } }).subscription_data;
    console.log("  checkout subscription_data echoed by Stripe:", JSON.stringify(sd ?? null));
    check("trial Checkout Session: Stripe reports trial_period_days = 14 (when echoed) and the cancel-if-no-card setting", sd === undefined || (sd.trial_period_days === 14 && sd.trial_settings?.end_behavior?.missing_payment_method === "cancel"), sd);
    await stripe.checkout.sessions.expire(sTrial.id);
    const sAnnual = await mk(P.flowops_pro_annual, 14);
    const items = await stripe.checkout.sessions.listLineItems(sAnnual.id);
    check("annual Checkout Session: the line item is the annual Pro price ($990/yr)", items.data[0]?.price?.id === P.flowops_pro_annual && items.data[0]?.price?.unit_amount === 99000 && items.data[0]?.price?.recurring?.interval === "year", items.data[0]?.price?.id);
    await stripe.checkout.sessions.expire(sAnnual.id);
    const sNoTrial = await mk(P.starter_month, 0);
    const sd2 = (sNoTrial as unknown as { subscription_data?: { trial_period_days?: number } }).subscription_data;
    check("no-trial Checkout Session (TRIAL_DAYS=0 / not eligible) carries no trial", sd2?.trial_period_days === undefined, sd2);
    await stripe.checkout.sessions.expire(sNoTrial.id);

    // ═══ 2. Trial: full access, text pack charged now during the trial, trial → active at day 14, one trial per org ═══
    console.log("\n── 2. Trial lifecycle (Starter monthly) ──");
    const t = await world("trial");
    check("before any subscription the org is trial-eligible", (await trialEligibility(t.ORG, t.customer.id, { db, stripe })).eligible === true);
    const t0 = Math.floor((await t.now()).getTime() / 1000);
    const trialSub = await stripe.subscriptions.create({
      customer: t.customer.id, items: [{ price: P.starter_month }], trial_period_days: 14,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } }, metadata: { organizationId: t.ORG },
    });
    await t.drain();
    let m = await t.mirrored();
    const trialEnd = trialSub.trial_end!;
    check("subscription is trialing for 14 days (trial_end = now + 14d)", trialSub.status === "trialing" && Math.abs(trialEnd - (t0 + 14 * 86400)) < 5, { st: trialSub.status, d: (trialEnd - t0) / 86400 });
    check("mirror: trialing; entitlements = full Starter (3 / 1 / 500)", m.s?.status === "trialing" && JSON.stringify(await t.ent()) === JSON.stringify({ reason: "ok", seats: 3, locations: 1, texts: 500, branding: false }), { s: m.s?.status, e: await t.ent() });
    check("no charge yet: the only invoice is the $0 trial invoice", (await t.invoices()).length === 1 && (await t.invoices())[0].amount_paid === 0, (await t.invoices()).map((i) => i.amount_paid));
    check("trial org is no longer eligible for ANOTHER trial (it has a subscription)", (await trialEligibility(t.ORG, t.customer.id, { db, stripe })).eligible === false);

    let pr = await t.buy(2, { id: trialSub.id, status: "trialing" });
    check("TRIAL: a text pack is charged in FULL immediately ($15 × 2 = $30) to the card on file", pr.ok && pr.duringTrial && pr.amountPaid === 3000 && pr.texts === 2000, pr);
    const packInv = pr.ok ? await stripe.invoices.retrieve(pr.invoiceId) : null;
    check("TRIAL: the pack invoice is paid NOW, standalone (not on the subscription, not deferred to trial end)", packInv?.status === "paid" && packInv.amount_paid === 3000 && !packInv.parent?.subscription_details?.subscription, { st: packInv?.status, parent: packInv?.parent?.type });
    check("TRIAL: texts granted only after payment: 500 + 2000 = 2500", (await t.ent() as { texts: number }).texts === 2500, await t.ent());
    check("TRIAL: the pack's purchase window ends with the trial (windowEnd = trial end); it rolls over one month past that (0004)", pr.ok && Math.abs(new Date(pr.windowEnd).getTime() / 1000 - trialEnd) < 5 && new Date(pr.validUntil).getTime() / 1000 > trialEnd + 27 * 86400 && new Date(pr.validUntil).getTime() / 1000 < trialEnd + 32 * 86400, pr.ok && [pr.windowEnd, pr.validUntil]);
    pr = await t.buy(8, { id: trialSub.id, status: "trialing" });
    check("pack cap: 2 + 8 = 10 packs in the period is allowed", pr.ok, pr);
    pr = await t.buy(1, { id: trialSub.id, status: "trialing" });
    check("pack cap: an 11th pack in the same period → 400, no invoice created", !pr.ok && pr.status === 400 && pr.code === "cap", pr);
    check("pack cap: entitlements 500 + 10 × 1000 = 10500", (await t.ent() as { texts: number }).texts === 10500, await t.ent());
    await t.drain();
    check("webhook: invoice.paid for pack invoices settles/keeps packs paid and never touches the subscription (still trialing)", (await t.mirrored()).s?.status === "trialing" && (await t.ent() as { texts: number }).texts === 10500, (await t.mirrored()).s?.status);

    // trial → active at day 14
    await advance(t.clock.id, trialEnd + 3600);
    await t.drain();
    m = await t.mirrored();
    const afterTrial = (await t.subs())[0];
    const first = (await t.invoices()).find((i) => i.billing_reason === "subscription_cycle");
    check("DAY 14: trial → active, first real invoice paid: $49.00 (the packs are not on it)", afterTrial.status === "active" && m.s?.status === "active" && first?.status === "paid" && first.amount_paid === 4900, { st: afterTrial.status, mir: m.s?.status, inv: first && [first.status, first.amount_paid] });
    check("DAY 14: the 10 trial packs roll over into the first paid month (0004) → 500 + 10000 = 10500", (await t.ent() as { texts: number }).texts === 10500, await t.ent());
    pr = await t.buy(1);
    check("new billing period: the pack cap resets even with 10 rolled-over packs (1 pack allowed again), charged $15 → 11500", pr.ok && pr.amountPaid === 1500 && !pr.duringTrial && (await t.ent() as { texts: number }).texts === 11500, pr);

    // one trial per business
    await stripe.subscriptions.cancel(trialSub.id);
    await t.drain();
    check("cancel + resubscribe: NO second trial (mirror says canceled, Stripe says canceled)", (await trialEligibility(t.ORG, t.customer.id, { db, stripe })).eligible === false);
    await db.delete(schema.subscription).where(eq(schema.subscription.organizationId, t.ORG)); // simulate a lagging / empty mirror
    check("…even if our mirror lags or is empty: Stripe's own subscription list still blocks the trial", (await trialEligibility(t.ORG, t.customer.id, { db, stripe })).eligible === false);
    check("…so the checkout the route would create has no trial", (checkoutSessionParams({ orgId: t.ORG, customer: t.customer.id, priceId: P.starter_month, origin: "https://x.test", trialDays: 0 }).subscription_data?.trial_period_days) === undefined);
    const other = await world("trial2");
    check("a different org with no history is still eligible (the guard is per business, not global)", (await trialEligibility(other.ORG, other.customer.id, { db, stripe })).eligible === true);

    // ═══ 3. Failed card on a text pack ═══
    console.log("\n── 3. Declined card on a text pack (Pro monthly) ──");
    const f = await world("decline");
    const fsub = await stripe.subscriptions.create({ customer: f.customer.id, items: [{ price: P.pro_month }], metadata: { organizationId: f.ORG } });
    await f.drain();
    check("Pro monthly active, 10 / 1 / 2000 / branding", JSON.stringify(await f.ent()) === JSON.stringify({ reason: "ok", seats: 10, locations: 1, texts: 2000, branding: true }), await f.ent());
    const bad = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: f.customer.id });
    await stripe.customers.update(f.customer.id, { invoice_settings: { default_payment_method: bad.id } });
    await stripe.subscriptions.update(fsub.id, { default_payment_method: bad.id });
    const before = (await f.invoices()).length;
    pr = await f.buy(3);
    check("DECLINED: 402 payment_failed, pointing at the portal", !pr.ok && pr.status === 402 && pr.code === "payment_failed" && pr.portal === true, pr);
    const fInvs = await f.invoices();
    const pack = fInvs.find((i) => i.metadata?.flowops_text_pack);
    check("DECLINED: the unpaid pack invoice is VOIDED (it can never be paid later), nothing collected", pack?.status === "void" && pack.amount_paid === 0 && fInvs.length === before + 1 && !fInvs.some((i) => i.status === "open" || i.status === "draft"), fInvs.map((i) => [i.status, i.amount_paid]));
    check("DECLINED: nothing granted and no unpaid pack active (texts still 2000)", (await f.ent() as { texts: number }).texts === 2000, await f.ent());
    const rows = await db.select().from(schema.textPack).where(eq(schema.textPack.organizationId, f.ORG));
    check("DECLINED: the pack row is `failed`", rows.length === 1 && rows[0].status === "failed", rows.map((r) => r.status));
    await f.drain();
    check("DECLINED: the real invoice.payment_failed webhook keeps it failed, grants nothing, and does NOT flag the subscription past_due", (await f.ent() as { texts: number }).texts === 2000 && (await f.mirrored()).s?.status === "active" && (await db.select().from(schema.textPack).where(eq(schema.textPack.organizationId, f.ORG)))[0].status === "failed", (await f.mirrored()).s?.status);
    // fixing the card makes the purchase work, and the failed attempt didn't use up the cap
    const good = await stripe.paymentMethods.attach("pm_card_mastercard", { customer: f.customer.id });
    await stripe.customers.update(f.customer.id, { invoice_settings: { default_payment_method: good.id } });
    await stripe.subscriptions.update(fsub.id, { default_payment_method: good.id });
    pr = await f.buy(10);
    check("after fixing the card, 10 packs (the full cap) go through: the failed attempt did not use up the cap; texts 2000 + 10000", pr.ok && (await f.ent() as { texts: number }).texts === 12000, pr);
    // no card at all
    await stripe.subscriptions.update(fsub.id, { default_payment_method: "" });
    await stripe.customers.update(f.customer.id, { invoice_settings: { default_payment_method: "" } });
    for (const pmx of (await stripe.paymentMethods.list({ customer: f.customer.id, type: "card" })).data) await stripe.paymentMethods.detach(pmx.id);
    const invsBefore = (await f.invoices()).length;
    pr = await f.buy(1);
    check("NO CARD ON FILE: 402 no_payment_method (portal), no Stripe invoice created", !pr.ok && pr.status === 402 && pr.code === "no_payment_method" && (await f.invoices()).length === invsBefore, pr);

    // ═══ 4. Annual Pro + annual add-ons ═══
    console.log("\n── 4. Annual Pro with annual add-ons ──");
    const a = await world("annual");
    await stripe.subscriptions.create({ customer: a.customer.id, items: [{ price: P.flowops_pro_annual }], metadata: { organizationId: a.ORG } });
    await a.drain();
    let am = await a.mirrored();
    const aFirst = (await a.invoices())[0];
    check("annual Pro: invoice $990.00 (10 × $99), mirror priceId = the ANNUAL price, entitlements = Pro (10 / 1 / 2000)", aFirst.amount_paid === 99000 && am.s?.priceId === P.flowops_pro_annual && JSON.stringify(await a.ent()) === JSON.stringify({ reason: "ok", seats: 10, locations: 1, texts: 2000, branding: true }), { amt: aFirst.amount_paid, p: am.s?.priceId, e: await a.ent() });
    const noAnnualSeat = { ...process.env, STRIPE_ADDON_PRICE_SEAT_ANNUAL: "" };
    let r = await a.apply("seat", 2, noAnnualSeat);
    check("annual subscription + no annual seat price configured → 409, nothing changed in Stripe", !r.ok && r.status === 409 && (await a.live()).items.data.length === 1, r);
    r = await a.apply("seat", 2);
    check("add 2 seats on the annual subscription → ANNUAL seat price ($100/yr each), charged now prorated (0004: at the start of the year ≈ the full $200)", r.ok && r.action === "created" && r.proration === "always_invoice" && r.charge?.kind === "proration" && r.charge.amountPaid > 19500 && r.charge.amountPaid <= 20000, r);
    const seatItem = (await a.live()).items.data.find((i) => i.price.id === P.flowops_addon_seat_annual);
    check("the new item really is the annual seat price (interval year, 10000¢) × 2", seatItem?.quantity === 2 && seatItem.price.recurring?.interval === "year" && seatItem.price.unit_amount === 10000, seatItem?.price.id);
    r = await a.apply("location", 1);
    check("add 1 location on the annual subscription → annual location price ($290/yr)", r.ok && (await a.live()).items.data.some((i) => i.price.id === P.flowops_addon_location_annual && i.price.unit_amount === 29000), r);
    await a.drain();
    am = await a.mirrored();
    check("mirror: plan + annual seat ×2 + annual location ×1; entitlements 12 seats / 2 locations", am.items.length === 3 && JSON.stringify(await a.ent()) === JSON.stringify({ reason: "ok", seats: 12, locations: 2, texts: 2000, branding: true }), { items: am.items, e: await a.ent() });
    check("adds charged now (0004): $990 + one paid proration invoice per add (seat, location); no credits", (await a.invoices()).length === 3 && (await a.invoices()).every((i) => i.status === "paid") && (await stripe.creditNotes.list({ customer: a.customer.id, limit: 5 })).data.length === 0, (await a.invoices()).map((i) => [i.billing_reason, i.amount_paid]));
    const aPeriodEnd = (await a.live()).items.data[0].current_period_end;
    pr = await a.buy(1);
    const aStart = (await a.live()).items.data[0].current_period_start;
    check("annual plan text pack: charged $15 now; bought in the current MONTH of the year, usable through the next month (0004 rollover), not the whole year", pr.ok && pr.amountPaid === 1500 && new Date(pr.windowEnd).getTime() / 1000 < aStart + 32 * 86400 && new Date(pr.windowEnd).getTime() / 1000 > aStart + 27 * 86400 && new Date(pr.validUntil).getTime() / 1000 > aStart + 58 * 86400 && new Date(pr.validUntil).getTime() / 1000 < aStart + 63 * 86400 && new Date(pr.validUntil).getTime() / 1000 < aPeriodEnd, pr.ok && [pr.windowEnd, pr.validUntil]);
    pr = await a.buy(9);
    check("annual plan pack cap is per month: 10 in this month OK, then the 11th is refused", pr.ok && !(await a.buy(1)).ok, pr);
    // decrease at period end, no refund
    r = await a.apply("seat", 1);
    const sch = (await stripe.subscriptions.retrieve((await a.live()).id)).schedule;
    const schedule = sch ? await stripe.subscriptionSchedules.retrieve(typeof sch === "string" ? sch : sch.id) : null;
    const diff = scheduledChanges(schedule, process.env);
    check("annual seat 2 → 1: scheduled for the PERIOD END (a year away); active quantity stays 2; next phase lasts a year", r.ok && r.action === "scheduled" && r.currentQuantity === 2 && r.effectiveAt === aPeriodEnd && schedule?.phases[1]?.items.some((i) => (typeof i.price === "string" ? i.price : i.price.id) === P.flowops_addon_seat_annual && i.quantity === 1) && (schedule?.phases[1]?.end_date ?? 0) > aPeriodEnd + 360 * 86400, { r, ph: schedule?.phases.map((p) => [p.start_date, p.end_date]) });
    check("GET-side diff shows seat 2 → 1 at the period end; no credit note / refund created", JSON.stringify(diff?.addons) === JSON.stringify([{ key: "seat", from: 2, to: 1 }]) && (await stripe.creditNotes.list({ customer: a.customer.id, limit: 5 })).data.length === 0, diff);
    await a.drain();
    check("entitlements still 12 seats until the renewal", (await a.ent() as { seats: number }).seats === 12, await a.ent());
    await advance(a.clock.id, aPeriodEnd + 3600);
    await a.drain();
    const renewal = (await a.invoices()).find((i) => i.billing_reason === "subscription_cycle");
    const afterA = await a.live();
    check("ANNUAL RENEWAL: seat dropped to 1 at the period end; invoice = $990 + 1 × $100 + 1 × $290 = $1,380", renewal?.status === "paid" && renewal.amount_paid === 138000 && afterA.items.data.find((i) => i.price.id === P.flowops_addon_seat_annual)?.quantity === 1, { inv: renewal && [renewal.status, renewal.amount_paid], seat: afterA.items.data.find((i) => i.price.id === P.flowops_addon_seat_annual)?.quantity });
    check("after renewal: entitlements 11 seats / 2 locations; last year's packs expired (texts back to 2000)", JSON.stringify(await a.ent()) === JSON.stringify({ reason: "ok", seats: 11, locations: 2, texts: 2000, branding: true }), await a.ent());

    // ═══ 5. Business monthly: removal at period end ═══
    console.log("\n── 5. Business monthly, seat removal at period end ──");
    const b = await world("business");
    await stripe.subscriptions.create({ customer: b.customer.id, items: [{ price: P.business_month }], metadata: { organizationId: b.ORG } });
    await b.drain();
    check("Business monthly $199: invoice 19900, entitlements 25 seats / 3 locations / 5000 texts / branding removed", (await b.invoices())[0].amount_paid === 19900 && JSON.stringify(await b.ent()) === JSON.stringify({ reason: "ok", seats: 25, locations: 3, texts: 5000, branding: true }), { amt: (await b.invoices())[0].amount_paid, e: await b.ent() });
    r = await b.apply("seat", 3);
    check("add 3 seats (monthly price) → immediate, charged now prorated (0004: at the period start ≈ the full $30)", r.ok && r.action === "created" && r.charge?.amountPaid !== undefined && r.charge.amountPaid > 2900 && r.charge.amountPaid <= 3000 && (await b.invoices()).length === 2, r);
    await b.drain();
    check("entitlements: 28 seats immediately", (await b.ent() as { seats: number }).seats === 28, await b.ent());
    const bEnd = (await b.live()).items.data[0].current_period_end;
    r = await b.apply("seat", 1);
    check("seat 3 → 1: stays 3 until period end (scheduled), no refund / credit", r.ok && r.action === "scheduled" && r.currentQuantity === 3 && r.effectiveAt === bEnd && (await b.invoices()).length === 2 && (await stripe.creditNotes.list({ customer: b.customer.id, limit: 5 })).data.length === 0, r);
    await b.drain();
    check("entitlements still 28 seats before renewal", (await b.ent() as { seats: number }).seats === 28, await b.ent());
    await advance(b.clock.id, bEnd + 3600);
    await b.drain();
    const bRen = (await b.invoices()).find((i) => i.billing_reason === "subscription_cycle");
    check("RENEWAL: invoice = $199 + 1 × $10 = $209.00; seats now 26", bRen?.status === "paid" && bRen.amount_paid === 20900 && (await b.ent() as { seats: number }).seats === 26, { inv: bRen && [bRen.status, bRen.amount_paid], e: await b.ent() });
  } catch (err) {
    failed++;
    console.log("FAIL  script error:", err instanceof Error ? err.stack ?? err.message : err);
  } finally {
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch((e) => console.log("clock delete:", id, e.message));
    for (const id of customersToDelete) await stripe.customers.del(id).catch(() => undefined);
    for (const org of orgs) await db.delete(schema.organization).where(eq(schema.organization.id, org)).catch(() => undefined);
    console.log(`\nclocks deleted: ${clocks.length} (${clocks.join(", ")})`);
    console.log(`${failed ? `${failed} failed` : "all passed"} · ${passed} passed (final pricing, live Stripe sandbox)`);
    await getConn().pool.end().catch(() => undefined);
    process.exit(failed ? 1 : 0);
  }
})();
