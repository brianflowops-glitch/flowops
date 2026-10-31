/**
 * Email-reminder unit tests (RM-001 … RM-008): flag parsing, window selection, time-zone / DST handling, the
 * exactly-once key, skip rules (cancelled / past / no email / booked inside the window) and the email text.
 * Pure logic only; the database claim + send path is covered by tests/email-reminders.test.ts (PGlite).
 */
import type { Assertion, TestCase } from "@/lib/booking/tests";
import { decideReminder, formatStart, reminderConfig, reminderEmail, reminderKey, startsAtInZone, type ReminderBooking, type ReminderConfig } from "./reminders";

const check = (label: string, pass: boolean, detail?: string): Assertion => ({ label, pass, detail });
const on: ReminderConfig = reminderConfig({ EMAIL_REMINDERS_ENABLED: "true" });
const NY = "America/New_York";
const iso = (d: Date | null) => d?.toISOString() ?? "null";
const booking = (over: Partial<ReminderBooking> = {}): ReminderBooking => ({
  id: "BK-1",
  status: "confirmed",
  email: "pat@example.test",
  date: "2030-06-15",
  time: "10:00",
  createdAt: new Date("2030-06-01T12:00:00Z"),
  history: [{ at: "2030-06-01T12:00:00Z", action: "created" }],
  ...over,
});
// 2030-06-15 10:00 in New York (EDT, UTC-4) = 14:00Z.
const START = new Date("2030-06-15T14:00:00Z");
const before = (ms: number) => new Date(START.getTime() - ms);
const H = 3_600_000;
const reason = (d: ReturnType<typeof decideReminder>) => (d.send ? "send" : d.reason);

