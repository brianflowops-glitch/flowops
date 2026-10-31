import { getStripe } from "@/lib/billing/stripe";
import { getHold, holdView, pollHold } from "@/lib/payments/booking-payments";
import { bookingPaymentsEnabled } from "@/lib/payments/rules";
import { orgBySlug } from "@/lib/server/public-org";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/server/rate-limit";

/** Booking page after Checkout: the hold's status (pending → paid with the booking, or expired/conflict). */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  if (!bookingPaymentsEnabled()) return new Response("Not found", { status: 404 });
  const { slug, id } = await params;
  const rl = await rateLimit(`hold:${clientIp(req)}`, 120, 600);
  if (!rl.ok) return tooManyRequests("Too many requests — please wait a moment.", rl.retryAfter);
  const org = await orgBySlug(slug);
  let hold = org ? await getHold(id) : null;
  if (!org || !hold || hold.organizationId !== org.id) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    hold = await pollHold(hold, getStripe());
  } catch (err) {
    console.error("[payments] hold poll failed", hold.id, err instanceof Error ? err.message : "unknown");
  }
  return Response.json({ hold: await holdView(hold) }, { headers: { "Cache-Control": "no-store" } });
}
