import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { phoneE164Sql } from "@/lib/db/phone-sql";
import { orgBySlug } from "@/lib/server/public-org";
import { runPipeline } from "@/lib/server/pipeline";
import { toE164 } from "@/lib/phone";
import { badRequest, publicBook, readJson } from "@/lib/server/validation";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/server/rate-limit";
import { bookingPaymentsEnabled } from "@/lib/payments/rules";
import { paymentForService, startPaidBooking } from "@/lib/payments/booking-payments";
import { getStripe } from "@/lib/billing/stripe";
import type { BookingRequest } from "@/lib/booking/types";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Per-IP limits (before any other DB work): 8 booking attempts / 10 min per page, 20 / hour overall.
  const ip = clientIp(req);
  for (const [key, max, win] of [[`book:${slug}:${ip}`, 8, 600], [`book:*:${ip}`, 20, 3600]] as const) {
    const rl = await rateLimit(key, max, win);
    if (!rl.ok) return tooManyRequests("Too many booking attempts from your connection — please wait a few minutes and try again.", rl.retryAfter);
  }
  const org = await orgBySlug(slug);
  if (!org) return Response.json({ error: "Booking page not found" }, { status: 404 });
  const parsed = publicBook.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const p = parsed.data;
  if (p.website) return badRequest("Rejected");
  if (p.smsConsent && !toE164(p.phone)) return badRequest("To get text updates, enter a valid US mobile number (e.g. 610-555-1234).");
  const db = getDb();
  const [svc] = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.id, p.serviceId), eq(schema.service.organizationId, org.id), eq(schema.service.active, true)))
    .limit(1);
  if (!svc) return badRequest("Service not found");

  // Light abuse guard: max 5 public bookings per email per org per 24h.
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.booking)
    .where(
      and(
        eq(schema.booking.organizationId, org.id),
        eq(schema.booking.source, "public"),
        sql`lower(${schema.booking.email}) = ${p.email.toLowerCase()}`,
        gte(schema.booking.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  if (n >= 5) return Response.json({ error: "Too many bookings for this email today — please contact the business." }, { status: 429 });

  // SMS abuse guard: every business texts from the same FlowOps number, so cap public bookings that opt a phone
  // into texts at 5 per number per 24h across ALL businesses. Stops someone rotating emails/IPs to flood a stranger's
  // phone (harassment, A2P complaints, Twilio cost). Uses booking_phone_e164_idx (migration 0007).
  const smsPhone = p.smsConsent && p.phone ? toE164(p.phone) : null;
  if (smsPhone) {
    const [{ n: textsToPhone }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.booking)
      .where(
        and(
          sql`${phoneE164Sql(schema.booking.phone)} = ${smsPhone}`,
          eq(schema.booking.source, "public"),
          eq(schema.booking.smsConsent, true),
          gte(schema.booking.createdAt, new Date(Date.now() - 86_400_000)),
        ),
      );
    if (textsToPhone >= 5)
      return Response.json(
        { error: "Too many text-message sign-ups for this phone number today. Uncheck text updates to book, or contact the business." },
        { status: 429 },
      );
  }

  const bookingReq: BookingRequest = {
    customer: p.name,
    email: p.email,
    ...(p.phone ? { phone: p.phone } : {}),
    ...(p.smsConsent && p.phone ? { smsConsent: true } : {}),
    category: svc.category,
    service: svc.name,
    resource: svc.resource,
    date: p.date,
    time: p.time,
    durationMin: svc.durationMin,
    ...(p.notes ? { notes: p.notes } : {}),
  };

  // Payments at booking (ships dark: BOOKING_PAYMENTS_ENABLED). With the flag off, or a service set to "none", or no
  // ready Stripe account, this block does nothing and the booking below runs exactly as before.
  if (bookingPaymentsEnabled()) {
    const due = await paymentForService(org.id, svc);
    if (due) {
      const started = await startPaidBooking(org, svc, bookingReq, due, { origin: new URL(req.url).origin, stripe: getStripe() });
      if (started.kind === "error") return Response.json({ ok: false, outcome: "failed", error: started.error }, { status: started.status });
      if (started.kind === "rejected") {
        const r = started.result;
        return Response.json({
          ok: false,
          outcome: r.outcome,
          error: r.outcome === "conflict" ? "That time was just taken — please pick another slot." : r.error,
          suggestion: r.suggestion,
          booking: null,
        });
      }
      return Response.json({
        ok: true,
        outcome: "payment_required",
        checkoutUrl: started.checkoutUrl,
        hold: { id: started.hold.id, expiresAt: started.hold.expiresAt.toISOString() },
        payment: { amountCents: due.due.amountCents, currency: due.due.currency, kind: due.due.kind },
        booking: null,
      });
    }
  }

  const result = await runPipeline(org, { action: "create", req: bookingReq }, { actor: `public:${p.email.toLowerCase()}`, source: "public" });
  // Don't leak other customers' booking details to the public.
  return Response.json({
    ok: result.ok,
    outcome: result.outcome,
    error: result.ok ? undefined : result.outcome === "conflict" ? "That time was just taken — please pick another slot." : result.error,
    suggestion: result.suggestion,
    booking: result.booking
      ? { id: result.booking.id, service: result.booking.service, date: result.booking.date, time: result.booking.time, durationMin: result.booking.durationMin }
      : null,
    notifications: result.steps.find((s) => s.agent === "NotificationAgent")?.simulated ? "simulated" : "sent",
  });
}
