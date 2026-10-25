/**
 * FLOWOPS Booking Engine — TypeScript port of the v0.1 simulated pipeline.
 *
 *   FLOWOPS CORE -> INTENT AGENT -> BOOKING AGENT -> AVAILABILITY AGENT
 *     -> CALENDAR AGENT -> NOTIFICATION AGENT -> AUDIT AGENT -> BOOKING VERIFIED
 *
 * All state lives in memory (and the browser persists a snapshot to
 * localStorage). Calendar and Notification agents are SIMULATED: no real
 * calendar events are created and no messages are sent.
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

function suggestSlot(bookings: Booking[], slot: Pick<Booking, "resource" | "date" | "time" | "durationMin">, ignoreId?: string) {
  for (let t = toMinutes(slot.time) + 15; t + slot.durationMin <= CLOSE_HOUR * 60; t += 15) {
    const candidate = { ...slot, time: fromMinutes(t) };
    if (!findConflict(bookings, candidate, ignoreId)) return { date: slot.date, time: candidate.time };
  }
  return undefined;
}

function validateSlot(date: string, time: string, durationMin: number, now: Date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return "Date must be YYYY-MM-DD";
  if (!/^\d{2}:\d{2}$/.test(time)) return "Time must be HH:MM";
  if (!Number.isFinite(durationMin) || durationMin < 15 || durationMin > 480) return "Duration must be 15–480 minutes";
  const start = toMinutes(time);
  if (start < OPEN_HOUR * 60 || start + durationMin > CLOSE_HOUR * 60)
    return `Outside operating hours (${String(OPEN_HOUR).padStart(2, "0")}:00–${CLOSE_HOUR}:00)`;
  const startAt = new Date(`${date}T${time}:00`);
  if (startAt.getTime() < now.getTime()) return "Requested time is in the past";
  return null;
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
    const steps: AgentStep[] = PIPELINE.map((agent) => ({
      agent,
      status: "pending",
      message: "Waiting",
      simulated: SIMULATED_AGENTS.includes(agent),
      durationMs: 0,
    }));
    const emit = () => opts.onStep?.(steps.map((s) => ({ ...s })));
    emit();

    let booking: Booking | null = null;
    let target: Booking | undefined;
    const ts = now.toISOString();

    const exec = async (i: number, fn: () => { message: string; output?: Record<string, unknown> } | null) => {
      const step = steps[i];
      step.status = "running";
      step.message = "Running…";
      emit();
      const t0 = performance.now();
      await sleep(opts.stepDelayMs ?? 0);
      if (opts.failAgent === step.agent) {
        throw new AgentError(step.agent, `${step.agent} raised an unhandled error (injected fault)`);
      }
      const res = fn();
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
          const err = validateSlot(r.date, r.time, r.durationMin, now);
          if (err) throw new AgentError("IntentAgent", err, "invalid");
          return { message: `Intent: create_booking (${r.category})`, output: { intent: "create_booking", category: r.category } };
        }
        target = draft.bookings.find((b) => b.id === input.bookingId);
        if (!target) throw new AgentError("IntentAgent", `Booking ${input.bookingId} not found`, "not_found");
        if (target.status === "cancelled")
          throw new AgentError("IntentAgent", `Booking ${target.id} is already cancelled`, "invalid");
        if (action === "reschedule") {
          const err = validateSlot(input.date!, input.time!, target.durationMin, now);
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
          const suggestion = suggestSlot(draft.bookings, slot, b.id);
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

      // 4. Calendar Agent — SIMULATED
      await exec(3, () => {
        const b = booking!;
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

      // 5. Notification Agent — SIMULATED
      await exec(4, () => {
        const b = booking!;
        const subject =
          action === "create"
            ? `Booking confirmed: ${b.service} on ${b.date} at ${b.time}`
            : action === "reschedule"
              ? `Booking rescheduled: ${b.service} now ${b.date} at ${b.time}`
              : `Booking cancelled: ${b.service} on ${b.date}`;
        const rec: NotificationRecord = {
          id: shortId("NT"),
          at: ts,
          bookingId: b.id,
          recipient: b.email,
          channel: "email (simulated)",
          subject,
          deliveryStatus: "simulated-sent",
        };
        draft.notifications.unshift(rec);
        return { message: `[simulated] Notified ${b.email} — nothing actually sent`, output: { deliveryStatus: rec.deliveryStatus } };
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
      };
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