export const REMINDER_TEST_CASES: TestCase[] = [
  {
    id: "RM-001",
    name: "Flag off = no reminders; config parsing",
    description: "Reminders are off unless EMAIL_REMINDERS_ENABLED=true; the lead/min-lead knobs are clamped.",
    run: async () => {
      const off = reminderConfig({});
      const offDecision = decideReminder(booking(), NY, before(12 * H), off);
      return [
        check("unset → disabled", !off.enabled),
        check("'false' / '1' / 'yes' → disabled", ["false", "1", "yes", ""].every((v) => !reminderConfig({ EMAIL_REMINDERS_ENABLED: v }).enabled)),
        check("'true' / ' TRUE ' → enabled", reminderConfig({ EMAIL_REMINDERS_ENABLED: "true" }).enabled && reminderConfig({ EMAIL_REMINDERS_ENABLED: " TRUE " }).enabled),
        check("flag off → a perfectly due booking is NOT sent", reason(offDecision) === "disabled", reason(offDecision)),
        check("defaults: 24 h lead, 30 min minimum", on.leadMs === 24 * H && on.minLeadMs === 30 * 60_000),
        check("lead clamped to 1–72 h", reminderConfig({ EMAIL_REMINDER_LEAD_HOURS: "500" }).leadMs === 72 * H && reminderConfig({ EMAIL_REMINDER_LEAD_HOURS: "0" }).leadMs === 1 * H),
        check("garbage → defaults", reminderConfig({ EMAIL_REMINDER_LEAD_HOURS: "abc", EMAIL_REMINDER_MIN_LEAD_MINUTES: "x" }).leadMs === 24 * H),
      ];
    },
  },
  {
    id: "RM-002",
    name: "Window selection",
    description: "Sends only when the start is within (now + minLead, now + lead]; not already started, not too close, not too far.",
    run: async () => {
      const d = (ms: number) => reason(decideReminder(booking(), NY, before(ms), on));
      return [
        check("48 h before → too_far", d(48 * H) === "too_far", d(48 * H)),
        check("24 h 1 min before → too_far", d(24 * H + 60_000) === "too_far", d(24 * H + 60_000)),
        check("exactly 24 h before → send", d(24 * H) === "send", d(24 * H)),
        check("12 h before → send", d(12 * H) === "send", d(12 * H)),
        check("31 min before → send", d(31 * 60_000) === "send", d(31 * 60_000)),
        check("10 min before → too_close", d(10 * 60_000) === "too_close", d(10 * 60_000)),
        check("exactly at start → past", d(0) === "past", d(0)),
        check("after start → past", d(-3600_000) === "past", d(-3600_000)),
        check("daily-cron fallback (lead 30 h) sends 28 h out", reason(decideReminder(booking(), NY, before(28 * H), reminderConfig({ EMAIL_REMINDERS_ENABLED: "true", EMAIL_REMINDER_LEAD_HOURS: "30" }))) === "send"),
      ];
    },
  },
  {
    id: "RM-003",
    name: "Org time zone drives the start instant",
    description: "Booking date/time are org-local; the same wall clock is a different instant in each zone.",
    run: async () => [
      check("NY 2030-06-15 10:00 = 14:00Z (EDT)", iso(startsAtInZone("2030-06-15", "10:00", NY)) === "2030-06-15T14:00:00.000Z", iso(startsAtInZone("2030-06-15", "10:00", NY))),
      check("Honolulu 10:00 = 20:00Z", iso(startsAtInZone("2030-06-15", "10:00", "Pacific/Honolulu")) === "2030-06-15T20:00:00.000Z"),
      check("Kiritimati (+14) 10:00 = previous day 20:00Z", iso(startsAtInZone("2030-06-15", "10:00", "Pacific/Kiritimati")) === "2030-06-14T20:00:00.000Z"),
      check("null zone → UTC", iso(startsAtInZone("2030-06-15", "10:00", null)) === "2030-06-15T10:00:00.000Z"),
      check("unknown zone → null", startsAtInZone("2030-06-15", "10:00", "Not/AZone") === null),
      check("malformed date/time → null", startsAtInZone("15/06/2030", "10:00", NY) === null && startsAtInZone("2030-06-15", "10am", NY) === null),
      check("unknown zone → bad_start, never sent", reason(decideReminder(booking(), "Not/AZone", before(12 * H), on)) === "bad_start"),
    ],
  },
  {
    id: "RM-004",
    name: "DST boundaries (America/New_York)",
    description: "Spring-forward 2030-03-10 and fall-back 2030-11-03: start instant, 24 h window and formatted text stay correct.",
    run: async () => {
      // Spring forward: 02:00 EST → 03:00 EDT on 2030-03-10. 03-09 10:00 is EST (UTC-5); 03-10 10:00 is EDT (UTC-4).
      const springSat = startsAtInZone("2030-03-09", "10:00", NY);
      const springSun = startsAtInZone("2030-03-10", "10:00", NY);
      // Fall back: 02:00 EDT → 01:00 EST on 2030-11-03. 11-02 10:00 is EDT; 11-03 10:00 is EST.
      const fallSun = startsAtInZone("2030-11-03", "10:00", NY);
      const springBooking = booking({ date: "2030-03-10", createdAt: new Date("2030-03-01T12:00:00Z"), history: [] });
      const fallBooking = booking({ date: "2030-11-03", createdAt: new Date("2030-10-20T12:00:00Z"), history: [] });
      return [
        check("03-09 10:00 EST = 15:00Z", iso(springSat) === "2030-03-09T15:00:00.000Z", iso(springSat)),
        check("03-10 10:00 EDT = 14:00Z (only 23 h after Saturday's 10:00)", iso(springSun) === "2030-03-10T14:00:00.000Z" && springSun!.getTime() - springSat!.getTime() === 23 * H, iso(springSun)),
        check("11-03 10:00 EST = 15:00Z", iso(fallSun) === "2030-11-03T15:00:00.000Z", iso(fallSun)),
        check("spring: Saturday 10:00 EST (23 real hours out) is inside the 24 h window", reason(decideReminder(springBooking, NY, new Date("2030-03-09T15:00:00Z"), on)) === "send"),
        check("spring: 24 h 1 min out is not yet", reason(decideReminder(springBooking, NY, new Date("2030-03-09T13:59:00Z"), on)) === "too_far"),
        check("fall: Saturday 10:00 EDT is 25 real hours out → not yet", reason(decideReminder(fallBooking, NY, new Date("2030-11-02T14:00:00Z"), on)) === "too_far"),
        check("fall: 24 real hours out → send", reason(decideReminder(fallBooking, NY, new Date("2030-11-02T15:00:00Z"), on)) === "send"),
        check("ambiguous 01:30 on fall-back day resolves deterministically", iso(startsAtInZone("2030-11-03", "01:30", NY)) === iso(startsAtInZone("2030-11-03", "01:30", NY)) && startsAtInZone("2030-11-03", "01:30", NY) !== null),
        check("format EST", formatStart(springSat!, NY) === "Sat, Mar 9 at 10:00 AM EST", formatStart(springSat!, NY)),
        check("format EDT", formatStart(springSun!, NY) === "Sun, Mar 10 at 10:00 AM EDT", formatStart(springSun!, NY)),
        check("format uses the org zone, not the server's", formatStart(START, "Pacific/Honolulu") === "Sat, Jun 15 at 4:00 AM HST", formatStart(START, "Pacific/Honolulu")),
        check("format afternoon is PM", formatStart(new Date("2030-06-15T18:00:00Z"), NY) === "Sat, Jun 15 at 2:00 PM EDT", formatStart(new Date("2030-06-15T18:00:00Z"), NY)),
      ];
    },
  },
  {
    id: "RM-005",
    name: "Idempotency key changes on reschedule",
    description: "Key = reminder-<bookingId>-<startsAtISO>: stable for the same slot, fresh for a rescheduled one, unique per booking.",
    run: async () => {
      const a = decideReminder(booking(), NY, before(12 * H), on);
      const again = decideReminder(booking(), NY, before(3 * H), on);
      const moved = decideReminder(booking({ date: "2030-06-16" }), NY, new Date("2030-06-16T02:00:00Z"), on);
      const other = decideReminder(booking({ id: "BK-2" }), NY, before(12 * H), on);
      const key = (d: typeof a) => (d.send ? d.key : "");
      return [
        check("key format", key(a) === "reminder-BK-1-2030-06-15T14:00:00.000Z", key(a)),
        check("same slot, different run time → same key (so the unique index dedupes)", key(a) === key(again)),
        check("rescheduled to another day → different key", moved.send && key(moved) !== key(a) && key(moved) === "reminder-BK-1-2030-06-16T14:00:00.000Z", key(moved)),
        check("different booking → different key", key(other) !== key(a)),
        check("reminderKey is the same function", reminderKey("BK-1", START) === key(a)),
      ];
    },
  },
  {
    id: "RM-006",
    name: "Skip rules: cancelled, past, no email, booked inside the window",
    description: "Cancelled / no or invalid email never send; a booking made or rescheduled < 24 h out is not reminded; STOP edits don't count as rescheduling.",
    run: async () => {
      const now = before(12 * H);
      const r = (over: Partial<ReminderBooking>, at = now) => reason(decideReminder(booking(over), NY, at, on));
      return [
        check("cancelled → skipped", r({ status: "cancelled" }) === "cancelled"),
        check("started already → skipped", r({}, new Date(START.getTime() + 60_000)) === "past"),
        check("empty email → skipped", r({ email: "" }) === "no_email"),
        check("null email → skipped", r({ email: null }) === "no_email"),
        check("invalid email → skipped", r({ email: "not-an-email" }) === "no_email"),
        check("created 6 h before start (inside window) → skipped", r({ createdAt: before(6 * H), history: [] }, before(5 * H)) === "booked_in_window"),
        check("created 2 days ahead → sent", r({ createdAt: before(48 * H), history: [] }) === "send"),
        check("rescheduled 3 h before start → skipped (customer was just told)", r({ history: [{ at: "2030-06-01T12:00:00Z", action: "created" }, { at: before(3 * H).toISOString(), action: "rescheduled" }] }, before(2 * H)) === "booked_in_window"),
        check("rescheduled 3 days ahead → sent", r({ history: [{ at: before(72 * H).toISOString(), action: "rescheduled" }] }) === "send"),
        check("an sms_opt_out/sms_opt_in history entry inside the window does not suppress the reminder", r({ history: [{ at: "2030-06-01T12:00:00Z", action: "created" }, { at: before(10 * H).toISOString(), action: "sms_opt_out" }] }) === "send"),
      ];
    },
  },
  {
    id: "RM-007",
    name: "Reminder email content (email only)",
    description: "Business name, org-local date/time, reference and a contact-the-business note; no mention of texts/SMS/STOP.",
    run: async () => {
      const when = formatStart(START, NY);
      const m = reminderEmail({ customer: "Pat Example", id: "BK-1", resource: "Room A" }, "Acme Dental", when);
      const all = `${m.subject}\n${m.text}`;
      return [
        check("subject names the business and time", m.subject === "Reminder: your appointment with Acme Dental on Sat, Jun 15 at 10:00 AM EDT", m.subject),
        check("body has customer, business, time and reference", ["Pat Example", "Acme Dental", "Sat, Jun 15 at 10:00 AM EDT", "Reference: BK-1 · Room A"].every((s) => m.text.includes(s))),
        check("tells the customer to contact the business to reschedule or cancel", /contact Acme Dental directly/.test(m.text) && /reschedule or cancel/.test(m.text)),
        check("no mention of texts / SMS / STOP / HELP", !/\b(sms|texts?|texting|stop|help)\b/i.test(all), all.match(/\b(sms|texts?|texting|stop|help)\b/i)?.[0]),
        check("no reference suffix when there is no resource", !reminderEmail({ customer: "P", id: "BK-9" }, "B", when).text.includes("·")),
      ];
    },
  },
  {
    id: "RM-008",
    name: "Reminder logic has no SMS inputs",
    description: "The decision function only accepts id/status/email/date/time/createdAt/history: a phone number or SMS consent cannot change the outcome.",
    run: async () => {
      const base = decideReminder(booking(), NY, before(12 * H), on);
      const withSms = decideReminder({ ...booking(), phone: "+16105550134", smsConsent: true } as ReminderBooking, NY, before(12 * H), on);
      const noSms = decideReminder({ ...booking(), phone: null, smsConsent: false } as ReminderBooking, NY, before(12 * H), on);
      return [
        check("phone + consent present → same decision", base.send && withSms.send && base.key === withSms.key),
        check("no phone / no consent → still gets the email reminder", noSms.send),
      ];
    },
  },
];
