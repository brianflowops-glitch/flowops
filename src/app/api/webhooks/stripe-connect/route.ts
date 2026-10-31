import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";
import { hasDatabase } from "@/lib/db";
import { confirmPaidHold, expireHold, getHold } from "@/lib/payments/booking-payments";
import { bookingPaymentsEnabled } from "@/lib/payments/rules";

/**
 * Stripe Connect webhook for payments at booking ("Events on Connected accounts" endpoint in the Stripe dashboard,
 * secret STRIPE_CONNECT_WEBHOOK_SECRET). 404 unless BOOKING_PAYMENTS_ENABLED=true.
 *   checkout.session.completed (paid) / checkout.session.async_payment_succeeded → confirm the booking
 *   checkout.session.expired / checkout.session.async_payment_failed               → free the held slot
 * Idempotent through the hold's state (re-deliveries and the customer's status poll converge). Events whose hold
 * belongs to a different connected account than the one the event came from are ignored.
 */
const HANDLED = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired", "checkout.session.async_payment_failed"]);

export async function POST(req: Request) {
  if (!bookingPaymentsEnabled()) return new Response("Not found", { status: 404 });
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret || !hasDatabase()) return Response.json({ error: "Payments not configured" }, { status: 503 });
  const signature = req.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Missing stripe-signature" }, { status: 400 });
  const payload = await req.text();
  let stripe: Stripe;
  let event: Stripe.Event;
  try {
    stripe = getStripe();
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (!HANDLED.has(event.type)) return Response.json({ received: true, status: "ignored" });

  const session = event.data.object as Stripe.Checkout.Session;
  const holdId = session.metadata?.flowops_hold_id;
  if (!holdId) return Response.json({ received: true, status: "ignored" });
  try {
    const hold = await getHold(holdId);
    if (!hold || !event.account || hold.stripeAccountId !== event.account) return Response.json({ received: true, status: "ignored" });
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const out = await confirmPaidHold(hold, session, { stripe });
      return Response.json({ received: true, status: out.status });
    }
    await expireHold(hold.id, event.type === "checkout.session.expired" ? "checkout_expired" : "async_payment_failed");
    return Response.json({ received: true, status: "released" });
  } catch (err) {
    console.error("[payments] connect webhook failed", event.id, event.type, err instanceof Error ? err.message : "unknown");
    return Response.json({ error: "Processing failed" }, { status: 500 }); // Stripe retries
  }
}
