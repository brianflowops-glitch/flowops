import { hasDatabase } from "@/lib/db";
import { findInviteByToken, inviteStatus } from "@/lib/tenancy/invites";

/** Public: what an invite link is for. The raw token is the secret, so the invitee's email is shown. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!hasDatabase()) return Response.json({ error: "Database not configured" }, { status: 503 });
  const { token } = await params;
  const row = await findInviteByToken(token);
  if (!row) return Response.json({ status: "invalid" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const status = inviteStatus(row.invite);
  return Response.json(
    { status, orgName: row.orgName, role: row.invite.role, email: status === "pending" ? row.invite.email : undefined, expiresAt: row.invite.expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
