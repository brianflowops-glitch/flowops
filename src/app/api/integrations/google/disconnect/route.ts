import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";

export async function POST(req: Request) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  await getDb()
    .update(schema.organization)
    .set({ googleRefreshTokenEnc: null, googleAccountEmail: null })
    .where(eq(schema.organization.id, ctx.org.id));
  return Response.json({ ok: true });
}
