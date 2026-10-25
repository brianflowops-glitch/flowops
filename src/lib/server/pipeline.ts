import "server-only";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { BookingEngine, freeSlots, localStamp } from "@/lib/booking/engine";
import type { Booking, BookingRequest, DayHours, EngineState, PipelineAgent, PipelineResult, RunOptions } from "@/lib/booking/types";
import type { WeekHours } from "@/lib/db/schema";
import { googleCalendarAdapter } from "./integrations/google";
import { notifierAdapter } from "./integrations/notify";

type Org = typeof schema.organization.$inferSelect;
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Source = "dashboard" | "assistant" | "public";

export function hoursFor(hours: WeekHours) {
  return (date: string): DayHours => {
    const [y, m, d] = date.split("-").map(Number);
    const dow = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
    return hours[String(dow) as keyof WeekHours] ?? null;
  };
}

/** Today's date (YYYY-MM-DD) and time in the org's zone. */
export function orgToday(org: Pick<Org, "timeZone">) {
  const s = localStamp(new Date(), org.timeZone);
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function rowToBooking(r: typeof schema.booking.$inferSelect): Booking {
  return {
    id: r.id,
    customer: r.customer,
    email: r.email,
    ...(r.phone ? { phone: r.phone } : {}),
    category: r.category,
    service: r.service,
    resource: r.resource,
    date: r.date,
    time: r.time,
    durationMin: r.durationMin,
    ...(r.notes ? { notes: r.notes } : {}),
    status: r.status,
    calendarEventId: r.calendarEventId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    history: r.history,
  };
}

async function loadWorkingSet(tx: Tx, org: Org, bookingId?: string) {
  const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
  const rows = await tx
    .select()
    .from(schema.booking)
    .where(
      and(
        eq(schema.booking.organizationId, org.id),
        bookingId
          ? or(and(eq(schema.booking.status, "confirmed"), gte(schema.booking.date, yesterday)), eq(schema.booking.id, bookingId))
          : and(eq(schema.booking.status, "confirmed"), gte(schema.booking.date, yesterday)),
      ),
    );
  return rows.map(rowToBooking);
}

export type PipelineCommand =
  | { action: "create"; req: BookingRequest }
  | { action: "reschedule"; bookingId: string; date: string; time: string }
  | { action: "cancel"; bookingId: string };

/**
 * Run the 6-agent pipeline server-side for one org, serialized per org with a
 * Postgres advisory lock (so two concurrent requests can't double-book), and persist
 * the booking + audit + notifications in the same transaction.
 */
export async function runPipeline(
  org: Org,
  cmd: PipelineCommand,
  ctx: { actor: string; source: Source; failAgent?: PipelineAgent },
): Promise<PipelineResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"flowops:org:" + org.id}))`);
    const bookings = await loadWorkingSet(tx, org, cmd.action === "create" ? undefined : cmd.bookingId);
    const engine = new BookingEngine({ bookings, audit: [], notifications: [] } satisfies EngineState);
    const opts: RunOptions = {
      hoursFor: hoursFor(org.hours),
      timeZone: org.timeZone,
      calendar: googleCalendarAdapter(org),
      notifier: notifierAdapter(),
      actor: ctx.actor,
      failAgent: ctx.failAgent,
    };
    const result =
      cmd.action === "create"
        ? await engine.create(cmd.req, opts)
        : cmd.action === "reschedule"
          ? await engine.reschedule(cmd.bookingId, cmd.date, cmd.time, opts)
          : await engine.cancel(cmd.bookingId, opts);
    const snap = engine.snapshot();

    if (result.ok && result.booking) {
      const b = result.booking;
      const values = {
        customer: b.customer,
        email: b.email,
        phone: b.phone ?? null,
        category: b.category,
        service: b.service,
        resource: b.resource,
        date: b.date,
        time: b.time,
        durationMin: b.durationMin,
        notes: b.notes ?? null,
        status: b.status,
        calendarEventId: b.calendarEventId,
        history: b.history,
        updatedAt: new Date(b.updatedAt),
      };
      if (cmd.action === "create") {
        await tx.insert(schema.booking).values({ id: b.id, organizationId: org.id, source: ctx.source, createdAt: new Date(b.createdAt), ...values });
      } else {
        await tx
          .update(schema.booking)
          .set(values)
          .where(and(eq(schema.booking.id, b.id), eq(schema.booking.organizationId, org.id)));
      }
    }
    if (snap.audit.length) {
      await tx.insert(schema.auditEntry).values(
        snap.audit.map((a) => ({
          id: a.id,
          organizationId: org.id,
          at: new Date(a.at),
          action: a.action,
          bookingId: a.bookingId,
          agent: a.agent,
          outcome: a.outcome,
          detail: a.detail,
          actor: a.actor ?? null,
        })),
      );
    }
    if (result.ok && snap.notifications.length) {
      await tx.insert(schema.notification).values(
        snap.notifications.map((n) => ({
          id: n.id,
          organizationId: org.id,
          at: new Date(n.at),
          bookingId: n.bookingId,
          recipient: n.recipient,
          channel: n.channel,
          subject: n.subject,
          deliveryStatus: n.deliveryStatus,
          detail: n.detail ?? null,
        })),
      );
    }
    return result;
  });
}

/** Free start times for a resource/date (org hours, conflicts, past). */
export async function availability(org: Org, q: { resource: string; date: string; durationMin: number }) {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(and(eq(schema.booking.organizationId, org.id), eq(schema.booking.status, "confirmed"), eq(schema.booking.date, q.date)));
  return freeSlots(rows.map(rowToBooking), q, new Date(), { hoursFor: hoursFor(org.hours), timeZone: org.timeZone });
}

export async function loadState(orgId: string, limit = 200): Promise<EngineState & { sources: Record<string, Source> }> {
  const db = getDb();
  const [bookings, audit, notifications] = await Promise.all([
    db.select().from(schema.booking).where(eq(schema.booking.organizationId, orgId)).orderBy(desc(schema.booking.createdAt)).limit(limit),
    db.select().from(schema.auditEntry).where(eq(schema.auditEntry.organizationId, orgId)).orderBy(desc(schema.auditEntry.at)).limit(limit),
    db.select().from(schema.notification).where(eq(schema.notification.organizationId, orgId)).orderBy(desc(schema.notification.at)).limit(limit),
  ]);
  return {
    bookings: bookings.map(rowToBooking),
    sources: Object.fromEntries(bookings.map((b) => [b.id, b.source])),
    audit: audit.map((a) => ({
      id: a.id,
      at: a.at.toISOString(),
      action: a.action as EngineState["audit"][number]["action"],
      bookingId: a.bookingId,
      agent: a.agent as PipelineAgent,
      outcome: a.outcome as EngineState["audit"][number]["outcome"],
      detail: a.detail,
      ...(a.actor ? { actor: a.actor } : {}),
    })),
    notifications: notifications.map((n) => ({
      id: n.id,
      at: n.at.toISOString(),
      bookingId: n.bookingId,
      recipient: n.recipient,
      channel: n.channel as EngineState["notifications"][number]["channel"],
      subject: n.subject,
      deliveryStatus: n.deliveryStatus as EngineState["notifications"][number]["deliveryStatus"],
      ...(n.detail ? { detail: n.detail } : {}),
    })),
  };
}

export async function listServices(orgId: string, activeOnly = false) {
  const db = getDb();
  const rows = await db.select().from(schema.service).where(eq(schema.service.organizationId, orgId)).orderBy(schema.service.sortOrder, schema.service.createdAt);
  return activeOnly ? rows.filter((s) => s.active) : rows;
}
