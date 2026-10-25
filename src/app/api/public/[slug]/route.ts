import { orgBySlug } from "@/lib/server/public-org";
import { listServices, orgToday } from "@/lib/server/pipeline";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await orgBySlug(slug);
  if (!org) return Response.json({ error: "Booking page not found" }, { status: 404 });
  const services = (await listServices(org.id, true)).map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, description: s.description, category: s.category }));
  return Response.json({ org: { slug: org.slug, name: org.name, timeZone: org.timeZone, hours: org.hours }, services, today: orgToday(org) });
}
