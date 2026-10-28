import Stripe from "stripe";
import { z } from "zod";
import { billingConfigured, billingEnabled } from "@/lib/billing/config";
import { findLiveStripeSubscription, getOrCreateCustomer } from "@/lib/billing/checkout";
import { purchaseTextPack, type PackStripe } from "@/lib/billing/text-packs";
import { validateTextPackRequest } from "@/lib/billing/text-pack-rules";
import { getStripe } from "@/lib/billing/stripe";
import { getDb } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

const body = z.object({ pack: z.string().min(1).max(64), quantity: z.number().int().min(1).default(1) });

/**
 * Owner or Admin buys one-time text packs. The card on file is charged in full, right now, with its own invoice
 * (also during a free trial; no card on file → 402). The texts are granted only after Stripe confirms the
 * payment: a declined card returns 402 (pointing to the billing portal), voids the invoice and grants nothing.
 * At most `STRIPE_ADDON_MAX_TEXTS_<n>` packs (default 10) per billing period. 404 unless BILLING_ENABLED=true.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true }); // Owner or Admin; /api/billing/* is exempt from the billing lock
  if (ctx instanceof Response) return ctx;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const valid = validateTextPackRequest(parsed.data.pack, parsed.data.quantity);
  if (!valid.ok) return Response.json({ error: valid.error }, { status: valid.status });

  const customer = await getOrCreateCustomer(ctx);
  const live = await findLiveStripeSubscription(customer);
  if (!live) return Response.json({ error: "No subscription yet. Subscribe to a plan first." }, { status: 409 });
  try {
    const result = await purchaseTextPack({ stripe: getStripe() as unknown as PackStripe, db: getDb(), orgId: ctx.org.id, customerId: customer, subscription: live, pack: parsed.data.pack, quantity: parsed.data.quantity });
    if (!result.ok) return Response.json({ error: result.error, code: result.code, ...(result.portal ? { portal: "/api/billing/portal" } : {}) }, { status: result.status });
    const { ok: _ok, ...rest } = result;
    void _ok;
    return Response.json({ ...rest, billing: "Charged in full now, to the card on file. Unused texts roll over for one more billing period and expire at validUntil. Your plan's monthly texts are used first, then packs (soonest-expiring first)." });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      console.error("[billing] text pack purchase error", err.code, err.message);
      return Response.json({ error: "Stripe could not complete the purchase; nothing was added." }, { status: 502 });
    }
    throw err;
  }
}
