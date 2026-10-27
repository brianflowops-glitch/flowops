import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { resendConfigured, sendEmail } from "@/lib/server/integrations/notify";
import { type ReminderConfig, decideReminder, formatStart, reminderConfig, reminderEmail, reminderKey, startsAtInZone } from "./reminders";

/**
 * Email-only appointment reminders. Called from the cron route /api/cron/notifications after the recovery sweeper.
 * OFF unless EMAIL_REMINDERS_ENABLED=true (and Resend is configured): with the flag off this returns immediately
 * and never touches the database. No SMS code path exists here.
 *
 * Exactly-once, in three steps:
 *  1. Enqueue — for every due booking, INSERT a `notification` row (channel "email", status "sending") with
 *     dedupe_key `reminder-<bookingId>-<startsAtISO>` … ON CONFLICT DO NOTHING (unique partial index, migration 0008).
 *     A second run, or an overlapping run, inserts nothing. A rescheduled booking has a new start instant, hence a new
 *     key and a fresh reminder; the old key's row is never sent again (step 3 re-checks the booking).
 *  2. Claim — one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING sets claimed_at (10-min lease) and
 *     bumps sweep_attempts (max 3), the same pattern as notification-sweeper.ts, so two runs never send the same row.
 *  3. Send — re-read the booking; skip (status "skipped") if it was cancelled, rescheduled, re-addressed, or has
 *     started. Otherwise send with Resend Idempotency-Key = dedupe key, so a retry after a crash between "Resend
 *     accepted" and "row marked sent" is deduped by Resend (24 h) rather than emailed twice.
 * Rows use status "sending", never "queued", so notification-sweeper.ts (which only touches "queued") ignores them.
 */
export interface ReminderReport {
  enabled: boolean;
  note?: string;
  candidates: number;
  enqueued: number;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  expired: number;
}

export interface ReminderRunOptions {
  now?: Date;
  config?: ReminderConfig;
  leaseMs?: number; // default 10 min
  maxAttempts?: number; // default 3
  maxAgeMs?: number; // default 6 h: a "sending" row older than this is expired, not retried (stays inside Resend's 24 h idempotency window)
  budgetMs?: number; // default 40 s of sending per run (route maxDuration is 60 s)
  limit?: number; // default 100 rows enqueued per run
}

const empty = (enabled: boolean, note?: string): ReminderReport => ({ enabled, note, candidates: 0, enqueued: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, expired: 0 });

