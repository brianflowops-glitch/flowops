/**
 * FLOWOPS simulation test suite FL-001 … FL-008 (Testing strategy C, phase 1:
 * simulation first). Each test runs against a fresh, isolated BookingEngine so
 * it never touches the user's bookings.
 */
import { BookingEngine } from "./engine";
import type { BookingRequest, NotifierAdapter } from "./types";
import { toE164 } from "../phone";

export interface Assertion {
  label: string;
  pass: boolean;
  detail?: string;
}
export interface TestResult {
  id: string;
  name: string;
  pass: boolean;
  durationMs: number;
  assertions: Assertion[];
  error?: string;
}
export interface TestCase {
  id: string;
  name: string;
  description: string;
  run: () => Promise<Assertion[]>;
}

function futureDate(daysAhead: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function req(over: Partial<BookingRequest> = {}): BookingRequest {
  return {
    customer: "Test Customer",
    email: "test.customer@example.com",
    category: "appointment",
    service: "Consultation",
    resource: "Room A",
    date: futureDate(3),
    time: "10:00",
    durationMin: 60,
    ...over,
  };
}

const check = (label: string, pass: boolean, detail?: string): Assertion => ({ label, pass, detail });

export const TEST_CASES: TestCase[] = [
  {
    id: "FL-001",
    name: "Create booking",
    description: "A valid request flows through all six agents and is verified.",
    run: async () => {
      const e = new BookingEngine();
      const r = await e.create(req());
      return [
        check("Pipeline returns verified", r.ok && r.verified, r.outcome),
        check("Booking ID issued", !!r.booking?.id, r.booking?.id),
        check("All 6 agents succeeded", r.steps.every((s) => s.status === "success"), r.steps.map((s) => `${s.agent}:${s.status}`).join(", ")),
        check("Calendar event (simulated) attached", !!r.booking?.calendarEventId?.startsWith("SIMCAL"), r.booking?.calendarEventId ?? "none"),
        check("Booking persisted in store", e.snapshot().bookings.length === 1),
      ];
    },
  },
  {
    id: "FL-002",
    name: "Duplicate / conflict detection",
    description: "A second booking overlapping the same resource and time is rejected.",
    run: async () => {
      const e = new BookingEngine();
      await e.create(req());
      const dup = await e.create(req({ customer: "Second Customer", time: "10:30" }));
      const otherRoom = await e.create(req({ resource: "Room B" }));
      return [
        check("Overlapping booking rejected", !dup.ok && dup.outcome === "conflict", dup.error),
        check("Availability Agent flagged the conflict", dup.steps.find((s) => s.agent === "AvailabilityAgent")?.status === "failed"),
        check("Next free slot suggested", !!dup.suggestion, dup.suggestion ? `${dup.suggestion.date} ${dup.suggestion.time}` : "none"),
        check("Same time on a different resource allowed", otherRoom.ok),
        check("Store holds exactly 2 bookings", e.snapshot().bookings.length === 2),
      ];
    },
  },
  {
    id: "FL-003",
    name: "Reschedule",
    description: "A confirmed booking moves to a free slot; moving onto a taken slot is refused.",
    run: async () => {
      const e = new BookingEngine();
      const a = await e.create(req());
      await e.create(req({ customer: "Blocker", time: "14:00" }));
      const newDate = futureDate(4);
      const moved = await e.reschedule(a.booking!.id, newDate, "11:00");
      const blocked = await e.reschedule(a.booking!.id, futureDate(3), "14:30");
      const stored = e.snapshot().bookings.find((b) => b.id === a.booking!.id);
      return [
        check("Reschedule verified", moved.ok, moved.error),
        check("Date/time updated", stored?.date === newDate && stored?.time === "11:00", `${stored?.date} ${stored?.time}`),
        check("Calendar event re-issued (simulated)", !!stored?.calendarEventId && stored.calendarEventId !== a.booking!.calendarEventId),
        check("Reschedule into conflict refused", !blocked.ok && blocked.outcome === "conflict", blocked.error),
        check("Failed reschedule left booking unchanged", stored?.time === "11:00"),
      ];
    },
  },
  {
    id: "FL-004",
    name: "Cancel",
    description: "Cancelling frees the slot and removes the (simulated) calendar event.",
    run: async () => {
      const e = new BookingEngine();
      const a = await e.create(req());
      const c = await e.cancel(a.booking!.id);
      const again = await e.cancel(a.booking!.id);
      const rebook = await e.create(req({ customer: "Next Customer" }));
      const stored = e.snapshot().bookings.find((b) => b.id === a.booking!.id);
      return [
        check("Cancel verified", c.ok, c.error),
        check("Status is cancelled", stored?.status === "cancelled"),
        check("Calendar event removed (simulated)", stored?.calendarEventId === null),
        check("Double cancel rejected", !again.ok, again.error),
        check("Freed slot can be re-booked", rebook.ok, rebook.error),
      ];
    },
  },
  {
    id: "FL-005",
    name: "Notification",
    description: "Notification Agent records a (simulated) delivery to the recipient for each change.",
    run: async () => {
      const e = new BookingEngine();
      const a = await e.create(req({ email: "notify.me@example.com" }));
      await e.reschedule(a.booking!.id, futureDate(5), "09:00");
      await e.cancel(a.booking!.id);
      const n = e.snapshot().notifications.filter((x) => x.bookingId === a.booking!.id);
      return [
        check("3 notifications recorded (create, reschedule, cancel)", n.length === 3, `${n.length}`),
        check("Sent to booking recipient", n.every((x) => x.recipient === "notify.me@example.com")),
        check("Delivery status = simulated-sent", n.every((x) => x.deliveryStatus === "simulated-sent")),
        check("Subjects reflect each action", /cancelled/i.test(n[0]?.subject ?? "") && /confirmed/i.test(n[2]?.subject ?? "")),
      ];
    },
  },
  {
    id: "FL-006",
    name: "Agent failure handled safely",
    description: "An injected Calendar Agent fault halts the pipeline, rolls back, and is audited.",
    run: async () => {
      const e = new BookingEngine();
      let threw = false;
      let r;
      try {
        r = await e.create(req(), { failAgent: "CalendarAgent" });
      } catch {
        threw = true;
      }
      const s = e.snapshot();
      const after = await e.create(req());
      return [
        check("Engine did not crash", !threw && !!r),
        check("Pipeline reported failure", !!r && !r.ok && r.outcome === "failed", r?.error),
        check("Downstream agents skipped", r?.steps.find((x) => x.agent === "NotificationAgent")?.status === "skipped"),
        check("No partial booking persisted (rollback)", s.bookings.length === 0),
        check("No notification sent", s.notifications.length === 0),
        check("Failure written to audit log", s.audit.some((x) => x.action === "agent_failure" && x.agent === "CalendarAgent")),
        check("Engine recovers for the next request", after.ok),
      ];
    },
  },
  {
    id: "FL-007",
    name: "Audit history",
    description: "Every action (including rejections) leaves an ordered audit trail.",
    run: async () => {
      const e = new BookingEngine();
      const a = await e.create(req());
      await e.create(req({ customer: "Clash" })); // conflict
      await e.reschedule(a.booking!.id, futureDate(6), "15:00");
      await e.cancel(a.booking!.id);
      const s = e.snapshot();
      const trail = s.audit.filter((x) => x.bookingId === a.booking!.id).reverse();
      const b = s.bookings.find((x) => x.id === a.booking!.id);
      return [
        check("Audit trail for booking = create → reschedule → cancel", trail.map((x) => x.action).join(",") === "create,reschedule,cancel", trail.map((x) => x.action).join(" → ")),
        check("Conflict rejection also audited", s.audit.some((x) => x.outcome === "conflict")),
        check("Entries are timestamped", s.audit.every((x) => !Number.isNaN(Date.parse(x.at)))),
        check("Booking carries its own history (3 events)", b?.history.length === 3, `${b?.history.length}`),
      ];
    },
  },
  {
    id: "FL-008",
    name: "SMS opt-in and phone normalization",
    description: "Texts go out only with a phone AND opt-in (create, reschedule, cancel); US numbers become E.164; a failed text never blocks the booking.",
    run: async () => {
      const texts: { to: string; subject: string }[] = [];
      let failSms = false;
      const notifier: NotifierAdapter = {
        channels: { email: false, sms: true },
        async send(b, subject, _body, ch) {
          if (ch === "sms") texts.push({ to: b.phone!, subject });
          return ch === "sms" && failSms ? { ok: false, detail: "Twilio 400 code 21608" } : { ok: true };
        },
      };
      const e = new BookingEngine();
      const noConsent = await e.create(req({ phone: "(610) 555-0134" }), { notifier });
      const yes = await e.create(req({ customer: "Opted In", time: "13:00", phone: "610.555.0199", smsConsent: true }), { notifier });
      await e.reschedule(yes.booking!.id, futureDate(4), "11:00", { notifier });
      failSms = true;
      const cancelled = await e.cancel(yes.booking!.id, { notifier });
      const bad = await e.create(req({ customer: "Bad Phone", time: "15:00", phone: "12345", smsConsent: true }), { notifier });
      return [
        check("No text without opt-in", texts.every((t) => t.to !== noConsent.booking?.phone) && noConsent.ok),
        check("Phone stored as E.164", yes.booking?.phone === "+16105550199" && noConsent.booking?.phone === "+16105550134", `${yes.booking?.phone}, ${noConsent.booking?.phone}`),
        check("Consent recorded with timestamp", !!yes.booking?.smsConsent && !!yes.booking?.smsConsentAt),
        check("Texts for confirm, reschedule and cancel", texts.length === 3 && /confirmed/.test(texts[0].subject) && /rescheduled/.test(texts[1].subject) && /cancelled/.test(texts[2].subject), texts.map((t) => t.subject.split(":")[0]).join(", ")),
        check("Failed text doesn't block the cancel", cancelled.ok && e.snapshot().notifications.some((n) => n.channel === "sms" && n.deliveryStatus === "failed")),
        check("Opt-in with an invalid number is rejected", !bad.ok && bad.outcome === "invalid", bad.error),
        check("E.164 helper", toE164("610-555-0134") === "+16105550134" && toE164("+1 610 555 0134") === "+16105550134" && toE164("1 (610) 555-0134") === "+16105550134" && toE164("555-0134") === null && toE164("+44 20 7946 0958") === "+442079460958"),
      ];
    },
  },
];

export async function runTest(t: TestCase): Promise<TestResult> {
  const t0 = performance.now();
  try {
    const assertions = await t.run();
    return { id: t.id, name: t.name, pass: assertions.every((a) => a.pass), assertions, durationMs: Math.round(performance.now() - t0) };
  } catch (e) {
    return { id: t.id, name: t.name, pass: false, assertions: [], error: String(e), durationMs: Math.round(performance.now() - t0) };
  }
}
