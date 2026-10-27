/**
 * Email-only appointment reminders: pure decision + formatting logic (no DB, no server-only, no network), so
 * `npm run test:sim` covers it. The DB/send side lives in ./run.ts.
 *
 * Bookings store `date` (YYYY-MM-DD) and `time` (HH:MM) as the organization's local wall clock, so the start
 * instant is computed in `organization.time_zone` (DST-aware) before comparing with "now".
 *
 * EMAIL ONLY. Nothing here reads a phone number, SMS consent, or sends/queues a text.
 */
import { localStamp } from "@/lib/booking/engine";

export interface ReminderConfig {
  enabled: boolean;
  /** Send once the appointment is at most this far away (default 24 h). */
  leadMs: number;
  /** …but never when it starts sooner than this (default 30 min): too close to be useful. */
  minLeadMs: number;
}

const HOUR = 3_600_000;
const MIN = 60_000;

/**
 * EMAIL_REMINDERS_ENABLED=true turns the feature on (anything else = off, identical to today).
 * EMAIL_REMINDER_LEAD_HOURS (default 24, clamped 1–72) and EMAIL_REMINDER_MIN_LEAD_MINUTES (default 30) tune the window.
 */
export function reminderConfig(env: Record<string, string | undefined> = process.env): ReminderConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v?.trim());
    return v?.trim() && Number.isFinite(n) ? n : d;
  };
  const leadHours = Math.min(72, Math.max(1, num(env.EMAIL_REMINDER_LEAD_HOURS, 24)));
  const minLeadMin = Math.min(leadHours * 60 - 1, Math.max(0, num(env.EMAIL_REMINDER_MIN_LEAD_MINUTES, 30)));
  return { enabled: env.EMAIL_REMINDERS_ENABLED?.trim().toLowerCase() === "true", leadMs: leadHours * HOUR, minLeadMs: minLeadMin * MIN };
}

/** Wall-clock stamp of an instant in `timeZone`, read back as if it were UTC (ms). */
function wallMs(instant: number, timeZone: string): number {
  return Date.parse(`${localStamp(new Date(instant), timeZone)}:00Z`);
}

/**
 * The UTC instant at which the org-local wall clock `date` `time` happens in `timeZone`. DST-aware: two correction
 * passes handle zones whose offset differs at the guess and at the answer. Ambiguous (fall-back) times resolve to a
 * single deterministic instant; times that don't exist (spring-forward gap) resolve to a nearby instant.
 * Returns null for a malformed date/time or an unknown zone.
 */
export function startsAtInZone(date: string, time: string, timeZone: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  if (!Number.isFinite(target)) return null;
  try {
    const zone = timeZone || "UTC";
    let guess = target;
    for (let i = 0; i < 3; i++) guess -= wallMs(guess, zone) - target;
    return new Date(guess);
  } catch {
    return null;
  }
}

/** Deterministic exactly-once key. The start instant is part of it, so a rescheduled booking gets a fresh reminder. */
export function reminderKey(bookingId: string, startsAt: Date): string {
  return `reminder-${bookingId}-${startsAt.toISOString()}`;
}

export interface ReminderBooking {
  id: string;
  status: string;
  email: string | null | undefined;
  date: string;
  time: string;
  createdAt: Date;
  history?: { at: string; action: string }[] | null;
}

export type ReminderDecision =
  | { send: true; startsAt: Date; key: string }
  | { send: false; reason: "disabled" | "cancelled" | "no_email" | "bad_start" | "past" | "too_close" | "too_far" | "booked_in_window" };

/** When the customer was last told this slot: the later of creation and any reschedule (STOP/START edits don't count). */
export function slotSetAt(b: Pick<ReminderBooking, "createdAt" | "history">): number {
  let at = b.createdAt.getTime();
  for (const h of b.history ?? []) {
    if (h.action !== "rescheduled") continue;
    const t = Date.parse(h.at);
    if (Number.isFinite(t) && t > at) at = t;
  }
  return at;
}

/**
 * Should this booking get a reminder email right now?
 * Sends only for a confirmed booking with an email whose start is in (now + minLead, now + lead], and whose slot was not
 * set inside the lead window (a customer who booked or rescheduled < 24 h out was just told; no reminder on top).
 */
export function decideReminder(b: ReminderBooking, timeZone: string | null | undefined, now: Date, cfg: ReminderConfig): ReminderDecision {
  if (!cfg.enabled) return { send: false, reason: "disabled" };
  if (b.status !== "confirmed") return { send: false, reason: "cancelled" };
  if (!b.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) return { send: false, reason: "no_email" };
  const startsAt = startsAtInZone(b.date, b.time, timeZone);
  if (!startsAt) return { send: false, reason: "bad_start" };
  const until = startsAt.getTime() - now.getTime();
  if (until <= 0) return { send: false, reason: "past" };
  if (until < cfg.minLeadMs) return { send: false, reason: "too_close" };
  if (until > cfg.leadMs) return { send: false, reason: "too_far" };
  if (slotSetAt(b) > startsAt.getTime() - cfg.leadMs) return { send: false, reason: "booked_in_window" };
  return { send: true, startsAt, key: reminderKey(b.id, startsAt) };
}

/** "Tue, Oct 27 at 10:00 AM EDT" — the instant rendered in the business's own zone. */
export function formatStart(startsAt: Date, timeZone: string | null | undefined): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    })
      .formatToParts(startsAt)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

/** Reminder email. Mentions the business, local date/time, reference, and how to change it. No mention of texts. */
export function reminderEmail(b: { customer: string; id: string; resource?: string | null }, businessName: string, when: string) {
  return {
    subject: `Reminder: your appointment with ${businessName} on ${when}`,
    text:
      `Hi ${b.customer},\n\n` +
      `This is a reminder of your upcoming appointment with ${businessName}:\n\n` +
      `When: ${when}\n` +
      `Reference: ${b.id}${b.resource ? ` · ${b.resource}` : ""}\n\n` +
      `Need to reschedule or cancel? Please contact ${businessName} directly and quote your reference.\n\n` +
      `— Sent by FLOWOPS`,
  };
}
