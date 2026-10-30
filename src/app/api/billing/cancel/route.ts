import { z } from "zod";
import { billingConfigured, billingEnabled } from "@/lib/billing/config";
import { findLiveStripeSubscription, getOrCreateCustomer } from "@/lib/billing/checkout";
import { setCancelAtPeriodEnd } from "@/lib/billing/plan-change";
import { getStripe } from "@/lib/billing/stripe";
import { withAddonChangeLock } from "@/lib/billing/addon-charges-db";
import { demoOrgResponse, planChangeFailureResponse } from "@/lib/billing/plan-route-helpers";
import { BILLING_SUPPORT_EMAIL } from "@/lib/billing/support";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

export const maxDuration = 60;

const body = z.object({ cancel: z.boolean() });

/**
 * Owner/Admin: cancel at the end of the current period (or trial), or resume. Schedule-safe: with a pending add-on
 * removal or plan change the schedule ends with `end_behavior: "cancel"` and the pending phase is kept for a resume
 * (plan-change.ts `setCancelAtPeriodEnd`). Never cancels immediately, never refunds. Same per-org lock as add-ons.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  if (ctx.org.isDemo) return demoOrgResponse();
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  let result: Awaited<ReturnType<typeof setCancelAtPeriodEnd>>;
  try {
    const customer = await getOrCreateCustomer(ctx);
    const live = await findLiveStripeSubscription(customer);
    if (!live) return Response.json({ error: "No subscription to cancel." }, { status: 409 });
    result = await withAddonChangeLock(ctx.org.id, () => setCancelAtPeriodEnd(getStripe(), live, parsed.data.cancel));
  } catch (err) {
    const res = planChangeFailureResponse(err, "cancellation");
    if (res) return res;
    throw err;
  }
  if (!result.ok) return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.support ? { support: BILLING_SUPPORT_EMAIL } : {}) }, { status: result.status });
  const cancelAt = result.cancelAt ? new Date(result.cancelAt * 1000).toISOString() : null;
  return Response.json({ ...result, cancelAt, billing: cancelAt ? `Your subscription ends on ${cancelAt}. You keep access until then; nothing is refunded.` : "Your subscription continues." });
}
