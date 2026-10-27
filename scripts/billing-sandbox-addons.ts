// LIVE Stripe SANDBOX check for add-ons (docs/BILLING.md §11). Test mode only, never production.
//   STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres> \
//     npx tsx --conditions=react-server scripts/billing-sandbox-addons.ts
// 1. Creates (idempotently, by lookup key) clearly-labelled PLACEHOLDER add-on prices in the sandbox.
// 2. Subscribes a test-clock customer to Starter, changes add-ons through setAddonQuantity (the same code
//    the API route runs), feeds the REAL Stripe events + fetched subscriptions through processStripeEvent
//    into the local DB, and checks mirroring, entitlements and invoices end to end.
// 3. Schedules decreases/removals (they stay active until the period ends), advances the clock past two renewals and checks
//    that they drop at renewal and the renewal invoices bill exactly what is active then. Deletes its test clock + test org.
// The secret key is read from the environment and never printed.
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { processStripeEvent } from "../src/lib/billing/webhook";
import { retrieveSubscriptionComplete, scheduledChanges, setAddonQuantity } from "../src/lib/billing/addons";
import { getEntitlements } from "../src/lib/billing/org-entitlements";
import { findLiveSubscription } from "../src/lib/billing/status";
import { defaultHours } from "../src/lib/tenancy/defaults";

const key = process.env.STRIPE_SECRET_KEY_TEST_US;
if (!key?.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY_TEST_US (a sk_test_ key) is required");
if (!process.env.DATABASE_URL || /neon\.tech|vercel|amazonaws/.test(process.env.DATABASE_URL)) throw new Error("A throwaway LOCAL DATABASE_URL is required");
const EXPECT_ACCOUNT = "acct_1UUvH95iQFiJ57yp";
const STARTER = "price_1UUvY25iQFiJ57ypFl4SOyNb";
const PRO = "price_1UUvY35iQFiJ57ypBQeXz1q5";
const stripe = new Stripe(key, { appInfo: { name: "FlowOps add-on sandbox check" } });

// Placeholder prices (cents/month): NOT approved pricing.
const PLACEHOLDERS = [
  { key: "seat", name: "FlowOps extra seat (PLACEHOLDER price, not approved)", cents: 1000 },
  { key: "location", name: "FlowOps extra location (PLACEHOLDER price, not approved)", cents: 2900 },
  { key: "texts_1000", name: "FlowOps 1,000 extra texts (PLACEHOLDER price, not approved)", cents: 1500 },
  { key: "branding", name: "FlowOps branding removal (PLACEHOLDER price, not approved)", cents: 1500 },
];

let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = Date.now();

async function ensureAddonPrices() {
  const out: Record<string, string> = {};
  for (const p of PLACEHOLDERS) {
    const lookup_key = `test_addon_${p.key}_monthly`;
    const found = await stripe.prices.list({ lookup_keys: [lookup_key], active: true, limit: 1 });
    if (found.data[0]) {
      out[p.key] = found.data[0].id;
      continue;
    }
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: p.cents,
      recurring: { interval: "month" },
      lookup_key,
      nickname: `${p.key} add-on (placeholder)`,
      metadata: { flowops_addon: p.key, placeholder: "true", note: "placeholder price pending Brian's approval" },
      product_data: { name: p.name, metadata: { flowops_addon: p.key, placeholder: "true" } },
    });
    out[p.key] = price.id;
  }
  return out;
}

/**
 * A downgrade scheduled in the Customer Portal is a subscription schedule (docs: the portal "creates and attaches a
 * subscription schedule"). Build the same shape through the API (Pro now, Starter next phase) and check that add-on
 * changes edit that schedule's phases instead of overwriting or replacing it.
 */
