// Offline billing checks (no network, no database): `npm run test:billing`
import Stripe from "stripe";
import { addonByKey, addonByPriceId, addons, isLiveKey, planByKey, planByPriceId, plans } from "../src/lib/billing/config";
import { addonEffect, classifyItems, computeEntitlements, entitlementsFromItems, parsePlanLimits, planLimits, DEFAULT_PLAN_LIMITS } from "../src/lib/billing/entitlements";
import { phaseItems, retrieveSubscriptionComplete, scheduledChanges, setAddonQuantity, type AddonStripe } from "../src/lib/billing/addons";
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

  // ── add-ons: config, limits, entitlements (docs/BILLING.md §11) ──
  const aenv = { STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_PRO: "price_p", STRIPE_ADDON_PRICE_SEAT: "price_seat", STRIPE_ADDON_PRICE_LOCATION: "price_loc", STRIPE_ADDON_PRICE_TEXTS_1000: "price_t1k", STRIPE_ADDON_PRICE_BRANDING: "price_brand", STRIPE_ADDON_PRICE_EMPTY: "" };
  check("addons() reads only non-empty STRIPE_ADDON_PRICE_* vars, lowercased keys", JSON.stringify(addons(aenv).map((a) => a.key)) === '["branding","location","seat","texts_1000"]');
  check("add-on env vars are never mistaken for plans", JSON.stringify(plans(aenv).map((p) => p.key)) === '["pro","starter"]');
  check("addonByKey is case-insensitive, addonByPriceId maps back", addonByKey("SEAT", aenv)?.priceId === "price_seat" && addonByPriceId("price_t1k", aenv)?.key === "texts_1000");
  check("no add-ons configured → empty list", addons({}).length === 0 && addonByPriceId("price_x", {}) === undefined);
  check("default limits: starter 3/1/500, no branding removal", JSON.stringify(planLimits("starter", {})) === JSON.stringify({ seats: 3, locations: 1, monthlyTexts: 500, brandingRemoved: false, source: "configured" }));
  check("default limits: pro 10/1/2000, branding removed", JSON.stringify(planLimits("pro", {})) === JSON.stringify({ seats: 10, locations: 1, monthlyTexts: 2000, brandingRemoved: true, source: "configured" }));
  check("plan key lookup is case-insensitive", planLimits("PRO", {}).seats === 10);
  const kv = planLimits("starter", { PLAN_LIMITS_STARTER: "seats=5, locations=2,texts=800,branding=true" });
  check("PLAN_LIMITS_<PLAN> key=value form overrides defaults", kv.seats === 5 && kv.locations === 2 && kv.monthlyTexts === 800 && kv.brandingRemoved === true);
  const js = planLimits("pro", { PLAN_LIMITS_PRO: '{"seats":25,"texts":5000}' });
  check("PLAN_LIMITS_<PLAN> JSON form; unspecified fields keep defaults", js.seats === 25 && js.monthlyTexts === 5000 && js.locations === 1 && js.brandingRemoved === true);
  const biz = planLimits("business", { PLAN_LIMITS_BUSINESS: "seats=30,locations=5,texts=10000,branding=true" });
  check("a plan with no built-in default can be fully defined from env", biz.source === "configured" && biz.seats === 30 && biz.locations === 5 && biz.monthlyTexts === 10000);
  check("unknown plan without limits → smallest tier, flagged fallback", planLimits("business", {}).source === "fallback" && planLimits("business", {}).seats === 3);
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
        create: async (p) => (calls.push(`create ${p.price} x${p.quantity} proration=${p.proration_behavior}`), { id: "si_new" } as Stripe.SubscriptionItem),
        update: async (id, p) => (calls.push(`update ${id} x${p.quantity} proration=${p.proration_behavior}`), { id } as Stripe.SubscriptionItem),
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
  check("add-on: new add-on → subscriptionItems.create with proration none", r.ok && r.action === "created" && r.currentQuantity === 2 && calls.at(-1) === "create price_seat x2 proration=none", { r, calls });
  const withSeat = fakeSub([{ id: "si_plan", price: "price_s" }, { id: "si_seat", price: "price_seat", q: 4 }]);
  r = await setAddonQuantity({ stripe: mkStripe(withSeat), subscription: act, addon: "SEAT", quantity: 6, env: aenv });
  check("add-on: increase an existing add-on → update quantity now, proration none", r.ok && r.action === "updated" && r.currentQuantity === 6 && calls.at(-1) === "update si_seat x6 proration=none", { r, calls });

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
  check("add-on: increase after a pending decrease → the pending decrease is replaced (both phases at 7) and the now-pointless schedule is released", r.ok && r.action === "updated" && r.currentQuantity === 7 && calls.at(-2)!.startsWith("schedule.update") && calls.at(-2)!.includes("price_seatx7[none] | price_sx1+price_seatx7") && calls.at(-1) === "schedule.release" && st.schedule() === null, { r, calls: calls.slice(nCalls) });

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
  check("add-on: an increase with a plan downgrade pending raises both phases, no item write", r.ok && r.action === "updated" && phaseItemsStr(st.schedule()!.phases[0]) === "price_p×1,price_seat×5,price_loc×2" && phaseItemsStr(st.schedule()!.phases[1]) === "price_s×1,price_seat×5,price_loc×2" && !calls.at(-1)!.startsWith("update "), { r, calls: calls.slice(-2) });
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
