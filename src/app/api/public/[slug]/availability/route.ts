import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { orgBySlug } from "@/lib/server/public-org";
import { availability } from "@/lib/server/pipeline";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await orgBySlug(slug);
  if (!org) return Response.json({ error: "Booking page not found" }, { status: 404 });
  const url = new URL(req.url);
  const serviceId = url.searchParams.get("serviceId") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  const [svc] = await getDb()
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.id, serviceId), eq(schema.service.organizationId, org.id), eq(schema.service.active, true)))
    .limit(1);
  if (!svc) return Response.json({ error: "Service not found" }, { status: 404 });
  const slots = await availability(org, { resource: svc.resource, date, durationMin: svc.durationMin });
  return Response.json({ date, slots }, { headers: { "Cache-Control": "no-store" } });
}