async function portalDowngradeScenario(addonPrices: Record<string, string>) {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `flowops-addons-portal-${n}` });
  console.log("test clock (portal-downgrade scenario):", clock.id);
  try {
    const customer = await stripe.customers.create({ email: `addons-portal-${n}@example.test`, test_clock: clock.id, payment_method: "pm_card_visa" });
    const pms = await stripe.paymentMethods.list({ customer: customer.id, type: "card" });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pms.data[0].id } });
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: PRO }, { price: addonPrices.seat, quantity: 2 }] });
    const periodEnd = sub.items.data[0].current_period_end;
    // The portal's scheduled downgrade: current phase unchanged, next phase on Starter.
    const sched = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    const p0 = sched.phases[0];
    const toItems = (items: { price: string | { id: string }; quantity?: number }[]) => items.map((i) => ({ price: typeof i.price === "string" ? i.price : i.price.id, quantity: i.quantity ?? 1 }));
    await stripe.subscriptionSchedules.update(sched.id, {
      end_behavior: "release",
      phases: [
        { start_date: p0.start_date, end_date: p0.end_date, items: toItems(p0.items), proration_behavior: "none" },
        { items: [{ price: STARTER, quantity: 1 }, { price: addonPrices.seat, quantity: 2 }], duration: { interval: "month", interval_count: 1 }, proration_behavior: "none" },
      ],
    });
    const show = async () => {
      const sc = await stripe.subscriptionSchedules.retrieve(sched.id);
      return { sc, str: sc.phases.map((p) => p.items.map((i) => `${typeof i.price === "string" ? i.price : i.price.id}×${i.quantity}`).sort().join(",")) };
    };
    const tag = (id: string) => (id === PRO ? "PRO" : id === STARTER ? "STARTER" : id === addonPrices.seat ? "seat" : id);
    const norm = (strs: string[]) => strs.map((x) => x.split(",").map((y) => y.replace(/^price_\w+(?=×)/, (m) => tag(m))).join(","));
    const apply = async (addon: string, quantity: number) => setAddonQuantity({ stripe, subscription: sub, addon, quantity });

    let r = await apply("seat", 1);
    let st = await show();
    check("portal downgrade pending: seat 2 → 1 is scheduled on the SAME schedule; plan downgrade kept", r.ok && r.action === "scheduled" && st.sc.id === sched.id && JSON.stringify(norm(st.str)) === JSON.stringify(["PRO×1,seat×2", "STARTER×1,seat×1"]), { r, st: norm(st.str) });
    r = await apply("seat", 2);
    st = await show();
    check("…cancelling the seat reduction keeps the portal's downgrade (schedule not released)", r.ok && r.action === "schedule_cleared" && (await stripe.subscriptions.retrieve(sub.id)).schedule === sched.id && JSON.stringify(norm(st.str)) === JSON.stringify(["PRO×1,seat×2", "STARTER×1,seat×2"]), { r, st: norm(st.str) });
    r = await apply("seat", 3);
    st = await show();
    check("…a seat increase applies now and is carried into the downgraded phase (not lost at renewal)", r.ok && r.action === "updated" && JSON.stringify(norm(st.str)) === JSON.stringify(["PRO×1,seat×3", "STARTER×1,seat×3"]), { r, st: norm(st.str) });
    const now = await stripe.subscriptions.retrieve(sub.id);
    check("…the live subscription already has 3 seats and still no extra invoice", now.items.data.find((i) => i.price.id === addonPrices.seat)?.quantity === 3 && (await stripe.invoices.list({ customer: customer.id, limit: 5 })).data.length === 1);

    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: periodEnd + 3600 });
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      if ((await stripe.testHelpers.testClocks.retrieve(clock.id)).status === "ready") break;
    }
    const after = await stripe.subscriptions.retrieve(sub.id);
    const renewal = (await stripe.invoices.list({ customer: customer.id, limit: 5 })).data.find((i) => i.billing_reason === "subscription_cycle");
    check("renewal: now on Starter with 3 seats; invoice = 4900 + 3×1000 = 7900", after.items.data.some((i) => i.price.id === STARTER) && !after.items.data.some((i) => i.price.id === PRO) && after.items.data.find((i) => i.price.id === addonPrices.seat)?.quantity === 3 && renewal?.amount_paid === 7900, { items: after.items.data.map((i) => [tag(i.price.id), i.quantity]), paid: renewal?.amount_paid });
  } finally {
    await stripe.testHelpers.testClocks.del(clock.id).catch((e) => console.log("clock delete:", e.message));
  }
}

