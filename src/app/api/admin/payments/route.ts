import { stripeSecretKey } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { ensureConnectAccount, getConnectRow, onboardingLink, refreshConnectRow, statusOf } from "@/lib/payments/connect";
import { bookingPaymentsEnabled } from "@/lib/payments/rules";
import { requireApi } from "@/lib/server/context";
import { readJson } from "@/lib/server/validation";

/**
 * Settings → Payments (payments at booking, BOOKING_PAYMENTS_ENABLED). 404 while the flag is off.
 * GET  (Owner/Admin): the business's Stripe account status, refreshed from Stripe.
 * POST (Owner) {action:"onboard"}: create the connected account on first use and return a Stripe-hosted onboarding
 *      (or update) link to redirect to. Money from deposits goes to that account; FlowOps takes no fee.
 */
export async function GET(req: Request) {
  if (!bookingPaymentsEnabled()) return new Response("Not found", { status: 404 });
  const ctx = await requireApi(req, { manager: true });
  if (ctx instanceof Response) return ctx;
  let row = await getConnectRow(ctx.org.id);
  if (row && stripeSecretKey()) {
    try {
      row = await refreshConnectRow(row, getStripe());
    } catch (err) {
      console.error("[payments] account refresh failed", ctx.org.id, err instanceof Error ? err.message : "unknown");
    }
  }
  return Response.json({ payments: { ...statusOf(row), configured: !!stripeSecretKey() } }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!bookingPaymentsEnabled()) return new Response("Not found", { status: 404 });
  if (!stripeSecretKey()) return Response.json({ error: "Payments not configured" }, { status: 503 });
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const body = (await readJson(req)) as { action?: unknown } | undefined;
  if (body?.action !== "onboard") return Response.json({ error: 'Expected {"action":"onboard"}' }, { status: 400 });
  try {
    const stripe = getStripe();
    const row = await ensureConnectAccount(ctx.org, ctx.user.email, stripe);
    const url = await onboardingLink(row, new URL(req.url).origin, stripe);
    return Response.json({ url, payments: statusOf(row) });
  } catch (err) {
    console.error("[payments] onboarding failed", ctx.org.id, err instanceof Error ? err.message : "unknown");
    return Response.json({ error: "Couldn't start Stripe setup — please try again." }, { status: 502 });
  }
}
