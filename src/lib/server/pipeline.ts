import "server-only";
import { and, desc, eq, gt, gte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { BookingEngine, freeSlots, localStamp } from "@/lib/booking/engine";
import type { Booking, BookingRequest, CalendarAdapter, DayHours, EngineState, NotifierAdapter, PipelineAgent, PipelineResult, RunOptions } from "@/lib/booking/types";
import type { WeekHours } from "@/lib/db/schema";
import { googleCalendarAdapter } from "./integrations/google";
import { notifierAdapter } from "./integrations/notify";
import { bookingPaymentsEnabled } from "@/lib/payments/rules";

type Org = typeof schema.organization.$inferSelect;
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
export type PipelineTx = Tx;
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
    smsConsent: r.smsConsent,
    ...(r.smsConsentAt ? { smsConsentAt: r.smsConsentAt.toISOString() } : {}),
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

/**
 * Payments at booking: unexpired `pending` holds (a customer is in Checkout for that slot) block it like a confirmed
 * booking. Only queried when BOOKING_PAYMENTS_ENABLED=true, so with the flag off nothing here runs.
 */
type DbOrTx = Tx | ReturnType<typeof getDb>;
async function activeHolds(q: DbOrTx, orgId: string, where: { date?: string; fromDate?: string; excludeHoldId?: string }): Promise<Booking[]> {
  if (!bookingPaymentsEnabled()) return [];
  const h = schema.bookingHold;
  const rows = await q
    .select()
    .from(h)
    .where(
      and(
        eq(h.organizationId, orgId),
        eq(h.status, "pending"),
        gt(h.expiresAt, new Date()),
        where.date ? eq(h.date, where.date) : undefined,
        where.fromDate ? gte(h.date, where.fromDate) : undefined,
        where.excludeHoldId ? ne(h.id, where.excludeHoldId) : undefined,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    customer: "(payment pending)",
    email: "",
    category: "appointment",
    service: "(held for payment)",
    resource: r.resource,
    date: r.date,
    time: r.time,
    durationMin: r.durationMin,
    status: "confirmed",
    calendarEventId: null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    history: [],
  }));
}

async function loadWorkingSet(tx: Tx, org: Org, bookingId?: string, excludeHoldId?: string) {
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
  const holds = await activeHolds(tx, org.id, { fromDate: yesterday, excludeHoldId });
  return [...rows.map(rowToBooking), ...holds];
}

export type PipelineCommand =
  | { action: "create"; req: BookingRequest }
  | { action: "reschedule"; bookingId: string; date: string; time: string }
  | { action: "cancel"; bookingId: string };

/** Calendar ID placeholder used while the real calendar call is deferred until after commit. */
const PENDING_CAL = "PENDINGCAL";
const QUEUED = "queued: sends after the booking is saved";

/** External side effects captured during the transaction and run only after it commits. */
interface SideEffects {
  calendar?: { op: "create" } | { op: "update"; eventId: string } | { op: "remove"; eventId: string };
  sends: { subject: string; body: string; channel: "email" | "sms" }[];
}

/** Records the Calendar Agent's intent instead of calling Google inside the transaction. */
function deferredCalendar(real: CalendarAdapter, fx: SideEffects): CalendarAdapter {
  return {
    label: real.label,
    async create() {
      fx.calendar = { op: "create" };
      return PENDING_CAL;
    },
    async update(b) {
      if (!b.calendarEventId || b.calendarEventId === PENDING_CAL) {
        fx.calendar = { op: "create" };
        return PENDING_CAL;
      }
      fx.calendar = { op: "update", eventId: b.calendarEventId };
      return b.calendarEventId;
    },
    async remove(eventId) {
      // Engine compensation for an event this run "created": nothing real exists yet.
      if (eventId === PENDING_CAL) {
        if (fx.calendar?.op === "create") fx.calendar = undefined;
        return;
      }
      fx.calendar = { op: "remove", eventId };
    },
  };
}

/** Records the Notification Agent's sends instead of calling Resend/Twilio inside the transaction. */
function deferredNotifier(real: NotifierAdapter, fx: SideEffects): NotifierAdapter {
  return {
    channels: real.channels,
    async send(_b, subject, body, channel) {
      fx.sends.push({ subject, body, channel });
      return { ok: true, detail: QUEUED };
    },
  };
}

/**
 * Run the 6-agent pipeline server-side for one org, serialized per org with a
 * Postgres advisory lock (so two concurrent requests can't double-book), and persist
 * the booking + audit + notification records in one transaction.
 *
 * Email, SMS and Google Calendar calls are NOT made inside the transaction: they are
 * captured during the run and executed only after the commit succeeds, so a failed save
 * never notifies the customer and no DB connection is held during network calls.
 */
