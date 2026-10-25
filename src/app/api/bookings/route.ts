import { requireApi } from "@/lib/server/context";
import { runPipeline } from "@/lib/server/pipeline";
import { badRequest, bookingAction, readJson } from "@/lib/server/validation";

export async function POST(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const parsed = bookingAction.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const { failAgent, ...cmd } = parsed.data;
  const result = await runPipeline(ctx.org, cmd, { actor: `user:${ctx.user.email}`, source: "dashboard", failAgent });
  return Response.json(result);
}
