import { orgBySlug } from "@/lib/server/public-org";
import { listServices, orgToday } from "@/lib/server/pipeline";
import { getConnectRow } from "@/lib/payments/connect";
import { bookingPaymentsEnabled, paymentDue, paymentLabel } from "@/lib/payments/rules";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await orgBySlug(slug);
  if (!org) return Response.json({ error: "Booking page not found" }, { status: 404 });
  const rows = await listServices(org.id, true);
  // Payments at booking: only with the flag on AND a ready Stripe account does a service carry `payment`; otherwise
  // the response is exactly as before.
  const canCharge = bookingPaymentsEnabled() && !!(await getConnectRow(org.id))?.chargesEnabled;
  const services = rows.map((s) => {
    const base = { id: s.id, name: s.name, durationMin: s.durationMin, description: s.description, category: s.category };
    const due = canCharge ? paymentDue(s) : null;
    return due ? { ...base, payment: { amountCents: due.amountCents, currency: due.currency, kind: due.kind, label: paymentLabel(due) } } : base;
  });
  return Response.json({ org: { slug: org.slug, name: org.name, timeZone: org.timeZone, hours: org.hours }, services, today: orgToday(org) });
}
