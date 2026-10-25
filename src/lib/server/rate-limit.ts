import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ipAddress } from "@vercel/functions";
import { getDb } from "@/lib/db";

/**
 * Fixed-window rate limiter stored in the existing `rate_limit` table (shared with Better Auth;
 * our keys are prefixed `flowops:` so they never collide). One atomic upsert per check.
 * Fails open (allows) if the database errors, so a limiter hiccup never takes the app down.
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
    console.error("rateLimit failed (allowing request)", e);
    return { ok: true, retryAfter: 0 };
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
