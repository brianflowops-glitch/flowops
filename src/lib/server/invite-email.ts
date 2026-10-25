import "server-only";
import { sendAccountEmail } from "@/lib/server/integrations/notify";
import { INVITE_TTL_DAYS } from "@/lib/tenancy/invites";

export function sendInviteEmail(to: string, orgName: string, role: string, inviterName: string, link: string) {
  return sendAccountEmail(
    to,
    `You're invited to ${orgName} on FlowOps`,
    `Hi,\n\n${inviterName} invited you to join ${orgName} on FlowOps as ${role === "admin" ? "an Admin" : "Staff"}.\n\nAccept the invite (valid ${INVITE_TTL_DAYS} days, works once):\n${link}\n\n— FlowOps`,
  );
}
