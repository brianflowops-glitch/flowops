import { billingConfigured, billingEnabled } from "@/lib/billing/config";
import { getOrCreateCustomer } from "@/lib/billing/checkout";
import { getStripe } from "@/lib/billing/stripe";
import { requireApi } from "@/lib/server/context";
import { readJson } from "@/lib/server/validation";

/**
 * Owner or Admin opens the Stripe Customer Portal (payment method, invoices; plan switching stays off there, see docs/BILLING.md §13). 404 unless BILLING_ENABLED=true.
 * Body `{ "flow": "payment_method_update" }` (optional) deep-links straight to "add a card" (the trial banner's button).
 */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { manager: true }); // Owner or Admin (canManageBilling); /api/billing/* is exempt from the billing lock
  if (ctx instanceof Response) return ctx;
  const body = (await readJson(req)) as { flow?: unknown } | undefined;
  const addCard = body?.flow === "payment_method_update";
  const customer = await getOrCreateCustomer(ctx);
  const portal = await getStripe().billingPortal.sessions.create({
    customer,
    return_url: `${new URL(req.url).origin}/admin`,
    ...(addCard ? { flow_data: { type: "payment_method_update" as const } } : {}),
  });
  return Response.json({ url: portal.url });
}
