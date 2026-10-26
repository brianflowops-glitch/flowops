// Billing lock screen copy + 402 detection (offline): `npm run test:billing:ui`
import { isBillingLockedResponse, lockScreenCopy } from "../src/lib/billing/lock-copy";
import { billingLockedBody, LOCKED_STATUSES, resolveBillingAccess } from "../src/lib/billing/access-rules";

let failed = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const locked = (status: string | null, canManageBilling: boolean) =>
  resolveBillingAccess({ enabled: true, exempt: false, status: status as never, canManageBilling });

check("past_due + Owner/Admin → update card via portal", lockScreenCopy(locked("past_due", true)).action === "portal" && /update your card/i.test(lockScreenCopy(locked("past_due", true)).title));
check("unpaid + Owner/Admin → portal", lockScreenCopy(locked("unpaid", true)).action === "portal");
check("no subscription + Owner/Admin → choose a plan", lockScreenCopy(locked(null, true)).action === "choose_plan");
check("canceled + Owner/Admin → choose a plan (portal can't restart a canceled sub)", lockScreenCopy(locked("canceled", true)).action === "choose_plan");
for (const s of LOCKED_STATUSES) {
  const c = lockScreenCopy(locked(s, false));
  check(`${s} + Staff → contact admin, no billing action`, c.action === "contact_admin");
}
for (const s of LOCKED_STATUSES) {
  check(`${s} copy says data is safe`, /safe/.test(lockScreenCopy(locked(s, true)).message));
}
check("402 billing_locked body detected", isBillingLockedResponse(402, billingLockedBody(locked("past_due", true))));
check("other 402 not treated as lock", !isBillingLockedResponse(402, { error: "payment_required" }));
check("403 not treated as lock", !isBillingLockedResponse(403, { error: "billing_locked" }));
check("billing off → full access (no lock screen)", resolveBillingAccess({ enabled: false, exempt: false, status: null, canManageBilling: false }).access === "full");

console.log(`\n${failed ? `${failed} failed` : "all passed"} (billing lock UI, offline)`);
process.exit(failed ? 1 : 0);
