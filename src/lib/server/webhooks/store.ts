import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { phoneE164Sql } from "@/lib/db/phone-sql";
import { scrubDetail } from "@/lib/server/integrations/retry";
import { isUpcomingInZone, startPrefilterDate } from "./upcoming";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Process a webhook exactly once. Inside one transaction: claim (provider, eventKey) in provider_webhook_event
 * (unique index), then run `fn`. A replay finds the key taken and returns { duplicate: true } without running `fn`;
 * if `fn` throws, the claim rolls back too so the provider's retry is processed.
 */
export async function onceForEvent<T>(provider: "twilio" | "resend", eventKey: string, eventType: string, fn: (tx: Tx) => Promise<T>) {
  return getDb().transaction(async (tx) => {
    const claimed = await tx
      .insert(schema.providerWebhookEvent)
      .values({ id: `WH-${randomUUID()}`, provider, eventKey: eventKey.slice(0, 200), eventType: eventType.slice(0, 60) })
      .onConflictDoNothing()
      .returning({ id: schema.providerWebhookEvent.id });
    if (!claimed.length) return { duplicate: true as const };
    return { duplicate: false as const, result: await fn(tx) };
  });
}

export async function recordDeliveryEvent(
  tx: Tx,
  e: { provider: "twilio" | "resend"; messageId: string; status: string; errorCode?: string | null; detail?: string | null; occurredAt?: Date | null },
) {
  await tx.insert(schema.messageDeliveryEvent).values({
    id: `DE-${randomUUID()}`,
    provider: e.provider,
    messageId: e.messageId.slice(0, 120),
    status: e.status.slice(0, 60),
    errorCode: e.errorCode ? e.errorCode.slice(0, 20) : null,
    detail: e.detail ? scrubDetail(e.detail) : null,
    occurredAt: e.occurredAt && !Number.isNaN(e.occurredAt.getTime()) ? e.occurredAt : null,
  });
}

export { phoneE164Sql };

const historyEntry = (action: string, detail: string, at = new Date()) => sql`jsonb_build_array(jsonb_build_object('at', ${at.toISOString()}::text, 'action', ${action}::text, 'detail', ${detail}::text))`;

/**
 * `phone` must be E.164 (toE164 of Twilio's From); bookings are matched on their normalized phone (phoneE164Sql).
 * STOP: mark the phone opted out and revoke sms_consent on every booking with that phone (all orgs share the
 * sender). sms_consent_at is kept as the original opt-in record; the revocation is appended to booking history.
 * START: clear the opt-out and restore consent only on confirmed bookings that were revoked by STOP and are still
 * upcoming in their business's own time zone (organization.time_zone). `now` is injectable for tests.
 * Returns the number of bookings changed.
 */
export async function applySmsKeyword(tx: Tx, phone: string, keyword: "STOP" | "START", now: Date = new Date()): Promise<number> {
  await tx
    .insert(schema.smsOptOut)
    .values({ phone, optedOut: keyword === "STOP", keyword })
    .onConflictDoUpdate({ target: schema.smsOptOut.phone, set: { optedOut: keyword === "STOP", keyword, updatedAt: new Date() } });
  if (keyword === "STOP") {
    const rows = await tx
      .update(schema.booking)
      .set({
        smsConsent: false,
        history: sql`${schema.booking.history} || ${historyEntry("sms_opt_out", "Customer replied STOP — texts disabled")}`,
        updatedAt: new Date(),
      })
      .where(and(sql`${phoneE164Sql(schema.booking.phone)} = ${phone}`, eq(schema.booking.smsConsent, true)))
      .returning({ id: schema.booking.id });
    return rows.length;
  }
  // START: find STOP-revoked confirmed bookings for this phone, then keep only those still upcoming in their own
  // business's time zone (bookings store date + time as org-local wall clock). The SQL date bound is a coarse
  // prefilter only: no zone is more than a day behind UTC, so nothing upcoming anywhere is excluded by it.
  const candidates = await tx
    .select({ id: schema.booking.id, date: schema.booking.date, time: schema.booking.time, timeZone: schema.organization.timeZone })
    .from(schema.booking)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.booking.organizationId))
    .where(
      and(
        sql`${phoneE164Sql(schema.booking.phone)} = ${phone}`,
        eq(schema.booking.smsConsent, false),
        eq(schema.booking.status, "confirmed"),
        gte(schema.booking.date, startPrefilterDate(now)),
        sql`${schema.booking.history} @> '[{"action":"sms_opt_out"}]'::jsonb`,
      ),
    );
  const ids = candidates.filter((b) => isUpcomingInZone(b.date, b.time, b.timeZone, now)).map((b) => b.id);
  if (!ids.length) return 0;
  const rows = await tx
    .update(schema.booking)
    .set({
      smsConsent: true,
      smsConsentAt: now,
      history: sql`${schema.booking.history} || ${historyEntry("sms_opt_in", "Customer replied START — texts re-enabled", now)}`,
      updatedAt: now,
    })
    .where(and(inArray(schema.booking.id, ids), eq(schema.booking.smsConsent, false), eq(schema.booking.status, "confirmed")))
    .returning({ id: schema.booking.id });
  return rows.length;
}

/** True when the phone has replied STOP (and not START since). Fails open (false) on DB errors — Twilio still blocks opted-out numbers (21610). */
export async function isSmsOptedOut(phone: string): Promise<boolean> {
  try {
    const [row] = await getDb().select({ o: schema.smsOptOut.optedOut }).from(schema.smsOptOut).where(eq(schema.smsOptOut.phone, phone)).limit(1);
    return !!row?.o;
  } catch {
    return false;
  }
}

/** Public URL Twilio signed. Set TWILIO_WEBHOOK_BASE_URL (e.g. https://flowopsagent.ai) if a proxy rewrites the host. */
export function publicRequestUrl(req: Request) {
  const u = new URL(req.url);
  const base = process.env.TWILIO_WEBHOOK_BASE_URL?.trim().replace(/\/+$/, "");
  if (base) return `${base}${u.pathname}${u.search}`;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return host ? `${proto}://${host}${u.pathname}${u.search}` : req.url;
}