export async function runPipeline(
  org: Org,
  cmd: PipelineCommand,
  ctx: {
    actor: string;
    source: Source;
    failAgent?: PipelineAgent;
    /**
     * Payments at booking: confirming a paid hold. Its own hold is left out of the conflict check; `before` runs under
     * the org lock before anything else (throw to abort with nothing written); `after` runs in the same transaction
     * once the booking row is written (so the hold is marked paid atomically with the booking).
     */
    hold?: { id: string; before?: (tx: Tx) => Promise<void>; after?: (tx: Tx, booking: Booking) => Promise<void> };
  },
): Promise<PipelineResult> {
  const db = getDb();
  const realCalendar = googleCalendarAdapter(org);
  // organizationId lets failure logs/alerts carry the org. Built as a separate object so this
  // compiles both before and after the notifier adapter's options type gains organizationId.
  const notifierOpts = { businessName: org.name, organizationId: org.id };
  const realNotifier = notifierAdapter(notifierOpts);
  const fx: SideEffects = { sends: [] };
  const queuedIds: { id: string; channel: "email" | "sms" }[] = [];

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"flowops:org:" + org.id}))`);
    if (ctx.hold?.before) await ctx.hold.before(tx);
    const bookings = await loadWorkingSet(tx, org, cmd.action === "create" ? undefined : cmd.bookingId, ctx.hold?.id);
    const engine = new BookingEngine({ bookings, audit: [], notifications: [] } satisfies EngineState);
    const opts: RunOptions = {
      hoursFor: hoursFor(org.hours),
      timeZone: org.timeZone,
      calendar: realCalendar ? deferredCalendar(realCalendar, fx) : undefined,
      notifier: realNotifier ? deferredNotifier(realNotifier, fx) : undefined,
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
        smsConsent: !!b.smsConsent,
        smsConsentAt: b.smsConsentAt ? new Date(b.smsConsentAt) : null,
        category: b.category,
        service: b.service,
        resource: b.resource,
        date: b.date,
        time: b.time,
        durationMin: b.durationMin,
        notes: b.notes ?? null,
        status: b.status,
        // The real event ID is written after commit, once the calendar call succeeds.
        calendarEventId: b.calendarEventId === PENDING_CAL ? null : b.calendarEventId,
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
      if (ctx.hold?.after) await ctx.hold.after(tx, b);
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
        snap.notifications.map((n) => {
          const queued = n.detail === QUEUED && (n.channel === "email" || n.channel === "sms");
          if (queued) queuedIds.push({ id: n.id, channel: n.channel as "email" | "sms" });
          return {
            id: n.id,
            organizationId: org.id,
            at: new Date(n.at),
            bookingId: n.bookingId,
            recipient: n.recipient,
            channel: n.channel,
            subject: n.subject,
            deliveryStatus: queued ? "queued" : n.deliveryStatus,
            detail: n.detail ?? null,
          };
        }),
      );
    }
    return result;
  });

  // Transaction committed (or the run failed and nothing was saved). Only now touch the outside world.
  if (!result.ok || !result.booking) return result;
  await runSideEffects(org, result, fx, queuedIds, realCalendar, realNotifier, ctx.actor);
  return result;
}

/**
 * Executes deferred calendar + notification calls after commit and records their real outcome. Never throws.
 *
 * Known limits (tracked for follow-up):
 * - These calls run OUTSIDE the per-org advisory lock. Two quick reschedules of the same
 *   booking can therefore reach the calendar provider out of order. Rare; if it matters,
 *   re-read the booking's latest state before each calendar write.
 * - If the process dies after commit but before this finishes, notification rows stay at
 *   status "queued". The notification retry worker (Agent's retry work) owns picking up
 *   stale "queued" rows; this function only moves rows it created from queued to sent/failed.
 */
async function runSideEffects(
  org: Org,
  result: PipelineResult,
  fx: SideEffects,
  queuedIds: { id: string; channel: "email" | "sms" }[],
  calendar: CalendarAdapter | undefined,
  notifier: NotifierAdapter | undefined,
  actor: string,
) {
  const db = getDb();
  const b = result.booking as Booking;
  const warnings: string[] = [];
  const step = (agent: PipelineAgent) => result.steps.find((s) => s.agent === agent);

  if (calendar && fx.calendar) {
    const c = fx.calendar;
    try {
      let eventId: string | null = b.calendarEventId;
      if (c.op === "create") eventId = await calendar.create(b);
      else if (c.op === "update") eventId = await calendar.update({ ...b, calendarEventId: c.eventId });
      else {
        await calendar.remove(c.eventId);
        eventId = null;
      }
      b.calendarEventId = eventId;
      const s = step("CalendarAgent");
      if (s) s.message = `${calendar.label}: ${c.op === "remove" ? "deleted" : c.op === "update" ? "updated" : "created"} event ${c.op === "remove" ? c.eventId : eventId}`;
    } catch (e) {
      if (c.op === "create") b.calendarEventId = null;
      warnings.push(`calendar ${c.op} failed after save: ${String(e).slice(0, 200)}`);
      const s = step("CalendarAgent");
      if (s) s.message = `${calendar.label}: ${c.op} FAILED after booking was saved`;
    }
    await db
      .update(schema.booking)
      .set({ calendarEventId: b.calendarEventId })
      .where(and(eq(schema.booking.id, b.id), eq(schema.booking.organizationId, org.id)))
      .catch((e: unknown) => warnings.push(`could not store calendar event id: ${String(e).slice(0, 200)}`));
  }

  if (notifier && fx.sends.length) {
    const outcomes: string[] = [];
    for (const send of fx.sends) {
      const idx = queuedIds.findIndex((q) => q.channel === send.channel);
      const rowId = idx >= 0 ? queuedIds.splice(idx, 1)[0].id : null;
      const sendOpts = rowId ? { idempotencyKey: `notification-${rowId}` } : undefined;
      const res = await notifier.send(b, send.subject, send.body, send.channel, sendOpts).catch((e: unknown) => ({ ok: false, detail: String(e) }));
      const recipient = send.channel === "email" ? b.email : b.phone;
      outcomes.push(`${send.channel} ${res.ok ? "sent" : "FAILED"} to ${recipient}`);
      if (!res.ok) warnings.push(`${send.channel} to ${recipient} failed`);
      if (rowId) {
        await db
          .update(schema.notification)
          .set({ deliveryStatus: res.ok ? "sent" : "failed", detail: res.detail ? res.detail.slice(0, 300) : null })
          .where(and(eq(schema.notification.id, rowId), eq(schema.notification.organizationId, org.id)))
          .catch((e: unknown) => warnings.push(`could not update notification ${rowId}: ${String(e).slice(0, 200)}`));
      }
    }
    const s = step("NotificationAgent");
    if (s) s.message = outcomes.join(" · ");
  }

  if (warnings.length) {
    await db
      .insert(schema.auditEntry)
      .values({
        id: `AU-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        organizationId: org.id,
        at: new Date(),
        action: result.action,
        bookingId: b.id,
        agent: "AuditAgent",
        outcome: "failed",
        detail: `post-save side effects for ${b.id}: ${warnings.join(" · ")}`.slice(0, 1000),
        actor,
      })
      .catch((e: unknown) => console.error("[pipeline] could not record side-effect warnings", e));
  }
}

