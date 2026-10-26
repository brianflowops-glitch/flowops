import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

export const INVITE_TTL_DAYS = 7;
export const INVITE_ROLES = ["admin", "staff"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];
export type InviteRow = typeof schema.teamInvite.$inferSelect;
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

/** 256-bit random token (base64url). Only its SHA-256 hash is stored. */
export function newInviteToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}
export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function inviteExpiry(from = new Date()) {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 24 * 3600 * 1000);
}

export function inviteStatus(i: Pick<InviteRow, "acceptedAt" | "revokedAt" | "expiresAt">, now = new Date()): InviteStatus {
  if (i.acceptedAt) return "accepted";
  if (i.revokedAt) return "revoked";
  if (i.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** Public base URL for links (BETTER_AUTH_URL, else the request origin). */
export function appBaseUrl(req?: Request) {
  const env = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  return req ? new URL(req.url).origin : "http://localhost:3000";
}
export function inviteLink(token: string, req?: Request) {
  return `${appBaseUrl(req)}/invite/${token}`;
}

/** Look up an invite by raw token (any status), with its org name. */
export async function findInviteByToken(token: string) {
  if (!token || token.length < 20 || token.length > 100) return null;
  const [row] = await getDb()
    .select({ invite: schema.teamInvite, orgName: schema.organization.name })
    .from(schema.teamInvite)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.teamInvite.organizationId))
    .where(eq(schema.teamInvite.tokenHash, hashInviteToken(token)))
    .limit(1);
  return row ?? null;
}

/** Pending (not used/revoked/expired) invite for this token + email, or null. */
export async function findUsableInvite(token: string, email: string) {
  const row = await findInviteByToken(token);
  if (!row || inviteStatus(row.invite) !== "pending") return null;
  if (row.invite.email !== email.trim().toLowerCase()) return null;
  return row;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Atomically mark the invite used by `userId`. Returns the invite, or null if it is
 * unknown, for another email, already used, revoked or expired (single-use guarantee).
 */
export async function consumeInvite(tx: Tx, token: string, email: string, userId: string) {
  const [row] = await tx
    .update(schema.teamInvite)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(
      and(
        eq(schema.teamInvite.tokenHash, hashInviteToken(token)),
        eq(schema.teamInvite.email, email.trim().toLowerCase()),
        isNull(schema.teamInvite.acceptedAt),
        isNull(schema.teamInvite.revokedAt),
        gt(schema.teamInvite.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return row ?? null;
}
