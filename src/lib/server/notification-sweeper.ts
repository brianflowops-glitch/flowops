import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { maskPhone } from "@/lib/phone";
import { recordNotificationFailure } from "@/lib/server/integrations/notification-failures";
import { maskEmail } from "@/lib/server/integrations/retry";
import { resendConfigured, sendEmail, sendSms, smsBody, twilioConfigured } from "@/lib/server/integrations/notify";

/**
 * Recovery for notification rows stuck in "queued" (PR #3 writes them in the booking transaction and sends right
 * after commit; if the function dies in between, the row stays queued). Run by the cron route
 * /api/cron/notifications. Ownership: the pipeline does the first send; this only touches rows that are still
 * "queued" after `staleAfterMs`.
 *
 * Exactly-once claim: one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING sets claimed_at and
 * bumps sweep_attempts, so overlapping runs never claim the same row. A claim is a lease (`leaseMs`): if a run
 * dies mid-send, the row can be re-claimed after the lease, at most `maxSweeps` times in total.
 * Email re-sends use Resend Idempotency-Key `notification-<row id>` (deduped for 24 h). SMS has no provider-side
 * idempotency, so an SMS re-send after a crash *between* Twilio accepting and the row update could duplicate;
 * `maxSweeps` bounds that.
 */
export interface SweepOptions {
  staleAfterMs?: number; // default 5 min
  maxAgeMs?: number; // default 24 h — older queued rows are expired, not sent (stale appointment info)
  leaseMs?: number; // default 10 min
  maxSweeps?: number; // default 3
  limit?: number; // default 25 per run
}

export interface SweepReport {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  expired: number;
}

type Row = typeof schema.notification.$inferSelect;

/** Same template as the engine's Notification Agent (src/lib/booking/engine.ts). Keep in sync. */
export function emailBodyFor(b: { customer: string; id: string; resource?: string | null }, subject: string) {
  return `Hi ${b.customer},\n\n${subject}.\nReference: ${b.id}${b.resource ? ` · ${b.resource}` : ""}\n\n— Sent by FLOWOPS`;
}

export async function sweepQueuedNotifications(opts: SweepOptions = {}): Promise<SweepReport> {
  const staleSec = Math.round((opts.staleAfterMs ?? 5 * 60_000) / 1000);
  const maxAgeSec = Math.round((opts.maxAgeMs ?? 24 * 3_600_000) / 1000);
  const leaseSec = Math.round((opts.leaseMs ?? 10 * 60_000) / 1000);
  const maxSweeps = opts.maxSweeps ?? 3;
  const limit = opts.limit ?? 25;
  const db = getDb();
  const report: SweepReport = { claimed: 0, sent: 0, failed: 0, skipped: 0, expired: 0 };
  const n = schema.notification;

  // 1. Give up on rows that are too old, or that used all their sweeps and whose last lease expired.
  const expired = await db
    .update(n)
    .set({ deliveryStatus: "failed", detail: sql`left(coalesce(${n.detail}, '') || ' · not sent: expired in queue', 300)` })
    .where(
      and(
        eq(n.deliveryStatus, "queued"),
        sql`(${n.at} < now() - make_interval(secs => ${maxAgeSec})
             or (${n.sweepAttempts} >= ${maxSweeps} and ${n.claimedAt} < now() - make_interval(secs => ${leaseSec})))`,
      ),
    )
    .returning();
  for (const r of expired) {
    report.expired++;
    await recordNotificationFailure({
      channel: r.channel === "sms" ? "sms" : "email",
      tag: `sweeper:booking:${r.bookingId}`,
      organizationId: r.organizationId,
      target: r.channel === "sms" ? maskPhone(r.recipient) : maskEmail(r.recipient),
      failureKind: "transient_exhausted",
      detail: `queued notification expired after ${r.sweepAttempts} sweep attempt(s)`,
      attempts: r.sweepAttempts,
    });
  }

  // 2. Atomically claim a batch of stale queued rows.
  const claimed = (
    await db.execute<{ id: string }>(sql`
      update notification set claimed_at = now(), sweep_attempts = sweep_attempts + 1
      where id in (
        select id from notification
        where delivery_status = 'queued'
          and at < now() - make_interval(secs => ${staleSec})
          and at >= now() - make_interval(secs => ${maxAgeSec})
          and sweep_attempts < ${maxSweeps}
          and (claimed_at is null or claimed_at < now() - make_interval(secs => ${leaseSec}))
        order by at
        limit ${limit}
        for update skip locked
      )
      returning id`)
  ).rows.map((r) => r.id);
  report.claimed = claimed.length;
  if (!claimed.length) return report;

  const rows = await db.select().from(n).where(inArray(n.id, claimed));
  for (const row of rows) {
    const outcome = await resend(row);
    // Only finalize if still ours and still queued (PR #3's first send may have finished meanwhile).
    await db
      .update(n)
      .set({ deliveryStatus: outcome.status, detail: outcome.detail.slice(0, 300) })
      .where(and(eq(n.id, row.id), eq(n.deliveryStatus, "queued")));
    report[outcome.status === "sent" ? "sent" : outcome.kind === "skipped" ? "skipped" : "failed"]++;
  }
  return report;
}

