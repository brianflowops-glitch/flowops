import { z } from "zod";
import { billingConfigured, billingEnabled, plans, planByPriceId } from "@/lib/billing/config";
import { findLiveStripeSubscription, getOrCreateCustomer } from "@/lib/billing/checkout";
import { changePlan, pendingCancelAt, UPGRADE_POLICY } from "@/lib/billing/plan-change";
import { scheduledChanges } from "@/lib/billing/addons";
import { getStripe } from "@/lib/billing/stripe";
import { withAddonChangeLock } from "@/lib/billing/addon-charges-db";
import { demoOrgResponse, planChangeFailureResponse } from "@/lib/billing/plan-route-helpers";
import { BILLING_SUPPORT_EMAIL } from "@/lib/billing/support";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

/** Below the session connection's idle_session_timeout (db/index.ts), so a lock is never cut off mid-request. */
export const maxDuration = 60;

const body = z.object({ plan: z.string().min(1).max(64), interval: z.enum(["month", "year"]) });
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);

/**
 * Owner/Admin: the subscription's plan, interval, status, trial end, pending cancellation and scheduled changes (read
 * live from Stripe), the plans the in-app switcher offers, and the support contact. 404 unless BILLING_ENABLED=true.
 * The Stripe portal is for the card and invoices only (plan switching and quantity changes are OFF there).
 */
export async function GET(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  const base = { plans: plans().map((p) => ({ key: p.key, interval: p.interval })), upgradePolicy: UPGRADE_POLICY, supportEmail: BILLING_SUPPORT_EMAIL, demo: ctx.org.isDemo };
  const customer = await getOrCreateCustomer(ctx);
  const live = await findLiveStripeSubscription(customer);
  if (!live) return Response.json({ ...base, subscription: null });
  const stripe = getStripe();
  const scheduleId = live.schedule ? (typeof live.schedule === "string" ? live.schedule : live.schedule.id) : null;
  const schedule = scheduleId ? await stripe.subscriptionSchedules.retrieve(scheduleId) : null;
  const planItem = live.items.data.find((i) => planByPriceId(i.price.id));
  const current = planItem ? planByPriceId(planItem.price.id) : undefined;
  const pending = scheduledChanges(schedule);
  return Response.json({
    ...base,
    subscription: {
      status: live.status,
      plan: current?.key ?? null,
      interval: current?.interval ?? null,
      trialEnd: live.status === "trialing" ? iso(live.trial_end) : null,
      periodEnd: iso(live.items.data[0]?.current_period_end),
      cancelAt: iso(pendingCancelAt(live, schedule)),
      hasAddons: live.items.data.length > 1,
      hasSchedule: Boolean(schedule && schedule.status === "active"),
    },
    scheduled: pending && { ...pending, effectiveAt: iso(pending.effectiveAt) },
  });
}

/**
 * Owner/Admin: switch plan and/or interval in the app (plan-change.ts has the policy). Upgrades follow UPGRADE_POLICY
 * (default prorate_now: charged now, only applied if paid); downgrades and annual → monthly at the next renewal;
 * trials are never charged. One billing change per org at a time (the add-on lock: 409 change_in_progress).
 * 403 for the demo org; 409 without a live subscription.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  if (ctx.org.isDemo) return demoOrgResponse();
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  let result: Awaited<ReturnType<typeof changePlan>>;
  try {
    const customer = await getOrCreateCustomer(ctx);
    const live = await findLiveStripeSubscription(customer);
    if (!live) return Response.json({ error: "No subscription yet. Subscribe to a plan first." }, { status: 409 });
    result = await withAddonChangeLock(ctx.org.id, () => changePlan({ stripe: getStripe(), subscription: live, plan: parsed.data.plan, interval: parsed.data.interval }));
  } catch (err) {
    const res = planChangeFailureResponse(err, "plan change");
    if (res) return res;
    throw err;
  }
  if (!result.ok)
    return Response.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.portal ? { portal: "/api/billing/portal" } : {}), ...(result.support ? { support: BILLING_SUPPORT_EMAIL } : {}) },
      { status: result.status },
    );
  const effectiveAt = iso(result.effectiveAt);
  const label = `${result.plan} (${result.interval === "year" ? "yearly" : "monthly"})`;
  const note =
    result.action === "scheduled"
      ? `Your plan changes to ${label} at the next renewal (${effectiveAt}). Nothing changes until then; no credit for the unused time.`
      : result.action === "pending_cleared"
        ? "The scheduled plan change was cancelled; you stay on your current plan."
        : result.action === "unchanged"
          ? "You are already on this plan."
          : result.trialEnd
            ? `Now on ${label}, free for the rest of the trial. Nothing is charged until the trial ends (${iso(result.trialEnd)}).`
            : result.charge
              ? `Now on ${label}. Charged ${(result.charge.amountPaid / 100).toFixed(2)} ${result.charge.currency.toUpperCase()} now, prorated for the rest of this billing period.`
              : `Now on ${label}.`;
  return Response.json({ ...result, effectiveAt, trialEnd: iso(result.trialEnd), billing: note });
}
