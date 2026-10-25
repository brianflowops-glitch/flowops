/**
 * FLOWOPS Booking Engine — TypeScript port of the v0.1 simulated pipeline.
 *
 *   FLOWOPS CORE -> INTENT AGENT -> BOOKING AGENT -> AVAILABILITY AGENT
 *     -> CALENDAR AGENT -> NOTIFICATION AGENT -> AUDIT AGENT -> BOOKING VERIFIED
 *
 * The engine is storage-agnostic: it runs against an in-memory EngineState.
 * The server (src/lib/server/pipeline.ts) loads an organization's bookings from
 * Postgres, runs the engine, and persists the resulting changes; the FL-001..007
 * tests run it purely in memory. Calendar and Notification agents are SIMULATED
 * unless a real adapter (Google Calendar / Resend / Twilio) is passed in RunOptions.
 *
 * Every run is transactional: changes are applied to a draft and committed
 * only if every agent succeeds, so a failing agent never leaves a half-made
 * booking behind (FL-006).
 */
import type {
  AgentStep,
  AuditEntry,
  Booking,
  BookingRequest,
  DayHours,
  EngineState,
  NotificationRecord,
  PipelineAction,
  PipelineAgent,
  PipelineResult,
  RunOptions,
} from "./types";

export const PIPELINE: PipelineAgent[] = [
  "IntentAgent",
  "BookingAgent",
  "AvailabilityAgent",
  "CalendarAgent",
  "NotificationAgent",
  "AuditAgent",
];

export const SIMULATED_AGENTS: PipelineAgent[] = ["CalendarAgent", "NotificationAgent"];

export const AGENT_ROLE: Record<PipelineAgent, string> = {
  IntentAgent: "Parses and validates the request, classifies intent",
  BookingAgent: "customer, service, date, time → booking ID + status",
  AvailabilityAgent: "resource, requested time → available / conflict",
  CalendarAgent: "approved booking → calendar event ID or error",
  NotificationAgent: "booking status, recipient → delivery status",
  AuditAgent: "Writes the immutable audit trail entry",
};

export const OPEN_HOUR = 7;
export const CLOSE_HOUR = 22;

export function emptyState(): EngineState {
  return { bookings: [], audit: [], notifications: [] };
}

