import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { publicOrg, requireApi } from "@/lib/server/context";
import { badRequest, orgPatch, readJson } from "@/lib/server/validation";

export async function PATCH(req: Request) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const parsed = orgPatch.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const p = parsed.data;
  if (p.hours) {
    for (const [d, h] of Object.entries(p.hours)) if (h && h.open >= h.close) return badRequest(`hours.${d}: open must be before close`);
  }
  const db = getDb();
  if (p.slug && p.slug !== ctx.org.slug) {
    const taken = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(and(eq(schema.organization.slug, p.slug), ne(schema.organization.id, ctx.org.id)))
      .limit(1);
    if (taken.length) return badRequest("That booking link is already taken");
  }
  const [org] = await db.update(schema.organization).set(p).where(eq(schema.organization.id, ctx.org.id)).returning();
  return Response.json({ org: publicOrg(org) });
}
