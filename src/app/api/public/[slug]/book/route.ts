import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { orgBySlug } from "@/lib/server/public-org";
import { runPipeline } from "@/lib/server/pipeline";
import { badRequest, publicBook, readJson } from "@/lib/server/validation";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/server/rate-limit";

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

  const result = await runPipeline(
    org,
    {
      action: "create",
      req: {
        customer: p.name,
        email: p.email,
        ...(p.phone ? { phone: p.phone } : {}),
        category: svc.category,
        service: svc.name,
        resource: svc.resource,
        date: p.date,
        time: p.time,
        durationMin: svc.durationMin,
        ...(p.notes ? { notes: p.notes } : {}),
      },
    },
    { actor: `public:${p.email.toLowerCase()}`, source: "public" },
  );
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
