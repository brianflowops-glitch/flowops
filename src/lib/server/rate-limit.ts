import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ipAddress } from "@vercel/functions";
import { getDb } from "@/lib/db";
import { sendOpsAlertText } from "@/lib/server/integrations/notification-failures";
import { MemoryRateLimiter } from "./rate-limit-memory";

const fallback = new MemoryRateLimiter();

/**
 * Fixed-window rate limiter stored in the existing `rate_limit` table (shared with Better Auth;
 * our keys are prefixed `flowops:` so they never collide). One atomic upsert per check.
 * If the database errors, falls back to a per-instance in-memory limiter with the same limits (previously it
 * failed open and allowed everything), and fires a throttled ops alert so the outage isn't silent.
 * Covers every caller: public booking (book:*), availability (avail:*) and FlowAI (ai:user:*, ai:org:*).
 * Sign-in/sign-up limits are Better Auth's own (auth.ts) and are not affected.
 */
export async function rateLimit(key: string, max: number, windowSec: number): Promise<{ ok: boolean; retryAfter: number }> {
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  try {
    const res = await getDb().execute<{ count: number; last_request: string | number }>(sql`
      insert into rate_limit (id, key, count, last_request)
      values (${randomUUID()}, ${`flowops:${key}`}, 1, ${now})
      on conflict (key) do update set
        count = case when rate_limit.last_request < ${windowStart} then 1 else rate_limit.count + 1 end,
        last_request = case when rate_limit.last_request < ${windowStart} then ${now} else rate_limit.last_request end
      returning count, last_request`);
    const row = res.rows[0];
    if (!row) return { ok: true, retryAfter: 0 };
    const started = Number(row.last_request);
    const retryAfter = Math.max(1, Math.ceil((started + windowSec * 1000 - now) / 1000));
    return { ok: Number(row.count) <= max, retryAfter };
  } catch (e) {
    console.error(`rateLimit database error — using in-memory fallback (${e instanceof Error ? e.message.slice(0, 120) : "unknown error"})`);
    sendOpsAlertText(
      "rate_limit_db_error",
      "Rate limiter database error",
      "FlowOps alert: rate limiter could not reach the database; using the per-instance in-memory fallback.",
    ).catch(() => {});
    return fallback.check(`flowops:${key}`, max, windowSec, now);
  }
}

/** Best-effort client IP (Vercel sets x-vercel-forwarded-for / x-real-ip). */
export function clientIp(req: Request) {
  return (
    ipAddress(req) ||
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function tooManyRequests(message: string, retryAfter: number) {
  return Response.json({ error: message, retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}
