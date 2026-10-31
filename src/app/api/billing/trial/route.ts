import { and, eq } from "drizzle-orm";
import { billingConfigured, billingEnabled } from "@/lib/billing/config";
import { findCustomerId } from "@/lib/billing/checkout";
import { getStripe } from "@/lib/billing/stripe";
import { defaultPaymentMethod, trialBanner } from "@/lib/billing/trial-rules";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";

/**
 * Owner/Admin: the dashboard's "add a card before your trial ends" banner (no-card trial, checkout-params.ts).
 * `{ trial: null }` unless the org's mirrored subscription is trialing; only then is Stripe asked (trial end + whether
 * a default payment method exists). Read-only: never creates a customer and never writes. 404 unless BILLING_ENABLED=true.
 */
export async function GET(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  if (ctx.org.isDemo) return Response.json({ trial: null });
  const [row] = await getDb()
    .select({ id: schema.subscription.stripeSubscriptionId })
    .from(schema.subscription)
    .where(and(eq(schema.subscription.organizationId, ctx.org.id), eq(schema.subscription.status, "trialing")))
    .limit(1);
  if (!row) return Response.json({ trial: null });
  const customerId = await findCustomerId(ctx.org.id);
  const stripe = getStripe();
  try {
    const sub = await stripe.subscriptions.retrieve(row.id);
    const customer = customerId ? await stripe.customers.retrieve(customerId) : null;
    const trial = trialBanner({ status: sub.status, trialEnd: sub.trial_end, hasPaymentMethod: Boolean(defaultPaymentMethod(sub, customer)) });
    return Response.json({ trial }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[billing] trial banner: Stripe lookup failed", err instanceof Error ? err.message : "unknown");
    return Response.json({ trial: null });
  }
}
