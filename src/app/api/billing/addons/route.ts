import Stripe from "stripe";
import { z } from "zod";
import { addonByKey, billingConfigured, billingEnabled } from "@/lib/billing/config";
import { configuredAddons, setAddonQuantity, validateAddonQuantity } from "@/lib/billing/addons";
import { findLiveStripeSubscription, getOrCreateCustomer } from "@/lib/billing/checkout";
import { getEntitlements } from "@/lib/billing/org-entitlements";
import { getScheduledChanges } from "@/lib/billing/scheduled";
import { getStripe } from "@/lib/billing/stripe";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

const body = z.object({ addon: z.string().min(1).max(64), quantity: z.number().int().min(0) });

/**
 * Owner/Admin: configured add-ons, what the org is entitled to right now, and what is already scheduled for the
 * next renewal (`scheduled`: add-on decreases/removals, a portal-scheduled plan downgrade, and the entitlements
 * that will apply then; null when nothing is pending). 404 unless BILLING_ENABLED=true.
 */
export async function GET(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  const [entitlements, pending] = await Promise.all([getEntitlements(ctx.org.id), getScheduledChanges(ctx.org.id)]);
  return Response.json({
    addons: configuredAddons(),
    entitlements,
    scheduled: pending.changes && { ...pending.changes, effectiveAt: new Date(pending.changes.effectiveAt * 1000).toISOString() },
    ...(pending.unavailable ? { scheduledUnavailable: true } : {}),
  });
}

/**
 * Owner or Admin sets an add-on's quantity on the org's existing subscription (0 removes it).
 * The quantity may not exceed the add-on's maximum (400; see `addonMaxQuantity`).
 * Never a mid-cycle charge or credit (`proration_behavior: "none"`). An increase or new add-on applies now and is
 * first billed at the next renewal; a decrease or removal stays active until the period ends, then drops
 * (a subscription schedule's next phase; see addons.ts).
 * The mirrored tables update through the customer.subscription.updated webhook, not here.
 * 404 unless BILLING_ENABLED=true; 403 for staff; 409 without an active subscription.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true }); // Owner or Admin; /api/billing/* is exempt from the billing lock
  if (ctx instanceof Response) return ctx;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);

  // Per-add-on maximum (docs/BILLING.md §11): rejected here, before any Stripe call.
  if (addonByKey(parsed.data.addon)) {
    const invalid = validateAddonQuantity(parsed.data.addon, parsed.data.quantity);
    if (invalid) return Response.json({ error: invalid.error }, { status: invalid.status });
  }

  const customer = await getOrCreateCustomer(ctx);
  const live = await findLiveStripeSubscription(customer);
  if (!live) return Response.json({ error: "No subscription yet. Subscribe to a plan first." }, { status: 409 });
  try {
    const result = await setAddonQuantity({ stripe: getStripe(), subscription: live, addon: parsed.data.addon, quantity: parsed.data.quantity });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    const effectiveAt = result.effectiveAt ? new Date(result.effectiveAt * 1000).toISOString() : null;
    const note =
      result.action === "scheduled"
        ? `Stays active until ${effectiveAt}, then ${result.quantity === 0 ? "is removed" : `drops to ${result.quantity}`} at renewal. No credit for the unused time.`
        : result.action === "schedule_cleared"
          ? "The scheduled reduction was cancelled; nothing changes at renewal."
          : result.action === "unchanged"
            ? effectiveAt ? `Already scheduled for ${effectiveAt}.` : "No change."
            : "Active now; first billed at the next renewal (no mid-cycle charge).";
    return Response.json({ ...result, effectiveAt, billing: note });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      console.error("[billing] add-on change rejected by Stripe", err.code, err.message);
      return Response.json({ error: "Stripe rejected the add-on change" }, { status: 400 });
    }
    throw err;
  }
}
