import { z } from "zod";
import { billingConfigured, billingEnabled, planByKey, plans, trialDays } from "@/lib/billing/config";
import { expireOpenCheckoutSessions, findLiveStripeSubscription, getOrCreateCustomer, trialEligibility } from "@/lib/billing/checkout";
import { checkoutSessionParams } from "@/lib/billing/checkout-params";
import { getStripe } from "@/lib/billing/stripe";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

const body = z.object({ plan: z.string().min(1).max(64), interval: z.enum(["month", "year"]).default("month") });

/**
 * Owner or Admin starts Stripe Checkout for a configured plan, monthly (default) or yearly. The first subscription
 * of an org gets the free trial (TRIAL_DAYS, default 14; card collected up front); an org that ever had a
 * subscription never gets another. 404 unless BILLING_ENABLED=true.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true }); // Owner or Admin (canManageBilling); /api/billing/* is exempt from the billing lock
  if (ctx instanceof Response) return ctx;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const { interval } = parsed.data;
  const plan = planByKey(parsed.data.plan, undefined, interval);
  if (!plan) return badRequest(plans().some((p) => p.key === parsed.data.plan.toLowerCase()) ? `The ${parsed.data.plan} plan has no ${interval === "year" ? "yearly" : "monthly"} price` : "Unknown plan");

  const origin = new URL(req.url).origin;
  const customer = await getOrCreateCustomer(ctx);
  // One subscription per org: a second Checkout would double-bill. Plan changes go through the portal.
  // Old open sessions are expired first, so a stale checkout tab can't start a second subscription either.
  await expireOpenCheckoutSessions(customer);
  const live = await findLiveStripeSubscription(customer);
  if (live)
    return Response.json(
      { error: "This organization already has a subscription. Use the billing portal to change plan or payment method.", status: live.status },
      { status: 409 },
    );
  const days = trialDays();
  const trial = days > 0 && (await trialEligibility(ctx.org.id, customer)).eligible;
  const session = await getStripe().checkout.sessions.create(checkoutSessionParams({ orgId: ctx.org.id, customer, priceId: plan.priceId, origin, trialDays: trial ? days : 0 }));
  return Response.json({ url: session.url, plan: plan.key, interval, trialDays: trial ? days : 0 });
}
