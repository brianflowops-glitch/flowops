import type Stripe from "stripe";
import { billingEnabled, webhookSecret } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { processStripeEvent } from "@/lib/billing/webhook";
import { hasDatabase } from "@/lib/db";

/** Stripe webhook endpoint (docs/BILLING.md). 404 unless BILLING_ENABLED=true. */
export async function POST(req: Request) {
  if (!billingEnabled()) return new Response("Not found", { status: 404 });
  const secret = webhookSecret();
  if (!secret || !hasDatabase()) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const signature = req.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Missing stripe-signature" }, { status: 400 });

  const payload = await req.text(); // raw body: required for signature verification
  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const result = await processStripeEvent(event);
    return Response.json({ received: true, ...result });
  } catch (err) {
    console.error("[billing] webhook processing failed", event.id, event.type, err);
    return Response.json({ error: "Processing failed" }, { status: 500 }); // Stripe retries
  }
}
