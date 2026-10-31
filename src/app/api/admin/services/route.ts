import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { listServices } from "@/lib/server/pipeline";
import { badRequest, readJson, serviceInput } from "@/lib/server/validation";
import { servicePaymentError } from "@/lib/payments/rules";

export async function GET(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  return Response.json({ services: await listServices(ctx.org.id) });
}

export async function POST(req: Request) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const parsed = serviceInput.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const payErr = servicePaymentError(parsed.data);
  if (payErr) return badRequest(payErr);
  const [svc] = await getDb()
    .insert(schema.service)
    .values({ id: `svc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, organizationId: ctx.org.id, ...parsed.data })
    .returning();
  return Response.json({ service: svc });
}