async function resend(row: Row): Promise<{ status: "sent" | "failed"; kind: "sent" | "failed" | "skipped"; detail: string }> {
  const db = getDb();
  const skip = (why: string) => ({ status: "failed" as const, kind: "skipped" as const, detail: `not sent by recovery: ${why}` });
  const channel = row.channel === "sms" ? "sms" : row.channel === "email" ? "email" : null;
  if (!channel) return skip(`unsupported channel ${row.channel}`);

  const [b] = await db
    .select()
    .from(schema.booking)
    .where(and(eq(schema.booking.id, row.bookingId), eq(schema.booking.organizationId, row.organizationId)))
    .limit(1);
  if (!b) return skip("booking no longer exists");

  // A newer notification for the same booking + channel supersedes this one (e.g. rescheduled or cancelled since).
  const [newer] = await db
    .select({ id: schema.notification.id })
    .from(schema.notification)
    .where(
      and(
        eq(schema.notification.bookingId, row.bookingId),
        eq(schema.notification.organizationId, row.organizationId),
        eq(schema.notification.channel, row.channel),
        ne(schema.notification.id, row.id),
        // Compare in SQL: JS Dates are ms-precision, Postgres timestamps are µs-precision.
        sql`${schema.notification.at} > (select at from notification where id = ${row.id})`,
      ),
    )
    .limit(1);
  if (newer) return skip("superseded by a newer notification");

  const meta = { tag: `sweeper:booking:${b.id}`, organizationId: row.organizationId, idempotencyKey: `notification-${row.id}` };
  if (channel === "email") {
    if (!resendConfigured()) return skip("email not configured");
    const r = await sendEmail(row.recipient, row.subject, emailBodyFor(b, row.subject), process.env.RESEND_REPLY_TO || undefined, meta);
    return r.ok ? { status: "sent", kind: "sent", detail: `${r.detail ?? "sent"} (recovered)` } : { status: "failed", kind: "failed", detail: r.detail ?? "failed" };
  }
  if (!twilioConfigured()) return skip("SMS not configured");
  if (!b.smsConsent || !b.phone) return skip("customer no longer opted in to texts");
  const [org] = await db.select({ name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, row.organizationId)).limit(1);
  const text = smsBody(row.subject, b, org?.name);
  if (!text) return skip("no approved SMS template for this message");
  const r = await sendSms(b.phone, text, b.id, meta);
  return r.ok ? { status: "sent", kind: "sent", detail: `${r.detail ?? "sent"} (recovered)` } : { status: "failed", kind: "failed", detail: r.detail ?? "failed" };
}
