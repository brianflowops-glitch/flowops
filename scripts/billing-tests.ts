// Offline billing checks (no network, no database): `npm run test:billing`
import Stripe from "stripe";
import { addonByKey, addonByPriceId, addonPrice, addons, isLiveKey, isTextPackKey, planByKey, planByPriceId, plans, textPackByKey, textPackSize, trialDays } from "../src/lib/billing/config";
import { addMonthsUTC, allocatePackTexts, splitTextUsage, textPackExpiry, textPackWindow, validateTextPackRequest } from "../src/lib/billing/text-pack-rules";
import { trialProrationAmount } from "../src/lib/billing/addon-charge";
import { checkoutSessionParams } from "../src/lib/billing/checkout-params";
import { addonEffect, addonMaxQuantity, resetAddonMaxWarnings, classifyItems, computeEntitlements, entitlementsFromItems, parsePlanLimits, planLimits, DEFAULT_PLAN_LIMITS } from "../src/lib/billing/entitlements";
import { configuredAddons, phaseItems, retrieveSubscriptionComplete, scheduledChanges, setAddonQuantity, validateAddonQuantity, type AddonStripe } from "../src/lib/billing/addons";
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
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
};

(async () => {
  const env = { STRIPE_PRICE_STARTER: "price_test_a", STRIPE_PRICE_PRO_ANNUAL: "price_test_b", STRIPE_PRICE_EMPTY: "", OTHER: "x" };
  check("plans() reads only non-empty STRIPE_PRICE_* vars; _ANNUAL is the plan's yearly price, not a plan key", JSON.stringify(plans(env).map((p) => [p.key, p.interval])) === '[["pro","year"],["starter","month"]]');
  check("planByKey is case-insensitive", planByKey("STARTER", env)?.priceId === "price_test_a");
  check("planByPriceId maps back to plan key (any interval)", planByPriceId("price_test_b", env)?.key === "pro" && planByPriceId("price_test_b", env)?.interval === "year");
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

  // ── add-ons: config, limits, entitlements (docs/BILLING.md §11) ──
  const aenv = { STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_PRO: "price_p", STRIPE_ADDON_PRICE_SEAT: "price_seat", STRIPE_ADDON_PRICE_LOCATION: "price_loc", STRIPE_ADDON_PRICE_TEXTS_1000: "price_pack", STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000: "price_t1k", STRIPE_ADDON_PRICE_BRANDING: "price_brand", STRIPE_ADDON_PRICE_EMPTY: "" };
  check("addons() reads only non-empty STRIPE_ADDON_PRICE_* vars, lowercased keys", JSON.stringify(addons(aenv).map((a) => a.key)) === '["branding","location","seat","texts_1000","texts_1000"]');
  check("add-on env vars are never mistaken for plans", JSON.stringify(plans(aenv).map((p) => p.key)) === '["pro","starter"]');
  check("addonByKey is case-insensitive, addonByPriceId maps back", addonByKey("SEAT", aenv)?.priceId === "price_seat" && addonByPriceId("price_t1k", aenv)?.key === "texts_1000" && addonByPriceId("price_t1k", aenv)?.legacy === true && addonByPriceId("price_pack", aenv) === undefined);
  check("no add-ons configured → empty list", addons({}).length === 0 && addonByPriceId("price_x", {}) === undefined);
  check("default limits: starter 3/1/500, no branding removal", JSON.stringify(planLimits("starter", {})) === JSON.stringify({ seats: 3, locations: 1, monthlyTexts: 500, brandingRemoved: false, source: "configured" }));
  check("default limits: pro 10/1/2000, branding removed", JSON.stringify(planLimits("pro", {})) === JSON.stringify({ seats: 10, locations: 1, monthlyTexts: 2000, brandingRemoved: true, source: "configured" }));
  check("plan key lookup is case-insensitive", planLimits("PRO", {}).seats === 10);
  const kv = planLimits("starter", { PLAN_LIMITS_STARTER: "seats=5, locations=2,texts=800,branding=true" });
  check("PLAN_LIMITS_<PLAN> key=value form overrides defaults", kv.seats === 5 && kv.locations === 2 && kv.monthlyTexts === 800 && kv.brandingRemoved === true);
  const js = planLimits("pro", { PLAN_LIMITS_PRO: '{"seats":25,"texts":5000}' });
  check("PLAN_LIMITS_<PLAN> JSON form; unspecified fields keep defaults", js.seats === 25 && js.monthlyTexts === 5000 && js.locations === 1 && js.brandingRemoved === true);
  const biz = planLimits("business", { PLAN_LIMITS_BUSINESS: "seats=30,locations=5,texts=10000,branding=true" });
  check("a plan with no built-in default can be fully defined from env", planLimits("enterprise", { PLAN_LIMITS_ENTERPRISE: "seats=30,locations=5,texts=10000,branding=true" }).seats === 30 && biz.source === "configured" && biz.seats === 30 && biz.locations === 5 && biz.monthlyTexts === 10000);
  check("unknown plan without limits → smallest tier, flagged fallback", planLimits("enterprise", {}).source === "fallback" && planLimits("enterprise", {}).seats === 3);
  check("default limits: business 25/3/5000, branding removed; PLAN_LIMITS_BUSINESS overrides", JSON.stringify(planLimits("business", {})) === JSON.stringify({ seats: 25, locations: 3, monthlyTexts: 5000, brandingRemoved: true, source: "configured" }) && planLimits("business", { PLAN_LIMITS_BUSINESS: "seats=40" }).seats === 40);
  const bad = parsePlanLimits("seats=-1,locations=abc,texts=1.5,bogus=3,branding=maybe,seats", DEFAULT_PLAN_LIMITS.starter);
  check("malformed limit values are ignored, never widen a limit", JSON.stringify(bad) === JSON.stringify(DEFAULT_PLAN_LIMITS.starter));
  check("malformed JSON ignored", JSON.stringify(parsePlanLimits("{not json", DEFAULT_PLAN_LIMITS.pro)) === JSON.stringify(DEFAULT_PLAN_LIMITS.pro));

  check("addon effects: seat, location, branding, texts_<n>", addonEffect("seat")?.seats === 1 && addonEffect("location")?.locations === 1 && addonEffect("branding")?.brandingRemoved === true && addonEffect("texts_1000")?.monthlyTexts === 1000 && addonEffect("texts_5000")?.monthlyTexts === 5000);
  check("addon effects: unknown keys / texts_0 have none", addonEffect("voice_agent") === null && addonEffect("texts_0") === null && addonEffect("texts_") === null);

  let e = computeEntitlements("starter", [], {});
  check("entitlements: starter alone = plan limits", e.seats === 3 && e.locations === 1 && e.monthlyTexts === 500 && !e.brandingRemoved && e.planKey === "starter");
  e = computeEntitlements("starter", [{ key: "seat", quantity: 2 }, { key: "location", quantity: 1 }, { key: "texts_1000", quantity: 3 }, { key: "branding", quantity: 1 }], {});
  check("entitlements: starter + 2 seats + 1 location + 3×1000 texts + branding = 5/2/3500/branding", e.seats === 5 && e.locations === 2 && e.monthlyTexts === 3500 && e.brandingRemoved === true, e);
  e = computeEntitlements("pro", [{ key: "seat", quantity: 5 }], {});
  check("entitlements: pro + 5 seats = 15 seats, branding already included", e.seats === 15 && e.brandingRemoved && e.monthlyTexts === 2000, e);
  e = computeEntitlements("starter", [{ key: "branding", quantity: 7 }], {});
  check("entitlements: branding add-on is on/off, not multiplied", e.brandingRemoved && e.seats === 3, e);
  e = computeEntitlements("starter", [{ key: "seat", quantity: 1 }, { key: "SEAT", quantity: 2 }, { key: "seat", quantity: -4 }, { key: "seat", quantity: Number.NaN }, { key: "seat", quantity: 1.9 }], {});
  check("entitlements: same add-on summed (case-insensitive); negative/NaN ignored; fractions floored", e.seats === 3 + 1 + 2 + 1, e);
  e = computeEntitlements("starter", [{ key: "voice_agent", quantity: 2 }], {});
  check("entitlements: add-on with no known effect changes nothing", e.seats === 3 && e.addons.length === 0, e);
  // ── per-add-on maximum quantities (abuse guard) ──
  const aenvCaps = { STRIPE_PRICE_STARTER: "price_s", STRIPE_ADDON_PRICE_SEAT: "price_seat", STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000: "price_t1k" };
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  resetAddonMaxWarnings();
  check("add-on caps: defaults seat 50, location 10, texts_1000 10, branding 1", addonMaxQuantity("seat", {}) === 50 && addonMaxQuantity("location", {}) === 10 && addonMaxQuantity("texts_1000", {}) === 10 && addonMaxQuantity("branding", {}) === 1);
  check("add-on caps: other keys fall back to 10; keys are case-insensitive", addonMaxQuantity("texts_5000", {}) === 10 && addonMaxQuantity("voice_agent", {}) === 10 && addonMaxQuantity("SEAT", {}) === 50);
  check("add-on caps: STRIPE_ADDON_MAX_<KEY> overrides (and can lower), whitespace trimmed", addonMaxQuantity("seat", { STRIPE_ADDON_MAX_SEAT: "200" }) === 200 && addonMaxQuantity("texts_1000", { STRIPE_ADDON_MAX_TEXTS_1000: " 3 " }) === 3 && addonMaxQuantity("texts_5000", { STRIPE_ADDON_MAX_TEXTS_5000: "4" }) === 4);
  check("add-on caps: valid override / empty override → no warning", warns.length === 0 && addonMaxQuantity("seat", { STRIPE_ADDON_MAX_SEAT: "" }) === 50 && warns.length === 0, warns);
  for (const bad of ["0", "-5", "1.5", "abc", "10x", "1001", "99999999999", "1e3", "0x10"]) {
    check(`add-on caps: invalid override "${bad}" falls back to the default`, addonMaxQuantity("location", { STRIPE_ADDON_MAX_LOCATION: bad }) === 10, bad);
  }
  check("add-on caps: each invalid value warns once, naming the variable, never the whole env", warns.length === 9 && warns.every((w) => w.includes("STRIPE_ADDON_MAX_LOCATION") && !w.includes("sk_")), warns);
  addonMaxQuantity("location", { STRIPE_ADDON_MAX_LOCATION: "abc" });
  addonMaxQuantity("location", { STRIPE_ADDON_MAX_LOCATION: "abc" });
  check("add-on caps: the same invalid value does not warn again", warns.length === 9, warns.length);
  addonMaxQuantity("seat", { STRIPE_ADDON_MAX_SEAT: "nope" });
  check("add-on caps: a different bad variable warns", warns.length === 10 && warns[9].includes("STRIPE_ADDON_MAX_SEAT"), warns);
  console.warn = origWarn;

  e = computeEntitlements("starter", [{ key: "seat", quantity: 1000 }, { key: "location", quantity: 99 }, { key: "texts_1000", quantity: 1000 }, { key: "branding", quantity: 7 }], {});
  check("entitlements clamp: mirrored seat 1000 / location 99 / texts_1000 1000 never grant more than the cap", e.seats === 3 + 50 && e.locations === 1 + 10 && e.monthlyTexts === 500 + 10 * 1000 && e.brandingRemoved, e);
  check("entitlements clamp: `addons` reports the quantity counted (the cap), not the raw one", JSON.stringify(e.addons) === JSON.stringify([{ key: "branding", quantity: 1 }, { key: "location", quantity: 10 }, { key: "seat", quantity: 50 }, { key: "texts_1000", quantity: 10 }]), e.addons);
  e = computeEntitlements("starter", [{ key: "seat", quantity: 40 }, { key: "SEAT", quantity: 40 }], {});
  check("entitlements clamp: the same add-on listed twice is capped after summing", e.seats === 3 + 50, e);
  e = computeEntitlements("starter", [{ key: "seat", quantity: 50 }, { key: "texts_1000", quantity: 10 }], {});
  check("entitlements clamp: a quantity exactly at the cap is granted in full", e.seats === 53 && e.monthlyTexts === 10500, e);
  e = computeEntitlements("starter", [{ key: "seat", quantity: 1000 }, { key: "texts_1000", quantity: 1000 }], { STRIPE_ADDON_MAX_SEAT: "5", STRIPE_ADDON_MAX_TEXTS_1000: "20" });
  check("entitlements clamp: follows the STRIPE_ADDON_MAX_* override", e.seats === 8 && e.monthlyTexts === 500 + 20000, e);
  e = entitlementsFromItems([{ priceId: "price_s", quantity: 1 }, { priceId: "price_seat", quantity: 1000 }, { priceId: "price_t1k", quantity: 1000 }], aenvCaps);
  check("entitlementsFromItems clamps too", e.seats === 53 && e.monthlyTexts === 10500, e);
  e = entitlementsFromItems([{ priceId: "price_unlisted", quantity: 1 }, { priceId: "price_seat", quantity: 1000 }], aenvCaps);
  check("entitlementsFromItems clamps on the fallback-plan path as well (unknown plan item)", e.source === "fallback" && e.seats === 53, e);
  check("scheduledChanges' entitlementsAtRenewal clamps too", scheduledChanges({ id: "sub_sched", status: "active", current_phase: { start_date: 100, end_date: 200 }, phases: [
    { start_date: 100, end_date: 200, items: [{ price: "price_s", quantity: 1 }] },
    { start_date: 200, end_date: 300, items: [{ price: "price_s", quantity: 1 }, { price: "price_seat", quantity: 1000 }] },
  ] } as unknown as Stripe.SubscriptionSchedule, aenvCaps)?.entitlementsAtRenewal.seats === 53);

  check("validateAddonQuantity: within cap / at cap / zero are fine", validateAddonQuantity("seat", 50, {}) === null && validateAddonQuantity("seat", 0, {}) === null && validateAddonQuantity("branding", 1, {}) === null);
  const over = validateAddonQuantity("texts_1000", 1000, {});
  check("validateAddonQuantity: over the cap → 400 with a clear message", over?.status === 400 && /texts_1000/.test(over.error) && /maximum of 10/.test(over.error) && /1000/.test(over.error), over);
  check("validateAddonQuantity: negative / fractional / NaN → 400", [-1, 1.5, Number.NaN, Infinity].every((q) => validateAddonQuantity("seat", q, {})?.status === 400));
  check("validateAddonQuantity: env override raises the cap", validateAddonQuantity("seat", 80, { STRIPE_ADDON_MAX_SEAT: "100" }) === null && validateAddonQuantity("seat", 101, { STRIPE_ADDON_MAX_SEAT: "100" })?.status === 400);
  const cfgAddons = configuredAddons({ ...aenvCaps, STRIPE_ADDON_PRICE_LOCATION: "price_loc", STRIPE_ADDON_MAX_SEAT: "7" });
  check("configuredAddons includes each add-on's max", JSON.stringify(cfgAddons.map((a) => [a.key, a.max])) === JSON.stringify([["location", 10], ["seat", 7]]), cfgAddons);

  e = computeEntitlements(null, [{ key: "seat", quantity: 2 }], {});
  check("entitlements: no plan → nothing (source none)", e.seats === 0 && e.monthlyTexts === 0 && !e.brandingRemoved && e.source === "none", e);
  e = computeEntitlements("starter", [], { PLAN_LIMITS_STARTER: "seats=4" });
  check("entitlements: env override applies", e.seats === 4);

  const cl = classifyItems([{ priceId: "price_seat", quantity: 2 }, { priceId: "price_p", quantity: 1 }, { priceId: "price_mystery", quantity: 1 }], aenv);
  check("classify: plan item found by price id even when an add-on comes first", cl.plan?.planKey === "pro" && cl.addons.length === 1 && cl.addons[0].key === "seat" && cl.addons[0].quantity === 2 && cl.unknown.length === 1, cl);
  const cl2 = classifyItems([{ priceId: "price_seat", quantity: 1 }, { priceId: "price_unlisted", quantity: 1 }], aenv);
  check("classify: no configured plan → first non-add-on item is the plan item (planKey null)", cl2.plan?.priceId === "price_unlisted" && cl2.plan.planKey === null && cl2.addons.length === 1, cl2);
  e = entitlementsFromItems([{ priceId: "price_unlisted", quantity: 1 }, { priceId: "price_seat", quantity: 2 }], aenv);
  check("entitlementsFromItems: unconfigured plan price → fallback tier + add-ons", e.source === "fallback" && e.planKey === null && e.seats === 5, e);
  e = entitlementsFromItems([{ priceId: "price_s", quantity: 1 }, { priceId: "price_seat", quantity: 2 }, { priceId: "price_t1k", quantity: 1 }], aenv);
  check("entitlementsFromItems: starter + 2 seats + 1 texts bundle", e.planKey === "starter" && e.seats === 5 && e.monthlyTexts === 1500, e);
  check("entitlementsFromItems: no items → none", entitlementsFromItems([], aenv).source === "none");

  const phaseItemsStr = (p: Stripe.SubscriptionSchedule.Phase) => phaseItems(p).map((i) => `${i.price}×${i.quantity}`).join(",");
  const fakeSub = (items: { id: string; price: string; q?: number; end?: number }[], extra: Record<string, unknown> = {}) =>
    ({ id: "sub_x", status: "active", cancel_at_period_end: false, items: { data: items.map((i) => ({ id: i.id, price: { id: i.price }, quantity: i.q ?? 1, current_period_end: i.end ?? 1800000000 })), has_more: false }, ...extra }) as unknown as Stripe.Subscription;

  // add-on changes against a fake Stripe client (with a stateful fake subscription schedule)
  const calls: string[] = [];
  const START = 1790000000, END = 1792592000;
  type FakePhase = { start_date: number; end_date: number; items: { price: string; quantity: number }[]; discounts?: unknown[] };
  const mkSchedule = (phases: FakePhase[], status = "active") =>
    ({ id: "sub_sched_x", status, end_behavior: "release", current_phase: { start_date: phases[0].start_date, end_date: phases[0].end_date }, phases: phases.map((p) => ({ discounts: [], add_invoice_items: [], metadata: {}, ...p })) }) as unknown as Stripe.SubscriptionSchedule;
  const pushPhases = (sched: Stripe.SubscriptionSchedule, phases: Stripe.SubscriptionScheduleUpdateParams.Phase[]) => {
    const [cur] = sched.phases;
    sched.phases = phases.map((p, i) => ({ discounts: [], add_invoice_items: [], metadata: {}, ...p, start_date: (p.start_date as number | undefined) ?? ((phases[i - 1]?.end_date as number | undefined) ?? cur.end_date), end_date: (p.end_date as number | undefined) ?? (((p.start_date as number | undefined) ?? cur.end_date) + 2592000) })) as unknown as Stripe.SubscriptionSchedule.Phase[];
  };
  const mkStripe = (sub: Stripe.Subscription, schedule: Stripe.SubscriptionSchedule | null = null): AddonStripe & { schedule: () => Stripe.SubscriptionSchedule | null } => {
    let sched = schedule;
    return {
      schedule: () => sched,
      subscriptions: { retrieve: async () => ({ ...sub, schedule: sched?.id ?? null }) as Stripe.Subscription },
      subscriptionItems: {
        list: () => ({ autoPagingToArray: async () => sub.items.data }),
        create: async (p) => (calls.push(`create ${p.price} x${p.quantity} proration=${p.proration_behavior}${p.payment_behavior ? ` payment=${p.payment_behavior}` : ""}`), { id: "si_new" } as Stripe.SubscriptionItem),
        update: async (id, p) => (calls.push(`update ${id} x${p.quantity} proration=${p.proration_behavior}${p.payment_behavior ? ` payment=${p.payment_behavior}` : ""}`), { id } as Stripe.SubscriptionItem),
      },
      subscriptionSchedules: {
        retrieve: async () => sched!,
        create: async (p) => {
          calls.push(`schedule.create from ${p.from_subscription}`);
          sched = mkSchedule([{ start_date: START, end_date: END, items: sub.items.data.map((i) => ({ price: i.price.id, quantity: i.quantity ?? 1 })) }]);
          return sched;
        },
        update: async (_id, p) => {
          calls.push(`schedule.update proration=${p.proration_behavior} ` + (p.phases ?? []).map((ph) => (ph.items ?? []).map((i) => `${i.price}x${i.quantity}`).join("+") + (ph.duration ? `(${ph.duration.interval_count}${ph.duration.interval})` : "") + `[${ph.proration_behavior}]`).join(" | "));
          pushPhases(sched!, p.phases ?? []);
          return sched!;
        },
        release: async () => (calls.push("schedule.release"), (sched = null as never), {} as Stripe.SubscriptionSchedule),
      },
    };
  };
  const baseSub = fakeSub([{ id: "si_plan", price: "price_s" }]);
  const act = { id: "sub_x", status: "active" };
  let r = await setAddonQuantity({ stripe: mkStripe(baseSub), subscription: act, addon: "seat", quantity: 2, env: aenv });
  check("add-on: new add-on → subscriptionItems.create, charged now (always_invoice, applied only if paid: pending_if_incomplete)", r.ok && r.action === "created" && r.currentQuantity === 2 && r.proration === "always_invoice" && calls.at(-1) === "create price_seat x2 proration=always_invoice payment=pending_if_incomplete", { r, calls });
  const withSeat = fakeSub([{ id: "si_plan", price: "price_s" }, { id: "si_seat", price: "price_seat", q: 4 }]);
  r = await setAddonQuantity({ stripe: mkStripe(withSeat), subscription: act, addon: "SEAT", quantity: 6, env: aenv });
  check("add-on: increase an existing add-on → update quantity now, prorated charge now (always_invoice + pending_if_incomplete)", r.ok && r.action === "updated" && r.currentQuantity === 6 && calls.at(-1) === "update si_seat x6 proration=always_invoice payment=pending_if_incomplete", { r, calls });

  // decrease / removal: nothing changes now; a schedule's next phase holds the lower quantity
  let nCalls = calls.length;
  let st = mkStripe(withSeat);
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "seat", quantity: 1, env: aenv });
  check("add-on: decrease → schedule created from the subscription, no item write, active quantity unchanged", r.ok && r.action === "scheduled" && r.quantity === 1 && r.currentQuantity === 4 && r.effectiveAt === END && calls.slice(nCalls).join("|").startsWith("schedule.create from sub_x|schedule.update") && !calls.slice(nCalls).some((c) => c.startsWith("update ") || c.startsWith("create price")), { r, calls: calls.slice(nCalls) });
  const sch1 = st.schedule()!;
  check("add-on: decrease → phase 1 keeps today's items to the renewal, phase 2 has the lower quantity for one period, proration none", sch1.phases.length === 2 && phaseItemsStr(sch1.phases[0]) === "price_s×1,price_seat×4" && phaseItemsStr(sch1.phases[1]) === "price_s×1,price_seat×1" && calls.at(-1)!.includes("(1month)") && calls.at(-1)!.endsWith("[none]") && calls.at(-1)!.startsWith("schedule.update proration=none"), calls.at(-1));
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "seat", quantity: 1, env: aenv });
  check("add-on: repeating the same decrease → unchanged, no extra write", r.ok && r.action === "unchanged", r);
  nCalls = calls.length;
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "seat", quantity: 2, env: aenv });
  check("add-on: a different decrease replaces the pending one (still below current)", r.ok && r.action === "scheduled" && r.currentQuantity === 4 && phaseItemsStr(st.schedule()!.phases[1]) === "price_s×1,price_seat×2" && phaseItemsStr(st.schedule()!.phases[0]) === "price_s×1,price_seat×4", { r, calls: calls.slice(nCalls) });
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "seat", quantity: 7, env: aenv });
  check("add-on: increase after a pending decrease → charged now on the subscription (prorated), then both phases at 7 (phase rewrite proration none) and the now-pointless schedule is released", r.ok && r.action === "updated" && r.currentQuantity === 7 && calls.at(-3) === "update si_seat x7 proration=always_invoice payment=pending_if_incomplete" && calls.at(-2)!.startsWith("schedule.update proration=none") && calls.at(-2)!.includes("price_seatx7[none] | price_sx1+price_seatx7") && calls.at(-1) === "schedule.release" && st.schedule() === null, { r, calls: calls.slice(nCalls) });

  // cancel a pending decrease by asking for the current quantity
  st = mkStripe(withSeat);
  await setAddonQuantity({ stripe: st, subscription: act, addon: "seat", quantity: 0, env: aenv });
  check("add-on: quantity 0 → next phase drops the add-on item, this phase keeps it", phaseItemsStr(st.schedule()!.phases[0]) === "price_s×1,price_seat×4" && phaseItemsStr(st.schedule()!.phases[1]) === "price_s×1", st.schedule()?.phases.map(phaseItemsStr));
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "seat", quantity: 4, env: aenv });
  check("add-on: asking for the current quantity cancels the pending removal and releases our schedule", r.ok && r.action === "schedule_cleared" && calls.at(-1) === "schedule.release" && st.schedule() === null, { r, calls: calls.slice(-3) });

  // another add-on's pending change and a portal-scheduled plan downgrade survive an unrelated change
  const multi = fakeSub([{ id: "si_plan", price: "price_p" }, { id: "si_seat", price: "price_seat", q: 4 }, { id: "si_loc", price: "price_loc", q: 2 }]);
  st = mkStripe(multi, mkSchedule([
    { start_date: START, end_date: END, items: [{ price: "price_p", quantity: 1 }, { price: "price_seat", quantity: 4 }, { price: "price_loc", quantity: 2 }] },
    { start_date: END, end_date: END + 2592000, items: [{ price: "price_s", quantity: 1 }, { price: "price_seat", quantity: 4 }, { price: "price_loc", quantity: 2 }] },
  ]));
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "location", quantity: 1, env: aenv });
  check("add-on: with a portal-made downgrade schedule, the decrease edits its next phase and keeps the downgraded plan", r.ok && r.action === "scheduled" && phaseItemsStr(st.schedule()!.phases[1]) === "price_s×1,price_seat×4,price_loc×1" && phaseItemsStr(st.schedule()!.phases[0]) === "price_p×1,price_seat×4,price_loc×2", { r, ph: st.schedule()?.phases.map(phaseItemsStr) });
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "location", quantity: 2, env: aenv });
  check("add-on: cancelling the add-on decrease keeps the portal's plan downgrade (schedule NOT released)", r.ok && r.action === "schedule_cleared" && st.schedule() !== null && phaseItemsStr(st.schedule()!.phases[1]) === "price_s×1,price_seat×4,price_loc×2", { r, ph: st.schedule()?.phases.map(phaseItemsStr) });
  r = await setAddonQuantity({ stripe: st, subscription: act, addon: "seat", quantity: 5, env: aenv });
  check("add-on: an increase with a plan downgrade pending → charged now on the subscription item, then both phases raised (plan downgrade kept)", r.ok && r.action === "updated" && phaseItemsStr(st.schedule()!.phases[0]) === "price_p×1,price_seat×5,price_loc×2" && phaseItemsStr(st.schedule()!.phases[1]) === "price_s×1,price_seat×5,price_loc×2" && calls.at(-2) === "update si_seat x5 proration=always_invoice payment=pending_if_incomplete" && calls.at(-1)!.startsWith("schedule.update proration=none"), { r, calls: calls.slice(-2) });
  const sc = scheduledChanges(mkSchedule([
    { start_date: START, end_date: END, items: [{ price: "price_p", quantity: 1 }, { price: "price_seat", quantity: 4 }] },
    { start_date: END, end_date: END + 1, items: [{ price: "price_s", quantity: 1 }, { price: "price_seat", quantity: 1 }, { price: "price_t1k", quantity: 2 }] },
  ]), aenv);
  check("scheduledChanges: lists add-on diffs, the plan change, the date and the entitlements at renewal", !!sc && sc.effectiveAt === END && JSON.stringify(sc.addons) === JSON.stringify([{ key: "seat", from: 4, to: 1 }, { key: "texts_1000", from: 0, to: 2 }]) && sc.plan?.from === "pro" && sc.plan.to === "starter" && sc.entitlementsAtRenewal.seats === 4 && sc.entitlementsAtRenewal.monthlyTexts === 2500, sc);
  check("scheduledChanges: nothing pending (no schedule, one phase, identical phases, released) → null",
    scheduledChanges(null, aenv) === null && scheduledChanges(mkSchedule([{ start_date: START, end_date: END, items: [{ price: "price_s", quantity: 1 }] }]), aenv) === null &&
    scheduledChanges(mkSchedule([{ start_date: START, end_date: END, items: [{ price: "price_s", quantity: 1 }] }, { start_date: END, end_date: END + 1, items: [{ price: "price_s", quantity: 1 }] }]), aenv) === null &&
    scheduledChanges(mkSchedule([{ start_date: START, end_date: END, items: [] }, { start_date: END, end_date: END + 1, items: [] }], "released"), aenv) === null);
  const discounted = mkSchedule([{ start_date: START, end_date: END, items: [{ price: "price_s", quantity: 1 }, { price: "price_seat", quantity: 2 }], discounts: [{}] }]);
  nCalls = calls.length;
  r = await setAddonQuantity({ stripe: mkStripe(withSeat, discounted), subscription: act, addon: "seat", quantity: 1, env: aenv });
  check("add-on: a schedule with discounts we can't copy → 409, nothing written", !r.ok && r.status === 409 && calls.length === nCalls, r);
  const threePh = mkSchedule([
    { start_date: START, end_date: END, items: [{ price: "price_s", quantity: 1 }] }, { start_date: END, end_date: END + 10, items: [{ price: "price_s", quantity: 1 }] }, { start_date: END + 10, end_date: END + 20, items: [{ price: "price_s", quantity: 1 }] },
  ]);
  r = await setAddonQuantity({ stripe: mkStripe(withSeat, threePh), subscription: act, addon: "seat", quantity: 1, env: aenv });
  check("add-on: a schedule with several future phases → 409, nothing written", !r.ok && r.status === 409 && calls.length === nCalls, r);

  const n0 = calls.length;
  r = await setAddonQuantity({ stripe: mkStripe(withSeat), subscription: act, addon: "seat", quantity: 4, env: aenv });
  check("add-on: same quantity → unchanged, no Stripe write", r.ok && r.action === "unchanged" && calls.length === n0, { r, calls });
  r = await setAddonQuantity({ stripe: mkStripe(baseSub), subscription: act, addon: "location", quantity: 0, env: aenv });
  check("add-on: remove something not on the subscription → unchanged", r.ok && r.action === "unchanged" && calls.length === n0);
  for (const [label, input, status] of [
    ["unknown add-on", { addon: "nope", quantity: 1 }, 400],
    ["unconfigured add-on (no price env)", { addon: "voice_agent", quantity: 1 }, 400],
    ["negative quantity", { addon: "seat", quantity: -1 }, 400],
    ["fractional quantity", { addon: "seat", quantity: 1.5 }, 400],
    ["huge quantity", { addon: "seat", quantity: 5000 }, 400],
    ["branding quantity > 1", { addon: "branding", quantity: 2 }, 400],
    ["seat above its cap (51 > 50)", { addon: "seat", quantity: 51 }, 400],
    ["texts_1000 above its cap (1000 > 10)", { addon: "texts_1000", quantity: 1000 }, 400],
    ["location above its cap (11 > 10)", { addon: "location", quantity: 11 }, 400],
  ] as const) {
    r = await setAddonQuantity({ stripe: mkStripe(baseSub), subscription: act, env: { ...aenv, STRIPE_ADDON_PRICE_NOPE: "" }, ...input });
    check(`add-on rejected: ${label} → ${status}, nothing sent to Stripe`, !r.ok && r.status === status && calls.length === n0, r);
  }
  for (const st of ["past_due", "unpaid", "canceled", "incomplete", "paused"]) {
    r = await setAddonQuantity({ stripe: mkStripe(baseSub), subscription: { id: "sub_x", status: st }, addon: "seat", quantity: 1, env: aenv });
    check(`add-on rejected on ${st} subscription → 409`, !r.ok && r.status === 409 && calls.length === n0, r);
  }
  const proSub = fakeSub([{ id: "si_plan", price: "price_p" }]);
  r = await setAddonQuantity({ stripe: mkStripe(proSub), subscription: act, addon: "branding", quantity: 1, env: aenv });
  check("branding add-on rejected on a plan that already includes it → 409", !r.ok && r.status === 409 && calls.length === n0, r);
  const oddSub = fakeSub([{ id: "si_plan", price: "price_unlisted" }]);
  r = await setAddonQuantity({ stripe: mkStripe(oddSub), subscription: act, addon: "seat", quantity: 1, env: aenv });
  check("add-on rejected when the subscription is not on a configured plan → 409", !r.ok && r.status === 409 && calls.length === n0, r);

  const big = fakeSub([{ id: "si_1", price: "price_s" }], {});
  (big.items as { has_more: boolean }).has_more = true;
  const pagedStripe = mkStripe(big);
  pagedStripe.subscriptionItems.list = () => ({ autoPagingToArray: async () => [...big.items.data, { id: "si_11", price: { id: "price_seat" }, quantity: 1 } as unknown as Stripe.SubscriptionItem] });
  const full = await retrieveSubscriptionComplete(pagedStripe, "sub_x");
  check("retrieveSubscriptionComplete pages through has_more items", full.items.data.length === 2 && full.items.has_more === false);

  // ── final pricing: annual prices, Business, one-time text packs, trial (docs/BILLING.md §11–12) ──
  const fenv = {
    STRIPE_PRICE_STARTER: "p_s_m", STRIPE_PRICE_PRO: "p_p_m", STRIPE_PRICE_BUSINESS: "p_b_m",
    STRIPE_PRICE_STARTER_ANNUAL: "p_s_y", STRIPE_PRICE_PRO_ANNUAL: "p_p_y", STRIPE_PRICE_BUSINESS_ANNUAL: "p_b_y",
    STRIPE_ADDON_PRICE_SEAT: "a_seat_m", STRIPE_ADDON_PRICE_LOCATION: "a_loc_m", STRIPE_ADDON_PRICE_BRANDING: "a_brand_m",
    STRIPE_ADDON_PRICE_SEAT_ANNUAL: "a_seat_y", STRIPE_ADDON_PRICE_LOCATION_ANNUAL: "a_loc_y", STRIPE_ADDON_PRICE_BRANDING_ANNUAL: "a_brand_y",
    STRIPE_ADDON_PRICE_TEXTS_1000: "pack_1k",
  };
  check("plans: three plans × two intervals, keys never end in _annual", plans(fenv).length === 6 && plans(fenv).every((p) => !p.key.includes("annual")) && JSON.stringify([...new Set(plans(fenv).map((p) => p.key))]) === '["business","pro","starter"]');
  check("planByKey: month by default, year on request; missing interval → undefined", planByKey("pro", fenv)?.priceId === "p_p_m" && planByKey("PRO", fenv, "year")?.priceId === "p_p_y" && planByKey("pro", { STRIPE_PRICE_PRO: "x" }, "year") === undefined);
  check("planByPriceId recognises annual prices (the webhook mapping)", planByPriceId("p_b_y", fenv)?.key === "business" && planByPriceId("p_b_y", fenv)?.interval === "year" && planByPriceId("p_s_m", fenv)?.interval === "month");
  check("classifyItems maps an annual plan price + annual add-ons", (() => { const c = classifyItems([{ priceId: "p_p_y", quantity: 1 }, { priceId: "a_seat_y", quantity: 2 }], fenv); return c.plan?.planKey === "pro" && c.addons[0]?.key === "seat" && c.addons[0].quantity === 2 && c.unknown.length === 0; })());
  check("add-on prices per interval; text pack is its own one-time price (never a recurring add-on or a subscription item match)", addonPrice("seat", "year", fenv)?.priceId === "a_seat_y" && addonPrice("seat", "month", fenv)?.priceId === "a_seat_m" && addonPrice("texts_1000", "month", fenv) === undefined && addonByKey("texts_1000", fenv) === undefined && textPackByKey("texts_1000", fenv)?.priceId === "pack_1k" && addonByPriceId("pack_1k", fenv) === undefined);
  check("text pack keys: texts_1000 → 1000 texts, others are not packs", isTextPackKey("texts_1000") && textPackSize("texts_1000") === 1000 && textPackSize("seat") === null && !isTextPackKey("texts_0"));
  check("TRIAL_DAYS: default 14, 0 disables, junk falls back to 14", trialDays({}) === 14 && trialDays({ TRIAL_DAYS: "0" }) === 0 && trialDays({ TRIAL_DAYS: "7" }) === 7 && trialDays({ TRIAL_DAYS: "abc" }) === 14 && trialDays({ TRIAL_DAYS: "-3" }) === 14);

  e = computeEntitlements("business", [], {});
  check("entitlements: business alone = 25 seats / 3 locations / 5000 texts / branding removed", e.seats === 25 && e.locations === 3 && e.monthlyTexts === 5000 && e.brandingRemoved, e);
  e = computeEntitlements("starter", [], {}, [{ key: "texts_1000", quantity: 3 }]);
  check("entitlements: paid packs add 1000 texts each on top of the plan", e.monthlyTexts === 3500 && JSON.stringify(e.packs) === JSON.stringify([{ key: "texts_1000", quantity: 3 }]), e);
  e = computeEntitlements("starter", [], {}, [{ key: "texts_1000", quantity: 99 }]);
  check("entitlements: packs are clamped to the per-period cap (10)", e.monthlyTexts === 500 + 10 * 1000, e);
  e = computeEntitlements("starter", [{ key: "texts_1000", quantity: 2 }], {}, [{ key: "texts_1000", quantity: 3 }]);
  check("entitlements: a legacy recurring texts add-on is still counted, together with paid packs", e.monthlyTexts === 500 + 2000 + 3000, e);
  e = computeEntitlements(null, [], {}, [{ key: "texts_1000", quantity: 3 }]);
  check("entitlements: no plan → packs grant nothing", e.monthlyTexts === 0 && e.packs.length === 0, e);
  e = entitlementsFromItems([{ priceId: "p_p_y", quantity: 1 }, { priceId: "a_seat_y", quantity: 2 }], fenv, [{ key: "texts_1000", quantity: 1 }]);
  check("entitlementsFromItems: annual pro + 2 annual seats + 1 pack = 12 seats, 3000 texts", e.planKey === "pro" && e.seats === 12 && e.monthlyTexts === 3000, e);

  // pack window / validation
  const D = (x: string) => new Date(x);
  check("addMonthsUTC clamps to the last day of a shorter month", addMonthsUTC(D("2027-01-31T10:00:00Z"), 1).toISOString() === "2027-02-28T10:00:00.000Z" && addMonthsUTC(D("2027-11-15T00:00:00Z"), 3).toISOString() === "2028-02-15T00:00:00.000Z");
  let w = textPackWindow(D("2026-10-01T00:00:00Z"), D("2026-11-01T00:00:00Z"), D("2026-10-20T00:00:00Z"));
  check("pack window (monthly plan): the whole current period", w.start.toISOString() === "2026-10-01T00:00:00.000Z" && w.end.toISOString() === "2026-11-01T00:00:00.000Z");
  w = textPackWindow(D("2026-10-01T00:00:00Z"), D("2027-10-01T00:00:00Z"), D("2027-03-20T00:00:00Z"));
  check("pack window (annual plan): the current month of the year, so the cap is per month, not per year", w.start.toISOString() === "2027-03-01T00:00:00.000Z" && w.end.toISOString() === "2027-04-01T00:00:00.000Z");
  w = textPackWindow(D("2026-10-01T00:00:00Z"), D("2027-10-01T00:00:00Z"), D("2027-09-30T23:00:00Z"));
  check("pack window (annual plan, last month): ends at the period end", w.end.toISOString() === "2027-10-01T00:00:00.000Z" && w.start.toISOString() === "2027-09-01T00:00:00.000Z");
  w = textPackWindow(D("2026-11-10T00:00:00Z"), D("2026-11-24T00:00:00Z"), D("2026-11-12T00:00:00Z"));
  check("pack window (trial): ends with the trial; the next period starts a fresh window", w.end.toISOString() === "2026-11-24T00:00:00.000Z");
  check("validateTextPackRequest: ok / unknown pack / 0 / fractional / above the cap", (() => {
    const ok = validateTextPackRequest("texts_1000", 10, {}), hi = validateTextPackRequest("texts_1000", 11, {}), lo = validateTextPackRequest("texts_1000", 3, { STRIPE_ADDON_MAX_TEXTS_1000: "2" });
    return ok.ok && ok.texts === 1000 && !validateTextPackRequest("seat", 1, {}).ok && !validateTextPackRequest("texts_1000", 0, {}).ok && !validateTextPackRequest("texts_1000", 1.5, {}).ok && !hi.ok && hi.status === 400 && /maximum of 10/.test(hi.error) && !lo.ok;
  })());

  // checkout session parameters
  const cp = checkoutSessionParams({ orgId: "org_1", customer: "cus_1", priceId: "p_p_y", origin: "https://x.test", trialDays: 14 });
  check("checkout: trial → subscription_data.trial_period_days=14 and payment_method_collection=always, cancel if no card at trial end", cp.subscription_data?.trial_period_days === 14 && cp.payment_method_collection === "always" && cp.subscription_data?.trial_settings?.end_behavior?.missing_payment_method === "cancel" && cp.line_items?.[0].price === "p_p_y" && cp.subscription_data?.metadata?.organizationId === "org_1", cp);
  const cn = checkoutSessionParams({ orgId: "org_1", customer: "cus_1", priceId: "p_p_m", origin: "https://x.test", trialDays: 0 });
  check("checkout: no trial → no trial fields, card still collected", cn.subscription_data?.trial_period_days === undefined && cn.subscription_data?.trial_settings === undefined && cn.payment_method_collection === "always");

  // add-ons on an annual subscription use the annual price; missing annual price → 409
  const annualSub = fakeSub([{ id: "si_plan", price: "p_s_y" }]);
  const nAnn = calls.length;
  r = await setAddonQuantity({ stripe: mkStripe(annualSub), subscription: act, addon: "seat", quantity: 2, env: fenv });
  check("add-on on an annual subscription → the ANNUAL seat price, prorated for the rest of the YEAR (always_invoice)", r.ok && r.action === "created" && calls.at(-1) === "create a_seat_y x2 proration=always_invoice payment=pending_if_incomplete", { r, calls: calls.slice(nAnn) });
  r = await setAddonQuantity({ stripe: mkStripe(fakeSub([{ id: "si_plan", price: "p_s_m" }])), subscription: act, addon: "location", quantity: 1, env: fenv });
  check("add-on on a monthly subscription → the MONTHLY location price", r.ok && calls.at(-1) === "create a_loc_m x1 proration=always_invoice payment=pending_if_incomplete", { r });
  const noAnnual = { ...fenv, STRIPE_ADDON_PRICE_SEAT_ANNUAL: "" };
  const nNo = calls.length;
  r = await setAddonQuantity({ stripe: mkStripe(annualSub), subscription: act, addon: "seat", quantity: 1, env: noAnnual });
  check("add-on on an annual subscription with no annual price configured → 409, nothing sent to Stripe", !r.ok && r.status === 409 && /annual/.test(r.error) && calls.length === nNo, r);
  const annualSeat = fakeSub([{ id: "si_plan", price: "p_s_y" }, { id: "si_seat", price: "a_seat_y", q: 3 }]);
  const stA = mkStripe(annualSeat);
  r = await setAddonQuantity({ stripe: stA, subscription: act, addon: "seat", quantity: 1, env: fenv });
  check("annual seat removal/decrease → still scheduled for period end (next phase), nothing changes now, no refund", r.ok && r.action === "scheduled" && r.currentQuantity === 3 && phaseItemsStr(stA.schedule()!.phases[0]) === "p_s_y×1,a_seat_y×3" && phaseItemsStr(stA.schedule()!.phases[1]) === "p_s_y×1,a_seat_y×1" && !calls.at(-1)!.startsWith("update "), { r });
  r = await setAddonQuantity({ stripe: mkStripe(baseSub), subscription: act, addon: "texts_1000", quantity: 1, env: { ...fenv, STRIPE_PRICE_STARTER: "price_s" } });
  check("texts_1000 can no longer be set as a recurring add-on → 400 pointing at text packs", !r.ok && r.status === 400 && /one-time/.test(r.error), r);
  check("configuredAddons lists seat/location/branding with both intervals, never a text pack", (() => { const c = configuredAddons(fenv); return JSON.stringify(c.map((a) => a.key)) === '["branding","location","seat"]' && c.every((a) => a.prices.month && a.prices.year); })());
  const legacySc = scheduledChanges(mkSchedule([{ start_date: START, end_date: END, items: [{ price: "p_s_m", quantity: 1 }, { price: "legacy_t", quantity: 2 }] }, { start_date: END, end_date: END + 1, items: [{ price: "p_s_m", quantity: 1 }] }]), { ...fenv, STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000: "legacy_t" });
  check("legacy recurring texts item: still counted today and shown as going away at renewal", !!legacySc && JSON.stringify(legacySc.addons) === JSON.stringify([{ key: "texts_1000", from: 2, to: 0 }]), legacySc);


  // ───── 0004: increases charged now (prorated), failed charge grants nothing, trial adds charged, removals unchanged ─────
  {
    const T0 = 1795000000; // "now" in the fake
    type Opt = { status?: string; pending?: boolean; newInvoice?: boolean; pm?: string | null; payStatus?: "paid" | "decline"; schedule?: Stripe.SubscriptionSchedule | null; items?: { id: string; price: string; q?: number }[] };
    const mk = (o: Opt = {}) => {
      const log: string[] = [];
      let sched = o.schedule ?? null;
      let applied = false;
      const sub = { ...fakeSub(o.items ?? [{ id: "si_plan", price: "price_p" }]), status: o.status ?? "active", customer: "cus_1", latest_invoice: "in_old", trial_end: o.status === "trialing" ? T0 + 7 * 86400 : null, default_payment_method: null } as unknown as Stripe.Subscription;
      const invState: Record<string, { status: string; amount: number }> = {};
      const client: AddonStripe = {
        subscriptions: {
          retrieve: async (_id, params) => {
            if (!params?.expand) return { ...sub, schedule: sched?.id ?? null } as Stripe.Subscription;
            log.push("sub.retrieve(expand latest_invoice)");
            const fresh = o.newInvoice !== false;
            const inv = fresh ? { id: "in_prorate", status: o.pending ? "open" : "paid", amount_paid: o.pending ? 0 : 1032, currency: "usd", lines: { data: [{ description: "Remaining time on 2 × seat after 11 Nov", amount: 1032 }] } } : { id: "in_old" };
            invState["in_prorate"] ??= { status: inv.status ?? "paid", amount: 1032 };
            return { ...sub, latest_invoice: inv, pending_update: o.pending ? { expires_at: T0 + 82800, subscription_items: [] } : null } as unknown as Stripe.Subscription;
          },
        },
        subscriptionItems: {
          list: () => ({ autoPagingToArray: async () => sub.items.data }),
          create: async (p) => (log.push(`create ${p.price} x${p.quantity} ${p.proration_behavior}${p.payment_behavior ? `/${p.payment_behavior}` : ""}`), (applied = !o.pending || p.proration_behavior === "none"), { id: "si_new" } as Stripe.SubscriptionItem),
          update: async (id, p) => (log.push(`update ${id} x${p.quantity} ${p.proration_behavior}${p.payment_behavior ? `/${p.payment_behavior}` : ""}`), (applied = !o.pending), { id } as Stripe.SubscriptionItem),
        },
        subscriptionSchedules: {
          retrieve: async () => sched!,
          create: async () => (log.push("schedule.create"), (sched = mkSchedule([{ start_date: START, end_date: END, items: sub.items.data.map((i) => ({ price: i.price.id, quantity: i.quantity ?? 1 })) }])), sched),
          update: async (_id, p) => (log.push(`schedule.update ${p.proration_behavior} ` + (p.phases ?? []).map((ph) => (ph.items ?? []).map((i) => `${i.price}x${i.quantity}`).join("+")).join(" | ")), pushPhases(sched!, p.phases ?? []), sched!),
          release: async () => (log.push("schedule.release"), (sched = null), {} as Stripe.SubscriptionSchedule),
        },
        invoices: {
          create: async (p) => (log.push(`invoice.create ${(p.metadata as Record<string, string> | undefined)?.flowops_addon_charge} pm=${p.default_payment_method} excl=${p.pending_invoice_items_behavior}`), (invState["in_trial"] = { status: "draft", amount: 0 }), { id: "in_trial", status: "draft" } as Stripe.Invoice),
          finalizeInvoice: async (id) => (log.push(`finalize ${id}`), (invState[id].status = "open"), { id, status: "open" } as Stripe.Invoice),
          pay: async (id) => {
            log.push(`pay ${id}`);
            if (o.payStatus === "decline") throw Object.assign(new Error("declined"), { type: "StripeCardError" });
            invState[id].status = "paid";
            return { id, status: "paid", amount_paid: invState[id].amount, currency: "usd" } as Stripe.Invoice;
          },
          retrieve: async (id) => ({ id, status: invState[id]?.status ?? "open", amount_paid: invState[id]?.amount ?? 0, currency: "usd" }) as Stripe.Invoice,
          voidInvoice: async (id) => (log.push(`void ${id}`), (invState[id] = { ...(invState[id] ?? { amount: 0 }), status: "void" }), { id, status: "void" } as Stripe.Invoice),
          del: async (id) => (log.push(`del ${id}`), {}),
        },
        invoiceItems: { create: async (p) => (log.push(`invoiceItem ${p.amount} ${p.currency} period=${p.period?.start}-${p.period?.end}`), (invState[p.invoice as string].amount = p.amount!), { id: "ii_1" } as Stripe.InvoiceItem) },
        prices: { retrieve: async (id) => ({ id, unit_amount: id === "price_brand" ? 1500 : id === "price_loc" ? 2900 : 1000, currency: "usd" }) as Stripe.Price },
        customers: { retrieve: async () => ({ id: "cus_1", invoice_settings: { default_payment_method: o.pm === undefined ? "pm_card" : o.pm } }) as unknown as Stripe.Customer },
      };
      return { client, log, applied: () => applied, sched: () => sched };
    };
    const now = new Date(T0 * 1000);

    // proration on add (active)
    let f = mk();
    let r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "active" }, addon: "seat", quantity: 2, env: aenv, now });
    check("0004 proration on add: active sub → item written with always_invoice + pending_if_incomplete, the paid immediate invoice is returned with its prorated lines", r4.ok && r4.action === "created" && r4.proration === "always_invoice" && r4.charge?.kind === "proration" && r4.charge.invoiceId === "in_prorate" && r4.charge.amountPaid === 1032 && r4.charge.lines?.[0].amount === 1032 && f.log[0] === "create price_seat x2 always_invoice/pending_if_incomplete" && f.log.includes("sub.retrieve(expand latest_invoice)") && !f.log.some((l) => l.startsWith("void")), { r4, log: f.log });
    f = mk({ newInvoice: false });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "active" }, addon: "location", quantity: 1, env: aenv, now });
    check("0004 proration on add: no new invoice (e.g. $0 proration) → applied, charge null", r4.ok && r4.action === "created" && r4.charge === null, r4);
    // branding is treated like seats
    f = mk({ items: [{ id: "si_plan", price: "price_s" }] });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "active" }, addon: "branding", quantity: 1, env: aenv, now });
    check("0004 branding removal on add → charged now like seats (always_invoice + pending_if_incomplete)", r4.ok && f.log[0] === "create price_brand x1 always_invoice/pending_if_incomplete" && r4.charge?.kind === "proration", { r4, log: f.log });

    // failed proration payment grants nothing
    f = mk({ pending: true });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "active" }, addon: "seat", quantity: 2, env: aenv, now });
    check("0004 failed proration payment: pending update → the open invoice is voided (discards the pending update), 402 payment_failed with portal, nothing granted", !r4.ok && r4.status === 402 && r4.code === "payment_failed" && r4.portal === true && f.log.includes("void in_prorate") && !f.applied() && /declined/.test(r4.error), { r4, log: f.log });
    f = mk({ pending: true, items: [{ id: "si_plan", price: "price_p" }, { id: "si_seat", price: "price_seat", q: 3 }], schedule: mkSchedule([
      { start_date: START, end_date: END, items: [{ price: "price_p", quantity: 1 }, { price: "price_seat", quantity: 3 }] },
      { start_date: END, end_date: END + 2592000, items: [{ price: "price_p", quantity: 1 }, { price: "price_seat", quantity: 1 }] },
    ]) });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "active" }, addon: "seat", quantity: 6, env: aenv, now });
    check("0004 failed proration payment with a pending decrease: 402, the schedule is NOT touched (the pending decrease stays)", !r4.ok && r4.status === 402 && !f.log.some((l) => l.startsWith("schedule.")) && phaseItemsStr(f.sched()!.phases[1]) === "price_p×1,price_seat×1", { r4, log: f.log });

    // trial add charging
    f = mk({ status: "trialing" });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "trialing" }, addon: "seat", quantity: 2, env: aenv, now });
    const expectTrial = Math.round(1000 * 2 * (7 * 86400) / ((addMonthsUTC(now, 1).getTime() - now.getTime()) / 1000));
    check("0004 trial add: the rest of the trial at the seat rate is charged NOW on a standalone invoice (pending items excluded), and only then the item is written with proration none", r4.ok && r4.action === "created" && r4.charge?.kind === "trial_proration" && r4.charge.amountPaid === expectTrial && f.log.join("|") === `invoice.create trial_proration pm=pm_card excl=exclude|invoiceItem ${expectTrial} usd period=${T0}-${T0 + 7 * 86400}|finalize in_trial|pay in_trial|create price_seat x2 none`, { r4, log: f.log, expectTrial });
    check("0004 trial add: amount ≈ 7/30 of 2 × $10 (≈ $4.60)", expectTrial > 440 && expectTrial < 480, expectTrial);
    f = mk({ status: "trialing", pm: null });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "trialing" }, addon: "seat", quantity: 2, env: aenv, now });
    check("0004 trial add with no card on file → 402 no_payment_method, no invoice, no item write", !r4.ok && r4.status === 402 && r4.code === "no_payment_method" && f.log.length === 0, { r4, log: f.log });
    f = mk({ status: "trialing", payStatus: "decline" });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "trialing" }, addon: "seat", quantity: 2, env: aenv, now });
    check("0004 trial add with a declined card → invoice voided, 402 payment_failed, no item write", !r4.ok && r4.status === 402 && r4.code === "payment_failed" && f.log.includes("void in_trial") && !f.log.some((l) => l.startsWith("create ") || l.startsWith("update ")), { r4, log: f.log });
    check("trialProrationAmount: full interval left → full price; nothing left → 0; annual uses a year", trialProrationAmount({ unitAmount: 1000, delta: 2, now: T0, periodEnd: T0 + 10 * 365 * 86400, interval: "month" }) === 2000 && trialProrationAmount({ unitAmount: 1000, delta: 2, now: T0, periodEnd: T0, interval: "month" }) === 0 && Math.abs(trialProrationAmount({ unitAmount: 10000, delta: 1, now: T0, periodEnd: T0 + 14 * 86400, interval: "year" }) - Math.round(10000 * 14 / 365)) <= 2);

    // removal unchanged
    f = mk({ items: [{ id: "si_plan", price: "price_p" }, { id: "si_seat", price: "price_seat", q: 4 }] });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "active" }, addon: "seat", quantity: 1, env: aenv, now });
    check("0004 removal unchanged: decrease → scheduled for the period end, no item write, no invoice, no proration (none), no charge", r4.ok && r4.action === "scheduled" && r4.currentQuantity === 4 && r4.proration === "none" && r4.charge === null && f.log.join("|") === "schedule.create|schedule.update none price_px1+price_seatx4 | price_px1+price_seatx1", { r4, log: f.log });
    f = mk({ status: "trialing", items: [{ id: "si_plan", price: "price_p" }, { id: "si_seat", price: "price_seat", q: 4 }] });
    r4 = await setAddonQuantity({ stripe: f.client, subscription: { id: "sub_x", status: "trialing" }, addon: "seat", quantity: 0, env: aenv, now });
    check("0004 removal in a trial: scheduled, nothing charged or refunded", r4.ok && r4.action === "scheduled" && !f.log.some((l) => l.startsWith("invoice") || l.startsWith("pay")), { r4, log: f.log });
  }

  // ───── 0004: text pack rollover (one extra period, then expiry) + consumption order ─────
  {
    const D = (x: string) => new Date(x);
    check("rollover (monthly plan): a pack bought in Oct expires at the end of the NEXT period (Dec 1)", textPackExpiry(D("2026-10-01T00:00:00Z"), D("2026-11-01T00:00:00Z"), D("2026-10-29T00:00:00Z")).toISOString() === "2026-12-01T00:00:00.000Z");
    check("rollover (monthly, 31st anchor): Jan 31 period → expires Mar 31 (anchor kept, not Mar 28)", textPackExpiry(D("2027-01-31T00:00:00Z"), D("2027-02-28T00:00:00Z"), D("2027-02-10T00:00:00Z")).toISOString() === "2027-03-31T00:00:00.000Z");
    check("rollover (annual plan, mid-year): bought in March → expires end of April (one extra MONTH, not a year)", textPackExpiry(D("2026-10-01T00:00:00Z"), D("2027-10-01T00:00:00Z"), D("2027-03-20T00:00:00Z")).toISOString() === "2027-05-01T00:00:00.000Z");
    check("rollover (annual plan, last month): rolls into the first month of the next year", textPackExpiry(D("2026-10-01T00:00:00Z"), D("2027-10-01T00:00:00Z"), D("2027-09-30T00:00:00Z")).toISOString() === "2027-11-01T00:00:00.000Z");
    check("rollover (trial): bought in the trial → usable through the first paid month", textPackExpiry(D("2026-11-10T00:00:00Z"), D("2026-11-24T00:00:00Z"), D("2026-11-12T00:00:00Z")).toISOString() === "2026-12-24T00:00:00.000Z");
    check("consumption: plan allowance first, then packs", JSON.stringify(splitTextUsage(500, 0, 300)) === '{"fromPlan":300,"fromPacks":0}' && JSON.stringify(splitTextUsage(500, 400, 300)) === '{"fromPlan":100,"fromPacks":200}' && JSON.stringify(splitTextUsage(500, 900, 10)) === '{"fromPlan":0,"fromPacks":10}');
    const packs = [
      { id: "new", remaining: 1000, expiresAt: D("2027-01-01T00:00:00Z"), createdAt: D("2026-11-05T00:00:00Z") },
      { id: "old", remaining: 300, expiresAt: D("2026-12-01T00:00:00Z"), createdAt: D("2026-10-05T00:00:00Z") },
      { id: "new2", remaining: 1000, expiresAt: D("2027-01-01T00:00:00Z"), createdAt: D("2026-11-20T00:00:00Z") },
      { id: "empty", remaining: 0, expiresAt: D("2026-11-30T00:00:00Z"), createdAt: D("2026-10-01T00:00:00Z") },
    ];
    let al = allocatePackTexts(packs, 500);
    check("consumption: packs soonest-expiring first (rolled-over pack before this period's), then oldest purchase", JSON.stringify(al) === '{"draws":[{"id":"old","texts":300},{"id":"new","texts":200}],"shortfall":0}', al);
    al = allocatePackTexts(packs, 2500);
    check("consumption: more than all packs hold → shortfall reported", al.shortfall === 200 && al.draws.length === 3, al);
    e = computeEntitlements("starter", [], {}, [{ key: "texts_1000", quantity: 10, window: "2026-10-01", remaining: 4000 }, { key: "texts_1000", quantity: 10, window: "2026-11-01" }]);
    check("entitlements with rollover: the cap is per purchase window (10 rolled over + 10 new both count), unused texts only", e.monthlyTexts === 500 + 4000 + 10000 && e.includedTexts === 500 && e.packTexts === 14000 && JSON.stringify(e.packs) === '[{"key":"texts_1000","quantity":20}]', e);
    e = computeEntitlements("starter", [], {}, [{ key: "texts_1000", quantity: 15, window: "2026-11-01", remaining: 15000 }]);
    check("entitlements with rollover: still clamped to the cap within one window", e.packTexts === 10000, e);
  }

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
