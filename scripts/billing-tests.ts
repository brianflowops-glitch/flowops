// Offline billing checks (no network, no database): `npm run test:billing`
import Stripe from "stripe";
import { isLiveKey, planByKey, planByPriceId, plans } from "../src/lib/billing/config";
import { findLiveSubscription, hasPaidAccess, normalizeStatus } from "../src/lib/billing/status";
import {
  billingExemptOrgIds,
  billingLockedBody,
  effectiveSubscription,
  isBillingExemptPath,
  LOCKED_STATUSES,
  resolveBillingAccess,
} from "../src/lib/billing/access-rules";
import { canManageTeam } from "../src/lib/tenancy/team-rules";
import { SUBSCRIPTION_STATUSES } from "../src/lib/db/schema";

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
  check("access: past_due locked by default (no grace), grace opt-in", !hasPaidAccess("past_due") && hasPaidAccess("past_due", { pastDueGrace: true }));

  // Checkout guard (one subscription per org): which existing subscriptions block a new Checkout.
  for (const st of ["active", "trialing", "past_due", "unpaid", "paused"])
    check(`existing ${st} subscription blocks a new checkout`, findLiveSubscription([{ id: "sub_1", status: st }])?.id === "sub_1");
  check(
    "canceled / incomplete / incomplete_expired don't block a new checkout",
    findLiveSubscription([{ status: "canceled" }, { status: "incomplete" }, { status: "incomplete_expired" }]) === undefined,
  );
  check("no subscriptions → no block", findLiveSubscription([]) === undefined);
  check("live one found among canceled ones", findLiveSubscription([{ id: "a", status: "canceled" }, { id: "b", status: "past_due" }])?.id === "b");

  // Billing access lock (failed card → immediate lock; docs/BILLING.md §6).
  const on = (status: (typeof SUBSCRIPTION_STATUSES)[number] | null, exempt = false) => resolveBillingAccess({ enabled: true, exempt, status, canManageBilling: true });
  for (const st of ["active", "trialing"] as const) {
    const a = on(st);
    check(`access: ${st} → full/ok`, a.access === "full" && a.reason === "ok" && a.status === st);
  }
  for (const st of ["past_due", "unpaid", "incomplete", "incomplete_expired", "canceled", "paused"] as const) {
    const a = on(st);
    check(`access: ${st} → locked/${st}`, a.access === "locked" && a.reason === st && a.status === st);
  }
  check(
    "access: every stored status is mapped (only active/trialing are full)",
    SUBSCRIPTION_STATUSES.every((st) => on(st).access === (st === "active" || st === "trialing" ? "full" : "locked")) &&
      JSON.stringify(LOCKED_STATUSES) === JSON.stringify(SUBSCRIPTION_STATUSES.filter((x) => x !== "active" && x !== "trialing")),
  );
  check("access: no subscription row → locked/no_subscription", on(null).access === "locked" && on(null).reason === "no_subscription" && on(null).status === null);
  for (const st of [null, "past_due", "canceled", "active"] as const) {
    const a = resolveBillingAccess({ enabled: false, exempt: false, status: st, canManageBilling: false });
    check(`access: BILLING_ENABLED off → full/billing_disabled (status ${st})`, a.access === "full" && a.reason === "billing_disabled");
  }
  check("access: exempt org with no subscription → full/exempt", on(null, true).access === "full" && on(null, true).reason === "exempt");
  check("access: exempt org with past_due → full/exempt", on("past_due", true).access === "full" && on("past_due", true).reason === "exempt");
  check("access: exempt org with active → full/ok", on("active", true).reason === "ok");
  check("access: canManageBilling passed through", resolveBillingAccess({ enabled: true, exempt: false, status: "past_due", canManageBilling: false }).canManageBilling === false);
  check("canManageBilling roles: owner + admin yes, staff no", canManageTeam("owner") && canManageTeam("admin") && !canManageTeam("staff"));
  const ex = billingExemptOrgIds({ BILLING_EXEMPT_ORG_IDS: " org_flowops_demo, org_b ,," });
  check("exempt list parses comma-separated ids (trimmed, blanks dropped)", ex.size === 2 && ex.has("org_flowops_demo") && ex.has("org_b"));
  check("exempt list empty when unset", billingExemptOrgIds({}).size === 0);
  const d = (s: string) => new Date(s);
  check(
    "effective subscription: active row wins over newer canceled row",
    effectiveSubscription([{ status: "canceled", updatedAt: d("2026-10-02") }, { status: "active", updatedAt: d("2026-10-01") }])?.status === "active",
  );
  check(
    "effective subscription: otherwise the most recently updated row",
    effectiveSubscription([{ status: "canceled", updatedAt: d("2026-09-01") }, { status: "past_due", updatedAt: d("2026-10-01") }])?.status === "past_due",
  );
  check("effective subscription: none → undefined", effectiveSubscription([]) === undefined);
  for (const p of ["/api/billing/portal", "/api/billing/checkout", "/api/billing/webhook", "/api/auth/sign-out", "/api/auth/sign-in/email", "/api/invites/abc/accept"])
    check(`exempt path ${p}`, isBillingExemptPath(p));
  for (const p of ["/api/state", "/api/bookings", "/api/assistant", "/api/admin/staff", "/api/billingx", "/api/authz"]) check(`guarded path ${p}`, !isBillingExemptPath(p));
  const body = billingLockedBody(on("past_due"));
  check("402 body is {error:billing_locked, reason, status, canManageBilling}", body.error === "billing_locked" && body.reason === "past_due" && body.status === "past_due" && body.canManageBilling === true);

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
