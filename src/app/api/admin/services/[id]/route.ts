import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson, serviceUpdate } from "@/lib/server/validation";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const parsed = serviceUpdate.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  if (Object.keys(parsed.data).length === 0) return Response.json({ error: "No fields to update" }, { status: 400 });
  const [svc] = await getDb()
    .update(schema.service)
    .set(parsed.data)
    .where(and(eq(schema.service.id, id), eq(schema.service.organizationId, ctx.org.id)))
    .returning();
  if (!svc) return Response.json({ error: "Service not found" }, { status: 404 });
  return Response.json({ service: svc });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  await getDb().delete(schema.service).where(and(eq(schema.service.id, id), eq(schema.service.organizationId, ctx.org.id)));
  return Response.json({ ok: true });
}