(async () => {
  const acct = await stripe.accounts.retrieveCurrent();
  check(`connected to the expected US sandbox account (${EXPECT_ACCOUNT})`, acct.id === EXPECT_ACCOUNT);
  if (acct.id !== EXPECT_ACCOUNT) process.exit(1);

  const addonPrices = await ensureAddonPrices();
  console.log("add-on prices:", JSON.stringify(addonPrices));
  for (const [k, id] of Object.entries(addonPrices)) {
    const pr = await stripe.prices.retrieve(id);
    check(`price ${k}: ${id} is test-mode, monthly, metadata flowops_addon=${k}`, !pr.livemode && pr.recurring?.interval === "month" && pr.metadata.flowops_addon === k && pr.metadata.placeholder === "true", pr.metadata);
  }
  for (const id of [STARTER, PRO]) check(`plan price ${id} exists and is monthly`, (await stripe.prices.retrieve(id)).recurring?.interval === "month");

  // Config comes from env only (same as production).
  Object.assign(process.env, {
    STRIPE_PRICE_STARTER: STARTER,
    STRIPE_PRICE_PRO: PRO,
    STRIPE_ADDON_PRICE_SEAT: addonPrices.seat,
    STRIPE_ADDON_PRICE_LOCATION: addonPrices.location,
    STRIPE_ADDON_PRICE_TEXTS_1000: addonPrices.texts_1000,
    STRIPE_ADDON_PRICE_BRANDING: addonPrices.branding,
    BILLING_ENABLED: "true",
  });
  delete process.env.PLAN_LIMITS_STARTER;
  delete process.env.PLAN_LIMITS_PRO;

  const db = getDb();
  const ORG = `org_sbx_${n}`;
  await db.insert(schema.organization).values({ id: ORG, slug: `sbx-${n}`, name: "Sandbox add-on test", hours: defaultHours() });
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `flowops-addons-${n}` });
  console.log("test clock:", clock.id);
  const cleanup = async () => {
    await stripe.testHelpers.testClocks.del(clock.id).catch((e) => console.log("clock delete:", e.message));
    await db.delete(schema.organization).where(eq(schema.organization.id, ORG)).catch(() => undefined);
    await getConn().pool.end().catch(() => undefined);
  };

  try {
    const customer = await stripe.customers.create({ name: "Add-on sandbox test", email: `addons-${n}@example.test`, test_clock: clock.id, payment_method: "pm_card_visa", invoice_settings: { default_payment_method: undefined }, metadata: { organizationId: ORG } });
    const pms = await stripe.paymentMethods.list({ customer: customer.id, type: "card" });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pms.data[0].id } });
    const created = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: STARTER }], metadata: { organizationId: ORG } });
    console.log("subscription:", created.id, created.status);
    const seen = new Set<string>();
    const ev = (e: Stripe.Event) => processStripeEvent(e, { fetchSubscription: (id) => retrieveSubscriptionComplete(stripe, id) });

    /** Process every real event for this customer's subscription that we haven't processed yet (oldest first). */
    const drain = async (label: string) => {
      await sleep(2500);
      const all: Stripe.Event[] = [];
      for await (const e of stripe.events.list({ limit: 100, types: ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"] })) {
        const o = e.data.object as { id?: string; customer?: string };
        if (o.customer === customer.id) all.push(e);
        if (all.length > 60 || e.created < Math.floor(n / 1000) - 5) break;
      }
      const fresh = all.filter((e) => !seen.has(e.id)).reverse();
      for (const e of fresh) {
        seen.add(e.id);
        await ev(e);
      }
      console.log(`  ${label}: processed ${fresh.length} real events (${fresh.map((e) => e.type.replace("customer.subscription.", "sub.")).join(", ")})`);
      return fresh.length;
    };
    const mirrored = async () => {
      const [s] = await db.select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, created.id));
      const it = s ? await db.select().from(schema.subscriptionItem).where(eq(schema.subscriptionItem.subscriptionId, s.id)) : [];
      return { s, items: it.map((i) => `${i.priceId}:${i.quantity}`).sort() };
    };
    const ent = async () => {
      const r = await getEntitlements(ORG);
      return r.enforced ? { reason: r.reason, seats: r.entitlements.seats, locations: r.entitlements.locations, texts: r.entitlements.monthlyTexts, branding: r.entitlements.brandingRemoved } : r;
    };
    const sub = async () => (await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 10 })).data;
    const invoices = async () => (await stripe.invoices.list({ customer: customer.id, limit: 20 })).data;
    const live = async () => findLiveSubscription(await sub())!;

    await drain("after subscribe");
    let m = await mirrored();
    check("mirror: Starter subscription active, price_id = Starter, 1 item", m.s?.status === "active" && m.s.priceId === STARTER && m.items.length === 1, m);
    check("entitlements: Starter = 3 seats / 1 location / 500 texts / no branding removal", JSON.stringify(await ent()) === JSON.stringify({ reason: "ok", seats: 3, locations: 1, texts: 500, branding: false }), await ent());
    const invoicesBefore = (await invoices()).length;
    check("one invoice so far (the Starter first month)", invoicesBefore === 1, invoicesBefore);

    // ── add 2 seats + a texts bundle + branding, one at a time, through the same function the route uses ──
    const apply = async (addon: string, quantity: number) => setAddonQuantity({ stripe, subscription: await live(), addon, quantity });
    let r = await apply("seat", 2);
    check("add 2 seats → created (proration none)", r.ok && r.action === "created" && r.quantity === 2 && r.proration === "none", r);
    r = await apply("texts_1000", 1);
    check("add 1 texts bundle → created", r.ok && r.action === "created", r);
    r = await apply("branding", 1);
    check("add branding on Starter → created", r.ok && r.action === "created", r);
    await drain("after adds");
    m = await mirrored();
    check("mirror: plan + 3 add-on items, plan price_id unchanged", m.items.length === 4 && m.s?.priceId === STARTER, m);
    check("mirror: seat quantity 2 recorded", m.items.includes(`${addonPrices.seat}:2`), m.items);
    check("entitlements: 5 seats / 1 location / 1500 texts / branding removed", JSON.stringify(await ent()) === JSON.stringify({ reason: "ok", seats: 5, locations: 1, texts: 1500, branding: true }), await ent());
    check("proration none: no extra invoice created mid-cycle by the add-ons", (await invoices()).length === invoicesBefore, (await invoices()).length);
    const lines = (await stripe.invoices.createPreview({ customer: customer.id, subscription: created.id })).lines.data;
    check("upcoming invoice includes the add-ons and no proration lines", lines.length === 4 && lines.every((l) => !l.parent?.subscription_item_details?.proration), lines.map((l) => [l.description, l.amount, l.parent?.subscription_item_details?.proration]));

    // ── Stripe's own behaviour on a duplicate price: our code never creates one; confirm the guard is real ──
    let dupErr = "";
    try {
      await stripe.subscriptionItems.create({ subscription: created.id, price: addonPrices.seat, quantity: 1, proration_behavior: "none" });
    } catch (e) {
      dupErr = (e as Error).message;
    }
    check("Stripe itself rejects a second item with the same price (so our update-in-place path is required)", dupErr.length > 0, dupErr || "no error");
    r = await apply("seat", 2);
    check("same quantity again → unchanged, no write", r.ok && r.action === "unchanged", r);

    // ── increase now; decreases/removals are SCHEDULED for the renewal (stay active until then) ──
    const periodEnd = (await sub())[0].items.data[0].current_period_end;
    const schedOf = async () => {
      const sid = (await live()).schedule;
      return sid ? stripe.subscriptionSchedules.retrieve(typeof sid === "string" ? sid : sid.id) : null;
    };
    const entNow = (seats: number, texts: number, branding = true) => JSON.stringify({ reason: "ok", seats, locations: 1, texts, branding });
    r = await apply("seat", 4);
    check("seat 2 → 4 (increase) → updated now", r.ok && r.action === "updated" && r.currentQuantity === 4, r);
    check("an increase with no schedule does not create one", (await schedOf()) === null);

    r = await apply("texts_1000", 0);
    check("texts bundle → 0 → scheduled for the period end (not removed now)", r.ok && r.action === "scheduled" && r.currentQuantity === 1 && r.effectiveAt === periodEnd, r);
    let sch = await schedOf();
    const sc1 = scheduledChanges(sch, process.env);
    check("schedule: phase 1 ends at the renewal, next phase drops texts; GET-side diff = texts 1 → 0", !!sch && sch.phases.length === 2 && sch.phases[0].end_date === periodEnd && JSON.stringify(sc1?.addons) === JSON.stringify([{ key: "texts_1000", from: 1, to: 0 }]) && sc1?.entitlementsAtRenewal.monthlyTexts === 500, sc1);
    r = await apply("seat", 1);
    check("seat 4 → 1 → scheduled (edits the same schedule, texts removal kept)", r.ok && r.action === "scheduled" && r.currentQuantity === 4, r);
    r = await apply("seat", 1);
    check("repeating the same decrease → unchanged", r.ok && r.action === "unchanged", r);
    await drain("after decreases scheduled");
    m = await mirrored();
    check("mirror still shows the CURRENT items: seat 4, texts bundle, branding (nothing dropped yet)", m.items.includes(`${addonPrices.seat}:4`) && m.items.some((i) => i.startsWith(addonPrices.texts_1000)) && m.items.length === 4, m.items);
    check("entitlements unchanged until the period end: 7 seats / 1500 texts / branding", (JSON.stringify(await ent())) === entNow(7, 1500), await ent());
    check("no invoice, credit or proration created by the scheduled decreases", (await invoices()).length === invoicesBefore, (await invoices()).length);

    r = await apply("seat", 6);
    check("seat → 6 while a decrease to 1 is pending → updated now and REPLACES the pending decrease", r.ok && r.action === "updated", r);
    sch = await schedOf();
    const phaseSeat = (i: number) => sch!.phases[i].items.find((x) => (typeof x.price === "string" ? x.price : x.price.id) === addonPrices.seat)?.quantity;
    check("schedule: seat is 6 in both phases; texts removal still pending", phaseSeat(0) === 6 && phaseSeat(1) === 6 && !sch!.phases[1].items.some((x) => (typeof x.price === "string" ? x.price : x.price.id) === addonPrices.texts_1000), sch!.phases.map((p) => p.items.map((x) => [x.price, x.quantity])));
    r = await apply("branding", 0);
    check("branding → 0 → scheduled", r.ok && r.action === "scheduled", r);
    r = await apply("branding", 1);
    check("branding back to 1 → pending removal cancelled (schedule kept for the texts removal)", r.ok && r.action === "schedule_cleared" && (await schedOf()) !== null, r);
    await drain("after seat increase");
    m = await mirrored();
    check("mirror: seat 6 applied now, texts + branding still there", m.items.includes(`${addonPrices.seat}:6`) && m.items.length === 4, m.items);
    check("entitlements: 9 seats / 1500 texts / branding (increase is immediate)", JSON.stringify(await ent()) === entNow(9, 1500), await ent());
    check("GET-side diff now = only texts 1 → 0", JSON.stringify(scheduledChanges(await schedOf(), process.env)?.addons) === JSON.stringify([{ key: "texts_1000", from: 1, to: 0 }]));

    // Out-of-order / replay: feed every real event again, newest first. Nothing may change.
    const before = JSON.stringify(await mirrored().then((x) => ({ items: x.items, price: x.s?.priceId, status: x.s?.status })));
    const replay: Stripe.Event[] = [];
    for await (const e of stripe.events.list({ limit: 100, types: ["customer.subscription.updated", "customer.subscription.created"] })) {
      if ((e.data.object as { customer?: string }).customer === customer.id) replay.push(e);
      if (replay.length > 30) break;
    }
    const results = [];
    for (const e of replay) results.push((await ev(e)).status); // newest first
    const afterReplay = JSON.stringify(await mirrored().then((x) => ({ items: x.items, price: x.s?.priceId, status: x.s?.status })));
    check(`replaying ${replay.length} real events newest-first: all duplicates, mirror unchanged`, results.every((x) => x === "duplicate") && before === afterReplay, { results, before, afterReplay });

    // ── renewal #1: the texts bundle drops now; the renewal invoice bills plan + 6 seats + branding ──
    const advance = async (to: number) => {
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: to });
      for (let i = 0; i < 40; i++) {
        await sleep(2000);
        if ((await stripe.testHelpers.testClocks.retrieve(clock.id)).status === "ready") break;
      }
    };
    await advance(periodEnd + 3600);
    let inv = await invoices();
    let renewal = inv.find((i) => i.billing_reason === "subscription_cycle");
    // 49.00 Starter + 6×10 seats + 15 branding = 124.00 (the texts bundle's removal took effect at this renewal)
    check("renewal #1 invoice paid: 4900 + 6×1000 + 1500 = 12400 (texts bundle dropped at renewal, never billed)", renewal?.status === "paid" && renewal.amount_paid === 12400, renewal && { status: renewal.status, paid: renewal.amount_paid });
    check("renewal #1 invoice has no proration lines or credits", !!renewal && renewal.lines.data.every((l) => !l.parent?.subscription_item_details?.proration && l.amount > 0));
    await drain("after renewal #1");
    m = await mirrored();
    check("mirror after renewal #1: texts item pruned, seat 6 + branding + plan; period moved forward", m.s?.status === "active" && m.items.length === 3 && !m.items.some((i) => i.startsWith(addonPrices.texts_1000)) && m.items.includes(`${addonPrices.seat}:6`) && (m.s.currentPeriodEnd?.getTime() ?? 0) > periodEnd * 1000, m);
    check("entitlements after renewal #1: 9 seats / 500 texts / branding", JSON.stringify(await ent()) === entNow(9, 500), await ent());
    check("nothing left pending after renewal #1", scheduledChanges(await schedOf(), process.env) === null);

    // ── renewal #2: a decrease asked for while the schedule is on its LAST phase appends a new phase ──
    const periodEnd2 = (await sub())[0].items.data[0].current_period_end;
    r = await apply("seat", 2);
    check("seat 6 → 2 on a schedule's last phase → scheduled", r.ok && r.action === "scheduled" && r.effectiveAt === periodEnd2, r);
    check("entitlements still 9 seats until then", JSON.stringify(await ent()) === entNow(9, 500), await ent());
    await advance(periodEnd2 + 3600);
    inv = await invoices();
    renewal = inv.find((i) => i.billing_reason === "subscription_cycle" && i.id !== renewal?.id);
    check("renewal #2 invoice paid: 4900 + 2×1000 + 1500 = 8400", renewal?.status === "paid" && renewal.amount_paid === 8400, renewal && { status: renewal.status, paid: renewal.amount_paid });
    await drain("after renewal #2");
    m = await mirrored();
    check("mirror after renewal #2: seat 2", m.items.includes(`${addonPrices.seat}:2`) && m.items.length === 3, m.items);
    check("entitlements after renewal #2: 5 seats / 500 texts / branding", JSON.stringify(await ent()) === entNow(5, 500), await ent());

    // Past-due add-on change is refused (409), never reaches Stripe
    const pd = await setAddonQuantity({ stripe, subscription: { id: created.id, status: "past_due" }, addon: "seat", quantity: 9 });
    check("add-on change refused on a past_due subscription", !pd.ok && pd.status === 409, pd);
  } finally {
    await cleanup();
  }
  await portalDowngradeScenario(addonPrices);
  const leftover = await stripe.testHelpers.testClocks.retrieve(clock.id).then(() => true).catch(() => false);
  check("test clock deleted", !leftover);
  console.log(`\n${failed ? `${failed} failed` : "all passed"} (live Stripe sandbox, add-ons)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("sandbox check crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
