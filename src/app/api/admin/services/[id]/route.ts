import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { badRequest, readJson, serviceUpdate } from "@/lib/server/validation";
import { servicePaymentError } from "@/lib/payments/rules";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const parsed = serviceUpdate.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  if (Object.keys(parsed.data).length === 0) return Response.json({ error: "No fields to update" }, { status: 400 });
  const payKeys = ["priceCents", "paymentMode", "depositCents", "depositPercent"] as const;
  if (payKeys.some((k) => k in parsed.data)) {
    // Validate the payment settings as they will be after this update.
    const [cur] = await getDb()
      .select()
      .from(schema.service)
      .where(and(eq(schema.service.id, id), eq(schema.service.organizationId, ctx.org.id)))
      .limit(1);
    if (!cur) return Response.json({ error: "Service not found" }, { status: 404 });
    const payErr = servicePaymentError({ ...cur, ...parsed.data });
    if (payErr) return badRequest(payErr);
  }
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
