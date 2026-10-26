import { getAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { unauthorized } from "@/lib/server/context";
import { InviteJoinError, joinOrgWithInvite } from "@/lib/tenancy/membership";

/** A signed-in user (whose email matches the invite) joins the inviting org with the invite's role. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!hasDatabase()) return Response.json({ error: "Database not configured" }, { status: 503 });
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session) return unauthorized();
  const { token } = await params;
  try {
    const m = await joinOrgWithInvite({ id: session.user.id, email: session.user.email }, token);
    return Response.json({ ok: true, role: m.role });
  } catch (e) {
    if (e instanceof InviteJoinError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
