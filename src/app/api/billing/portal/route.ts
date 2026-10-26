import { billingConfigured, billingEnabled } from "@/lib/billing/config";
import { getOrCreateCustomer } from "@/lib/billing/checkout";
import { getStripe } from "@/lib/billing/stripe";
import { requireApi } from "@/lib/server/context";

/** Owner or Admin opens the Stripe Customer Portal (payment method, invoices, cancel). 404 unless BILLING_ENABLED=true. */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true }); // Owner or Admin (canManageBilling); /api/billing/* is exempt from the billing lock
  if (ctx instanceof Response) return ctx;
  const customer = await getOrCreateCustomer(ctx);
  const portal = await getStripe().billingPortal.sessions.create({ customer, return_url: `${new URL(req.url).origin}/admin` });
  return Response.json({ url: portal.url });
}
