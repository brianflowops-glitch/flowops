import { z } from "zod";
import { billingConfigured, billingEnabled, planByKey } from "@/lib/billing/config";
import { getOrCreateCustomer } from "@/lib/billing/checkout";
import { getStripe } from "@/lib/billing/stripe";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson } from "@/lib/server/validation";

const body = z.object({ plan: z.string().min(1).max(64) });

/** Owner starts Stripe Checkout for a configured plan. 404 unless BILLING_ENABLED=true. */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  if (!billingConfigured()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const plan = planByKey(parsed.data.plan);
  if (!plan) return badRequest("Unknown plan");

  const origin = new URL(req.url).origin;
  const customer = await getOrCreateCustomer(ctx);
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: ctx.org.id,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    subscription_data: { metadata: { organizationId: ctx.org.id } },
    metadata: { organizationId: ctx.org.id },
    success_url: `${origin}/admin?billing=success`,
    cancel_url: `${origin}/admin?billing=cancelled`,
  });
  return Response.json({ url: session.url });
}
