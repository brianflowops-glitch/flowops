import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scrubDetail } from "@/lib/server/integrations/retry";

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

const historyEntry = (action: string, detail: string) => sql`jsonb_build_array(jsonb_build_object('at', ${new Date().toISOString()}::text, 'action', ${action}::text, 'detail', ${detail}::text))`;

/**
 * STOP: mark the phone opted out and revoke sms_consent on every booking with that phone (all orgs share the
 * sender). sms_consent_at is kept as the original opt-in record; the revocation is appended to booking history.
 * START: clear the opt-out and restore consent only on upcoming confirmed bookings that were revoked by STOP.
 * Returns the number of bookings changed.
 */
export async function applySmsKeyword(tx: Tx, phone: string, keyword: "STOP" | "START"): Promise<number> {
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
      .where(and(eq(schema.booking.phone, phone), eq(schema.booking.smsConsent, true)))
      .returning({ id: schema.booking.id });
    return rows.length;
  }
  const rows = await tx
    .update(schema.booking)
    .set({
      smsConsent: true,
      smsConsentAt: new Date(),
      history: sql`${schema.booking.history} || ${historyEntry("sms_opt_in", "Customer replied START — texts re-enabled")}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.booking.phone, phone),
        eq(schema.booking.smsConsent, false),
        eq(schema.booking.status, "confirmed"),
        sql`${schema.booking.date} >= to_char(now(), 'YYYY-MM-DD')`,
        sql`${schema.booking.history} @> '[{"action":"sms_opt_out"}]'::jsonb`,
      ),
    )
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