/** Free start times for a resource/date (org hours, conflicts, past; and slots held for payment, when enabled). */
export async function availability(org: Org, q: { resource: string; date: string; durationMin: number }) {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(and(eq(schema.booking.organizationId, org.id), eq(schema.booking.status, "confirmed"), eq(schema.booking.date, q.date)));
  const holds = await activeHolds(db, org.id, { date: q.date });
  return freeSlots([...rows.map(rowToBooking), ...holds], q, new Date(), { hoursFor: hoursFor(org.hours), timeZone: org.timeZone });
}

/**
 * Payments at booking: check a new booking against the same rules as `runPipeline` create (validation, hours,
 * conflicts with bookings and other holds) under the org lock, WITHOUT saving a booking or sending anything; if it
 * would succeed, `insertHold` runs in the same transaction so no one else can take the slot in between.
 * Returns the dry-run result (ok, or invalid/conflict with a suggestion), with the booking it WOULD create.
 */
export async function holdSlot(org: Org, req: BookingRequest, insertHold: (tx: Tx) => Promise<void>): Promise<PipelineResult> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"flowops:org:" + org.id}))`);
    const bookings = await loadWorkingSet(tx, org);
    const engine = new BookingEngine({ bookings, audit: [], notifications: [] } satisfies EngineState);
    // No calendar/notifier: the engine only simulates those steps in memory. Nothing from this run is persisted.
    const result = await engine.create(req, { hoursFor: hoursFor(org.hours), timeZone: org.timeZone, actor: "payment-hold" });
    if (result.ok) await insertHold(tx);
    return result;
  });
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