class AgentError extends Error {
  constructor(
    public agent: PipelineAgent,
    message: string,
    public kind: "invalid" | "conflict" | "failed" | "not_found" = "failed",
    public suggestion?: { date: string; time: string },
  ) {
    super(message);
  }
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let counter = 0;
function shortId(prefix: string): string {
  counter = (counter + 1) % 1296;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${Date.now().toString(36).slice(-4).toUpperCase()}${rand}${counter.toString(36).toUpperCase()}`;
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
function fromMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function overlaps(a: { date: string; time: string; durationMin: number }, b: { date: string; time: string; durationMin: number }) {
  if (a.date !== b.date) return false;
  const a0 = toMinutes(a.time);
  const b0 = toMinutes(b.time);
  return a0 < b0 + b.durationMin && b0 < a0 + a.durationMin;
}

function findConflict(bookings: Booking[], slot: Pick<Booking, "resource" | "date" | "time" | "durationMin">, ignoreId?: string) {
  return bookings.find(
    (b) =>
      b.status === "confirmed" &&
      b.id !== ignoreId &&
      b.resource.trim().toLowerCase() === slot.resource.trim().toLowerCase() &&
      overlaps(b, slot),
  );
}

export const DEFAULT_HOURS: DayHours = { open: `${String(OPEN_HOUR).padStart(2, "0")}:00`, close: `${CLOSE_HOUR}:00` };

function hoursOf(date: string, opts: Pick<RunOptions, "hoursFor">): DayHours {
  return opts.hoursFor ? opts.hoursFor(date) : DEFAULT_HOURS;
}

/** "YYYY-MM-DDTHH:MM" for `now` in the given IANA zone (or process-local time). */
export function localStamp(now: Date, timeZone?: string): string {
  if (!timeZone) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function suggestSlot(bookings: Booking[], slot: Pick<Booking, "resource" | "date" | "time" | "durationMin">, ignoreId: string | undefined, opts: Pick<RunOptions, "hoursFor">) {
  const h = hoursOf(slot.date, opts);
  if (!h) return undefined;
  for (let t = toMinutes(slot.time) + 15; t + slot.durationMin <= toMinutes(h.close); t += 15) {
    const candidate = { ...slot, time: fromMinutes(t) };
    if (!findConflict(bookings, candidate, ignoreId)) return { date: slot.date, time: candidate.time };
  }
  return undefined;
}

export function validateSlot(date: string, time: string, durationMin: number, now: Date, opts: Pick<RunOptions, "hoursFor" | "timeZone"> = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return "Date must be YYYY-MM-DD";
  if (!/^\d{2}:\d{2}$/.test(time)) return "Time must be HH:MM";
  if (!Number.isFinite(durationMin) || durationMin < 15 || durationMin > 480) return "Duration must be 15–480 minutes";
  const h = hoursOf(date, opts);
  if (!h) return `Closed on ${date}`;
  const start = toMinutes(time);
  if (start < toMinutes(h.open) || start + durationMin > toMinutes(h.close)) return `Outside operating hours (${h.open}–${h.close})`;
  if (`${date}T${time}` < localStamp(now, opts.timeZone)) return "Requested time is in the past";
  return null;
}

/** Free start times (15-minute grid) for a resource on a date, honouring hours, conflicts and "now". */
export function freeSlots(
  bookings: Booking[],
  q: { resource: string; date: string; durationMin: number },
  now: Date,
  opts: Pick<RunOptions, "hoursFor" | "timeZone"> = {},
  ignoreId?: string,
): string[] {
  const h = hoursOf(q.date, opts);
  if (!h) return [];
  const out: string[] = [];
  for (let t = toMinutes(h.open); t + q.durationMin <= toMinutes(h.close); t += 15) {
    const time = fromMinutes(t);
    if (validateSlot(q.date, time, q.durationMin, now, opts)) continue;
    if (!findConflict(bookings, { resource: q.resource, date: q.date, time, durationMin: q.durationMin }, ignoreId)) out.push(time);
  }
  return out;
}

/** In-memory booking engine. One instance per "store" (UI store, test sandbox, …). */
export class BookingEngine {
  private state: EngineState;

  constructor(initial?: EngineState) {
    this.state = initial ? structuredClone(initial) : emptyState();
  }

  snapshot(): EngineState {
    return structuredClone(this.state);
  }

  reset() {
    this.state = emptyState();
  }

  get bookings() {
    return this.state.bookings;
  }

  create(req: BookingRequest, opts: RunOptions = {}) {
    return this.run("create", { req }, opts);
  }

  reschedule(bookingId: string, date: string, time: string, opts: RunOptions = {}) {
    return this.run("reschedule", { bookingId, date, time }, opts);
  }

  cancel(bookingId: string, opts: RunOptions = {}) {
    return this.run("cancel", { bookingId }, opts);
  }

  private async run(
    action: PipelineAction,
    input: { req?: BookingRequest; bookingId?: string; date?: string; time?: string },
    opts: RunOptions,
  ): Promise<PipelineResult> {
    const now = opts.now ?? new Date();
    const draft = structuredClone(this.state);
    const realCalendar = opts.calendar;
    const notifier = opts.notifier;
    const steps: AgentStep[] = PIPELINE.map((agent) => ({
      agent,
      status: "pending",
      message: "Waiting",
      simulated:
        agent === "CalendarAgent" ? !realCalendar : agent === "NotificationAgent" ? !(notifier && (notifier.channels.email || notifier.channels.sms)) : false,
      durationMs: 0,
    }));
    let createdEventId: string | null = null;
    const emit = () => opts.onStep?.(steps.map((s) => ({ ...s })));
    emit();

    let booking: Booking | null = null;
    let target: Booking | undefined;
    const ts = now.toISOString();

    type StepOut = { message: string; output?: Record<string, unknown> } | null;
    const exec = async (i: number, fn: () => StepOut | Promise<StepOut>) => {
      const step = steps[i];
      step.status = "running";
      step.message = "Running…";
      emit();
      const t0 = performance.now();
      await sleep(opts.stepDelayMs ?? 0);
      if (opts.failAgent === step.agent) {
        throw new AgentError(step.agent, `${step.agent} raised an unhandled error (injected fault)`);
      }
      const res = await fn();
      step.durationMs = Math.round(performance.now() - t0);
      if (res === null) {
        step.status = "skipped";
        step.message = "Not required for this action";
      } else {
        step.status = "success";
        step.message = res.message;
        step.output = res.output;
      }
      emit();
    };

    try {
      // 1. Intent Agent — validate + classify
      await exec(0, () => {
        if (action === "create") {
          const r = input.req!;
          const missing = (["customer", "email", "service", "resource", "date", "time"] as const).filter(
            (k) => !String(r[k] ?? "").trim(),
          );
          if (missing.length) throw new AgentError("IntentAgent", `Missing fields: ${missing.join(", ")}`, "invalid");
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email))
            throw new AgentError("IntentAgent", "Recipient email is not valid", "invalid");
          const err = validateSlot(r.date, r.time, r.durationMin, now, opts);
          if (err) throw new AgentError("IntentAgent", err, "invalid");
          return { message: `Intent: create_booking (${r.category})`, output: { intent: "create_booking", category: r.category } };
        }
        target = draft.bookings.find((b) => b.id === input.bookingId);
        if (!target) throw new AgentError("IntentAgent", `Booking ${input.bookingId} not found`, "not_found");
        if (target.status === "cancelled")
          throw new AgentError("IntentAgent", `Booking ${target.id} is already cancelled`, "invalid");
        if (action === "reschedule") {
          const err = validateSlot(input.date!, input.time!, target.durationMin, now, opts);
          if (err) throw new AgentError("IntentAgent", err, "invalid");
          return { message: `Intent: reschedule_booking → ${input.date} ${input.time}`, output: { intent: "reschedule_booking" } };
        }
        return { message: "Intent: cancel_booking", output: { intent: "cancel_booking" } };
      });

      // 2. Booking Agent — create the booking record (status pending until verified)
      await exec(1, () => {
        if (action === "create") {
          const r = input.req!;
          booking = {
            ...r,
            customer: r.customer.trim(),
            email: r.email.trim(),
            ...(r.phone?.trim() ? { phone: r.phone.trim() } : {}),
            id: shortId("BK"),
            status: "confirmed",
            calendarEventId: null,
            createdAt: ts,
            updatedAt: ts,
            history: [{ at: ts, action: "created", detail: `${r.date} ${r.time} on ${r.resource}` }],
          };
          return { message: `Booking ID ${booking.id} issued (pending verification)`, output: { bookingId: booking.id, status: "pending" } };
        }
        booking = target!;
        if (action === "cancel") {
          booking.status = "cancelled";
          booking.updatedAt = ts;
          booking.history.push({ at: ts, action: "cancelled", detail: "Cancelled by request" });
          return { message: `Booking ${booking.id} marked cancelled`, output: { bookingId: booking.id, status: "cancelled" } };
        }
        return { message: `Loaded booking ${booking.id}`, output: { bookingId: booking.id } };
      });

      // 3. Availability Agent — conflict detection
      await exec(2, () => {
        if (action === "cancel") return null;
        const b = booking!;
        const slot = action === "reschedule" ? { ...b, date: input.date!, time: input.time! } : b;
        const conflict = findConflict(draft.bookings, slot, b.id);
        if (conflict) {
          const suggestion = suggestSlot(draft.bookings, slot, b.id, opts);
          throw new AgentError(
            "AvailabilityAgent",
            `Conflict on ${slot.resource}: overlaps ${conflict.id} (${conflict.time}, ${conflict.durationMin}m)`,
            "conflict",
            suggestion,
          );
        }
        if (action === "reschedule") {
          const from = `${b.date} ${b.time}`;
          b.date = input.date!;
          b.time = input.time!;
          b.updatedAt = ts;
          b.history.push({ at: ts, action: "rescheduled", detail: `${from} → ${b.date} ${b.time}` });
        }
        return { message: `${slot.resource} available ${slot.date} ${slot.time} (${slot.durationMin}m)`, output: { available: true } };
      });

      // 4. Calendar Agent — real adapter (Google Calendar) when provided, otherwise SIMULATED
      await exec(3, async () => {
        const b = booking!;
        if (realCalendar) {
          if (action === "cancel") {
            const prev = b.calendarEventId;
            if (prev && !prev.startsWith("SIMCAL")) await realCalendar.remove(prev);
            b.calendarEventId = null;
            return { message: `${realCalendar.label}: deleted event ${prev ?? "(none)"}`, output: { deleted: prev } };
          }
          const existing = b.calendarEventId && !b.calendarEventId.startsWith("SIMCAL") ? b.calendarEventId : null;
          b.calendarEventId = existing && action === "reschedule" ? await realCalendar.update(b) : await realCalendar.create(b);
          if (!existing || action === "create") createdEventId = b.calendarEventId;
          return {
            message: `${realCalendar.label}: ${existing && action === "reschedule" ? "updated" : "created"} event ${b.calendarEventId}`,
            output: { calendarEventId: b.calendarEventId },
          };
        }
        if (action === "cancel") {
          const prev = b.calendarEventId;
          b.calendarEventId = null;
          return { message: `[simulated] Deleted calendar event ${prev ?? "(none)"}`, output: { deleted: prev } };
        }
        b.calendarEventId = shortId("SIMCAL");
        return {
          message: `[simulated] ${action === "create" ? "Created" : "Updated"} event ${b.calendarEventId}`,
          output: { calendarEventId: b.calendarEventId },
        };
      });

      // 5. Notification Agent — real email (Resend) / SMS (Twilio) when provided, otherwise SIMULATED
      await exec(4, async () => {
        const b = booking!;
        const subject =
          action === "create"
            ? `Booking confirmed: ${b.service} on ${b.date} at ${b.time}`
            : action === "reschedule"
              ? `Booking rescheduled: ${b.service} now ${b.date} at ${b.time}`
              : `Booking cancelled: ${b.service} on ${b.date}`;
        const body = `Hi ${b.customer},\n\n${subject}.\nReference: ${b.id}${b.resource ? ` · ${b.resource}` : ""}\n\n— Sent by FLOWOPS`;
        const sent: string[] = [];
        const channels: ("email" | "sms")[] = b.phone ? ["email", "sms"] : ["email"];
        for (const ch of channels) {
          const real = !!notifier?.channels[ch];
          const rec: NotificationRecord = {
            id: shortId("NT"),
            at: ts,
            bookingId: b.id,
            recipient: ch === "email" ? b.email : b.phone!,
            channel: real ? ch : (`${ch} (simulated)` as NotificationRecord["channel"]),
            subject,
            deliveryStatus: "simulated-sent",
          };
          if (real) {
            const res = await notifier!.send(b, subject, body, ch).catch((e: unknown) => ({ ok: false, detail: String(e) }));
            rec.deliveryStatus = res.ok ? "sent" : "failed";
            if (res.detail) rec.detail = res.detail.slice(0, 300);
            sent.push(`${ch} ${res.ok ? "sent" : "FAILED"} to ${rec.recipient}`);
          } else {
            sent.push(`[simulated] ${ch} to ${rec.recipient} — nothing actually sent`);
          }
          draft.notifications.unshift(rec);
        }
        return { message: sent.join(" · "), output: { channels } };
      });

      // 6. Audit Agent
      await exec(5, () => {
        const b = booking!;
        const entry: AuditEntry = {
          id: shortId("AU"),
          at: ts,
          action,
          bookingId: b.id,
          agent: "AuditAgent",
          outcome: "success",
          detail: `${action} ${b.id} · ${b.customer} · ${b.service} · ${b.date} ${b.time} · ${b.resource}`,
          ...(opts.actor ? { actor: opts.actor } : {}),
        };
        draft.audit.unshift(entry);
        return { message: `Audit entry ${entry.id} written`, output: { auditId: entry.id } };
      });

      if (action === "create") draft.bookings.unshift(booking!);
      this.state = draft; // commit
      return { action, ok: true, verified: true, outcome: "verified", booking: structuredClone(booking!), steps };
    } catch (e) {
      const err =
        e instanceof AgentError ? e : new AgentError(steps.find((s) => s.status === "running")?.agent ?? "IntentAgent", String(e));
      const idx = steps.findIndex((s) => s.agent === err.agent);
      for (let i = 0; i < steps.length; i++) {
        if (i === idx) {
          steps[i].status = "failed";
          steps[i].message = err.message;
        } else if (i > idx && steps[i].agent !== "AuditAgent") {
          steps[i].status = "skipped";
          steps[i].message = "Halted — upstream agent did not succeed";
        }
      }
      // Draft is discarded (rollback). The Audit Agent still records the failure.
      const auditStep = steps[5];
      const failureEntry: AuditEntry = {
        id: shortId("AU"),
        at: ts,
        action: err.kind === "failed" ? "agent_failure" : action,
        bookingId: (booking as Booking | null)?.id ?? input.bookingId ?? null,
        agent: err.agent,
        outcome: err.kind,
        detail: `${action} halted at ${err.agent}: ${err.message}${err.kind === "failed" ? " · changes rolled back" : ""}`,
        ...(opts.actor ? { actor: opts.actor } : {}),
      };
      // Compensate a real calendar event created during this (rolled back) run.
      if (createdEventId && realCalendar) {
        await realCalendar.remove(createdEventId).catch(() => {
          failureEntry.detail += ` · WARNING: could not remove calendar event ${createdEventId}`;
        });
      }
      if (err.agent === "AuditAgent") {
        // audit itself failed — keep the record in memory but flag it
        failureEntry.detail += " · audit agent degraded";
      } else {
        auditStep.status = "success";
        auditStep.message = `Failure recorded (${err.kind}); no changes committed`;
      }
      this.state.audit.unshift(failureEntry);
      emit();
      return {
        action,
        ok: false,
        verified: false,
        outcome: err.kind,
        booking: null,
        steps,
        error: err.message,
        suggestion: err.suggestion,
      };
    }
  }
}
