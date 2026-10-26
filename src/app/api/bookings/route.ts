import { requireApi } from "@/lib/server/context";
import { canInjectFaults } from "@/lib/server/fault-injection";
import { runPipeline } from "@/lib/server/pipeline";
import { badRequest, bookingAction, readJson } from "@/lib/server/validation";

export async function POST(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const parsed = bookingAction.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error);
  const { failAgent, ...cmd } = parsed.data;
  // Refuse (rather than silently ignore) so a "test failure" request never runs for real.
  if (failAgent && !canInjectFaults(ctx.role))
    return Response.json({ error: "Fault injection is disabled here (test environments only, Owner/Admin)" }, { status: 403 });
  const result = await runPipeline(ctx.org, cmd, { actor: `user:${ctx.user.email}`, source: "dashboard", failAgent });
  return Response.json(result);
}
