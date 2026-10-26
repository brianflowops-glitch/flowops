// Offline billing checks (no network, no database): `npm run test:billing`
import Stripe from "stripe";
import { isLiveKey, planByKey, planByPriceId, plans } from "../src/lib/billing/config";
import { hasPaidAccess, normalizeStatus } from "../src/lib/billing/status";

let failed = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

(async () => {
  const env = { STRIPE_PRICE_STARTER: "price_test_a", STRIPE_PRICE_PRO_ANNUAL: "price_test_b", STRIPE_PRICE_EMPTY: "", OTHER: "x" };
  check("plans() reads only non-empty STRIPE_PRICE_* vars", JSON.stringify(plans(env).map((p) => p.key)) === '["pro_annual","starter"]');
  check("planByKey is case-insensitive", planByKey("STARTER", env)?.priceId === "price_test_a");
  check("planByPriceId maps back to plan key", planByPriceId("price_test_b", env)?.key === "pro_annual");
  check("no plans configured → empty list", plans({}).length === 0);
  check("live keys detected", isLiveKey("sk_live_123") && isLiveKey("rk_live_123") && !isLiveKey("sk_test_123"));
  check("unknown status → incomplete", normalizeStatus("something_new") === "incomplete");
  check("known status kept", normalizeStatus("past_due") === "past_due");
  check("access: active/trialing yes, canceled no", hasPaidAccess("active") && hasPaidAccess("trialing") && !hasPaidAccess("canceled"));
  check("access: past_due follows grace option", hasPaidAccess("past_due") && !hasPaidAccess("past_due", { pastDueGrace: false }));

  // Signature verification, fully offline (dummy key, locally generated header).
  const stripe = new Stripe("sk_test_dummy_offline");
  const secret = "whsec_test_offline";
  const payload = JSON.stringify({ id: "evt_test_1", object: "event", type: "invoice.paid", data: { object: {} } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const ev = await stripe.webhooks.constructEventAsync(payload, header, secret);
  check("valid signature accepted", ev.id === "evt_test_1");
  let rejected = false;
  try {
    await stripe.webhooks.constructEventAsync(payload.replace("invoice.paid", "invoice.payment_failed"), header, secret);
  } catch {
    rejected = true;
  }
  check("tampered payload rejected", rejected);

  console.log(`\n${failed ? `${failed} failed` : "all passed"} (billing, offline)`);
  process.exit(failed ? 1 : 0);
})();
