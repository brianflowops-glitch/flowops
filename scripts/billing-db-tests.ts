// Webhook processing against a THROWAWAY local Postgres (never production):
//   DATABASE_URL=postgres://…/scratch npm run test:billing:db
// Requires migrations applied to that database (npm run db:migrate) — uses the demo org.
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, getConn, schema } from "../src/lib/db";
import { processStripeEvent } from "../src/lib/billing/webhook";
import { DEMO_ORG_ID } from "../src/lib/tenancy/defaults";

if (/neon\.tech|vercel|amazonaws/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against a hosted database");

let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
};
const n = Date.now();
const ev = (id: string, type: string, object: unknown) => ({ id, type, object: "event", data: { object } }) as unknown as Stripe.Event;
const sub = (status: string, extra: Record<string, unknown> = {}) => ({
  id: `sub_test_${n}`,
  object: "subscription",
  customer: `cus_test_${n}`,
  status,
  cancel_at_period_end: false,
  metadata: {},
  items: { data: [{ price: { id: "price_test_x" }, current_period_end: 1800000000 }] },
  ...extra,
});

(async () => {
  const db = getDb();
  const r1 = await processStripeEvent(
    ev(`evt_co_${n}`, "checkout.session.completed", { id: "cs_test", client_reference_id: DEMO_ORG_ID, customer: `cus_test_${n}`, metadata: {} }),
  );
  check("checkout.session.completed processed", r1.status === "processed", r1);
  const [c] = await db.select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, DEMO_ORG_ID));
  check("customer linked to org", c?.stripeCustomerId === `cus_test_${n}`, c);

  const r2 = await processStripeEvent(ev(`evt_cr_${n}`, "customer.subscription.created", sub("incomplete")));
  check("subscription.created processed", r2.status === "processed", r2);
  const dup = await processStripeEvent(ev(`evt_cr_${n}`, "customer.subscription.created", sub("incomplete")));
  check("duplicate event id skipped", dup.status === "duplicate", dup);

  await processStripeEvent(ev(`evt_up_${n}`, "customer.subscription.updated", sub("active", { cancel_at_period_end: true })));
  let [s] = await db.select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, `sub_test_${n}`));
  check("subscription updated to active", s?.status === "active" && s.cancelAtPeriodEnd && s.priceId === "price_test_x", s);
  check("current_period_end from item", s?.currentPeriodEnd?.getTime() === 1800000000 * 1000, s?.currentPeriodEnd);

  await processStripeEvent(ev(`evt_pf_${n}`, "invoice.payment_failed", { id: "in_test" }));
  await processStripeEvent(ev(`evt_del_${n}`, "customer.subscription.deleted", sub("canceled")));
  [s] = await db.select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, `sub_test_${n}`));
  check("subscription.deleted → canceled", s?.status === "canceled", s);

  await processStripeEvent(ev(`evt_late_${n}`, "customer.subscription.updated", sub("active")));
  [s] = await db.select().from(schema.subscription).where(eq(schema.subscription.stripeSubscriptionId, `sub_test_${n}`));
  check("late updated event cannot resurrect a canceled subscription", s?.status === "canceled", s);

  const orphan = { ...sub("active"), id: `sub_orphan_${n}`, customer: `cus_unknown_${n}` };
  let threw = false;
  try {
    await processStripeEvent(ev(`evt_orphan_${n}`, "customer.subscription.updated", orphan));
  } catch {
    threw = true;
  }
  const [e] = await db.select().from(schema.stripeEvent).where(eq(schema.stripeEvent.id, `evt_orphan_${n}`));
  check("unknown org → error and event NOT recorded (Stripe retries)", threw && !e);

  const ign = await processStripeEvent(ev(`evt_ign_${n}`, "charge.refunded", {}));
  check("unhandled type ignored", ign.status === "ignored", ign);

  console.log(`\n${failed ? `${failed} failed` : "all passed"} (billing, local database)`);
  await getConn().pool.end();
  process.exit(failed ? 1 : 0);
})();
