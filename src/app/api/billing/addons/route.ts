import Stripe from "stripe";
import { z } from "zod";
import { addonByKey, addons, billingConfigured, billingEnabled, isTextPackKey, textPackSize } from "@/lib/billing/config";
import { addonMaxQuantity } from "@/lib/billing/entitlements";
import { configuredAddons, setAddonQuantity, validateAddonQuantity } from "@/lib/billing/addons";
import { findLiveStripeSubscription, getOrCreateCustomer } from "@/lib/billing/checkout";
import { getEntitlements } from "@/lib/billing/org-entitlements";
import { getScheduledChanges } from "@/lib/billing/scheduled";
import { getStripe } from "@/lib/billing/stripe";
import { addonLockFailureResponse, withAddonChangeLock } from "@/lib/billing/addon-charges-db";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

/** Below the session connection's idle_session_timeout (db/index.ts), so a lock is never cut off mid-request. */
export const maxDuration = 60;

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
    // One-time packs (POST /api/billing/text-packs): `max` is per billing period. What is active now is in entitlements.packs.
    textPacks: addons()
      .filter((a) => a.interval === "one_time")
      .map((a) => ({ key: a.key, priceId: a.priceId, texts: textPackSize(a.key), max: addonMaxQuantity(a.key) })),
    entitlements,
    scheduled: pending.changes && { ...pending.changes, effectiveAt: new Date(pending.changes.effectiveAt * 1000).toISOString() },
    ...(pending.unavailable ? { scheduledUnavailable: true } : {}),
  });
}

/**
 * Owner or Admin sets a RECURRING add-on's quantity (seat, location, branding; text packs are one-time, see text-packs/route.ts) on the org's existing subscription (0 removes it).
 * The quantity may not exceed the add-on's maximum (400; see `addonMaxQuantity`).
 * An increase or new add-on is CHARGED NOW, prorated for the rest of the current period (Stripe `always_invoice`;
 * during a free trial the rest of the trial at the add-on's rate, on its own invoice) and applies only once that
 * charge is paid: a declined card (or no card on file in a trial) → 402 with a portal pointer, nothing added.
 * A decrease or removal stays active until the period ends, then drops (a subscription schedule's next phase;
 * see addons.ts). No refund, no credit. Changes for one org are serialised (per-org advisory lock on ONE dedicated
 * connection, `withAddonChangeLock`) so a double click can't double-charge; 409 `change_in_progress` if another change
 * of the org holds the lock for more than 20 s, 503 `db_unavailable` if no database connection is free in time.
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

  if (isTextPackKey(parsed.data.addon)) return Response.json({ error: "Text bundles are one-time packs now. Buy them with POST /api/billing/text-packs; they are not a recurring add-on." }, { status: 400 });
  // Per-add-on maximum (docs/BILLING.md §11): rejected here, before any Stripe call.
  if (addonByKey(parsed.data.addon)) {
    const invalid = validateAddonQuantity(parsed.data.addon, parsed.data.quantity);
    if (invalid) return Response.json({ error: invalid.error }, { status: invalid.status });
  }

  let result: Awaited<ReturnType<typeof setAddonQuantity>>;
  try {
    const customer = await getOrCreateCustomer(ctx);
    const live = await findLiveStripeSubscription(customer);
    if (!live) return Response.json({ error: "No subscription yet. Subscribe to a plan first." }, { status: 409 });
    // One add-on change per org at a time, on one connection: the lock and the trial-charge ledger share it (0006).
    result = await withAddonChangeLock(ctx.org.id, (ledger) => setAddonQuantity({ stripe: getStripe(), subscription: live, addon: parsed.data.addon, quantity: parsed.data.quantity, ledger }));
  } catch (err) {
    const busy = addonLockFailureResponse(err);
    if (busy) return busy;
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      console.error("[billing] add-on change rejected by Stripe", err.code, err.message);
      return Response.json({ error: "Stripe rejected the add-on change" }, { status: 400 });
    }
    throw err;
  }
  if (!result.ok) return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.portal ? { portal: "/api/billing/portal" } : {}) }, { status: result.status });
  const effectiveAt = result.effectiveAt ? new Date(result.effectiveAt * 1000).toISOString() : null;
  const note =
    result.action === "scheduled"
      ? `Stays active until ${effectiveAt}, then ${result.quantity === 0 ? "is removed" : `drops to ${result.quantity}`} at renewal. No credit for the unused time.`
      : result.action === "schedule_cleared"
        ? "The scheduled reduction was cancelled; nothing changes at renewal."
        : result.action === "unchanged"
          ? effectiveAt ? `Already scheduled for ${effectiveAt}.` : "No change."
          : result.charge
            ? `Active now. Charged ${(result.charge.amountPaid / 100).toFixed(2)} ${result.charge.currency.toUpperCase()} now, prorated ${result.charge.kind === "trial_proration" ? "for the rest of the free trial" : "for the rest of this billing period"}; full price from the next renewal.`
            : "Active now; full price from the next renewal.";
  return Response.json({ ...result, effectiveAt, billing: note });
}
