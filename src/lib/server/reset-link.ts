import "server-only";
import { randomBytes } from "node:crypto";
import { getAuth } from "@/lib/auth";
import { appBaseUrl } from "@/lib/tenancy/invites";

/** Admin-generated reset links last longer than emailed ones (shared by hand). */
export const ADMIN_RESET_TTL_HOURS = 24;

/**
 * Create a one-time Better Auth password-reset token for `userId` (same storage format as
 * /request-password-reset, so /reset-password consumes it and it can't be reused).
 * The link is returned only to the Owner/Admin who asked — never logged or emailed here.
 */
export async function createAdminResetLink(userId: string, req?: Request) {
  const ctx = await getAuth().$context;
  const token = randomBytes(18).toString("base64url"); // 24 chars, like Better Auth's own tokens
  const expiresAt = new Date(Date.now() + ADMIN_RESET_TTL_HOURS * 3600 * 1000);
  await ctx.internalAdapter.createVerificationValue({ value: userId, identifier: `reset-password:${token}`, expiresAt });
  return { link: `${appBaseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`, expiresAt };
}