export async function runEmailReminders(opts: ReminderRunOptions = {}): Promise<ReminderReport> {
  const cfg = opts.config ?? reminderConfig();
  if (!cfg.enabled) return empty(false);
  if (!resendConfigured()) return empty(true, "email not configured");
  const now = opts.now ?? new Date();
  const leaseSec = Math.round((opts.leaseMs ?? 10 * 60_000) / 1000);
  const maxAgeSec = Math.round((opts.maxAgeMs ?? 6 * 3_600_000) / 1000);
  const maxAttempts = opts.maxAttempts ?? 3;
  const budgetMs = opts.budgetMs ?? 40_000;
  const limit = opts.limit ?? 100;
  const db = getDb();
  const n = schema.notification;
  const report = empty(true);

  // 1. Enqueue. Coarse SQL prefilter on the stored org-local date (zones differ from UTC by < 1 day, plus a day of slack);
  // the exact decision is made per booking in its own time zone. Demo organizations (fake customers) are excluded.
  const from = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + cfg.leadMs + 2 * 86_400_000).toISOString().slice(0, 10);
  const candidates = await db
    .select({ b: schema.booking, timeZone: schema.organization.timeZone, orgName: schema.organization.name })
    .from(schema.booking)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.booking.organizationId))
    .where(
      and(
        eq(schema.booking.status, "confirmed"),
        eq(schema.organization.isDemo, false),
        ne(schema.booking.email, ""),
        gte(schema.booking.date, from),
        lte(schema.booking.date, to),
      ),
    )
    .orderBy(schema.booking.date, schema.booking.time)
    .limit(1000);
  report.candidates = candidates.length;
  for (const c of candidates) {
    if (report.enqueued >= limit) break;
    const d = decideReminder(c.b, c.timeZone, now, cfg);
    if (!d.send) continue;
    const { subject } = reminderEmail(c.b, c.orgName, formatStart(d.startsAt, c.timeZone));
    const inserted = await db
      .insert(n)
      .values({
        id: `RM-${randomUUID()}`,
        organizationId: c.b.organizationId,
        at: now,
        bookingId: c.b.id,
        recipient: c.b.email.trim(),
        channel: "email",
        subject,
        deliveryStatus: "sending",
        detail: "appointment reminder",
        dedupeKey: d.key,
      })
      .onConflictDoNothing()
      .returning({ id: n.id });
    report.enqueued += inserted.length;
  }

  // 2a. Give up on reminder rows that are too old or used all their attempts and whose lease expired.
  const expired = await db
    .update(n)
    .set({ deliveryStatus: "failed", detail: sql`left(coalesce(${n.detail}, '') || ' · not sent: expired', 300)` })
    .where(
      and(
        eq(n.deliveryStatus, "sending"),
        sql`${n.dedupeKey} like 'reminder-%'`,
        sql`(${n.at} < now() - make_interval(secs => ${maxAgeSec})
             or (${n.sweepAttempts} >= ${maxAttempts} and ${n.claimedAt} < now() - make_interval(secs => ${leaseSec})))`,
      ),
    )
    .returning({ id: n.id });
  report.expired = expired.length;

  // 2b + 3. Claim small batches and send until none are left or the time budget is spent.
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const claimed = (
      await db.execute<{ id: string }>(sql`
        update notification set claimed_at = now(), sweep_attempts = sweep_attempts + 1
        where id in (
          select id from notification
          where delivery_status = 'sending'
            and dedupe_key like 'reminder-%'
            and at >= now() - make_interval(secs => ${maxAgeSec})
            and sweep_attempts < ${maxAttempts}
            and (claimed_at is null or claimed_at < now() - make_interval(secs => ${leaseSec}))
          order by at
          limit 5
          for update skip locked
        )
        returning id`)
    ).rows.map((r) => r.id);
    if (!claimed.length) break;
    report.claimed += claimed.length;
    for (const id of claimed) {
      const out = await sendOne(id, now);
      report[out.kind]++;
    }
  }
  return report;
}

async function sendOne(id: string, now: Date): Promise<{ kind: "sent" | "failed" | "skipped" }> {
  const db = getDb();
  const n = schema.notification;
  const finish = async (status: "sent" | "failed" | "skipped", detail: string) => {
    // Only finalize rows that are still ours and still "sending".
    await db.update(n).set({ deliveryStatus: status, detail: detail.slice(0, 300) }).where(and(eq(n.id, id), eq(n.deliveryStatus, "sending")));
    return { kind: status };
  };
  const [row] = await db.select().from(n).where(eq(n.id, id)).limit(1);
  if (!row?.dedupeKey) return finish("skipped", "not sent: row vanished");
  const [r] = await db
    .select({ b: schema.booking, timeZone: schema.organization.timeZone, orgName: schema.organization.name })
    .from(schema.booking)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.booking.organizationId))
    .where(and(eq(schema.booking.id, row.bookingId), eq(schema.booking.organizationId, row.organizationId)))
    .limit(1);
  if (!r) return finish("skipped", "not sent: booking no longer exists");
  if (r.b.status !== "confirmed") return finish("skipped", "not sent: booking is cancelled");
  const startsAt = startsAtInZone(r.b.date, r.b.time, r.timeZone);
  // Rescheduled since this row was enqueued: the key embeds the old start, so the old reminder must never go out.
  if (!startsAt || reminderKey(r.b.id, startsAt) !== row.dedupeKey) return finish("skipped", "not sent: booking was rescheduled");
  if (startsAt.getTime() <= now.getTime()) return finish("skipped", "not sent: appointment already started");
  if (r.b.email.trim() !== row.recipient) return finish("skipped", "not sent: customer email changed");
  const msg = reminderEmail(r.b, r.orgName, formatStart(startsAt, r.timeZone));
  const res = await sendEmail(row.recipient, msg.subject, msg.text, process.env.RESEND_REPLY_TO || undefined, {
    tag: `reminder:booking:${r.b.id}`,
    organizationId: row.organizationId,
    idempotencyKey: row.dedupeKey,
  });
  return res.ok ? finish("sent", res.detail ?? "sent") : finish("failed", res.detail ?? "failed");
}
