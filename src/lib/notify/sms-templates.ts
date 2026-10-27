/**
 * Customer SMS text. Wording must match the A2P 10DLC campaign samples WORD FOR WORD
 * (resubmitted Oct 27, 2026). Do not change it without updating the campaign first.
 *
 *   Confirmation: "FlowOps: Your appointment with [Business Name] is confirmed for Tue Oct 27 at 10:00 AM. Reply STOP to opt out, HELP for help."
 *   Reschedule:   "FlowOps: Your appointment with [Business Name] has been rescheduled to Wed Oct 28 at 2:00 PM. Reply STOP to opt out, HELP for help."
 *   Cancellation: "FlowOps: Your appointment with [Business Name] on Tue Oct 27 at 10:00 AM has been cancelled. Reply STOP to opt out, HELP for help."
 *
 * Booking date/time are already stored in the business's local time (YYYY-MM-DD / HH:MM), so they
 * are formatted as-is, with no time-zone conversion (that would shift them).
 */

export type SmsKind = "confirmed" | "rescheduled" | "cancelled";

const OPT_OUT = "Reply STOP to opt out, HELP for help.";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-27" + "10:00" → "Tue Oct 27 at 10:00 AM" (business-local wall time). */
export function formatSmsWhen(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const ampm = hh < 12 ? "AM" : "PM";
  return `${DAYS[dow]} ${MONTHS[m - 1]} ${d} at ${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

/**
 * Which message a notification is, from the subject the booking engine writes
 * ("Booking confirmed: …", "Booking rescheduled: …", "Booking cancelled: …"). The sweeper only has the
 * stored subject, so this is the one shared source of truth for both first sends and re-sends.
 */
export function smsKindFromSubject(subject: string): SmsKind | null {
  const s = subject.trim().toLowerCase();
  if (s.startsWith("booking confirmed")) return "confirmed";
  if (s.startsWith("booking rescheduled")) return "rescheduled";
  if (s.startsWith("booking cancelled") || s.startsWith("booking canceled")) return "cancelled";
  return null;
}

const MAX_NAME = 40;

/**
 * Business names are free text set by any sign-up and go out from our shared number, so only a plain
 * name is ever put in a text. Anything that could carry a link, contact detail or a code (URL, domain,
 * email, phone number, 4+ digits in a row) drops the name entirely and the text says "Your appointment".
 * Line breaks and control characters are removed, whitespace collapsed, and the name capped at 40 chars.
 */
export function safeSmsBusinessName(raw?: string | null): string | null {
  if (!raw) return null;
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return null;
  const unsafe =
    /https?:|www\.|:\/\//i.test(name) ||
    /[a-z0-9-]\.(com|net|org|io|ai|co|ly|me|app|link|info|biz|xyz|us|gl|gd|to|cc|tk|site|online|click|top)\b/i.test(name) ||
    /\S@\S/.test(name) ||
    (name.match(/\d/g)?.length ?? 0) >= 7 || // phone number however it's punctuated
    /\d{4,}/.test(name); // codes, short codes
  if (unsafe) return null;
  return name.length > MAX_NAME ? name.slice(0, MAX_NAME).trimEnd() : name;
}

export function smsText(kind: SmsKind, b: { date: string; time: string }, businessName?: string | null): string {
  const name = safeSmsBusinessName(businessName);
  const appt = name ? `Your appointment with ${name}` : "Your appointment";
  const when = formatSmsWhen(b.date, b.time);
  switch (kind) {
    case "confirmed":
      return `FlowOps: ${appt} is confirmed for ${when}. ${OPT_OUT}`;
    case "rescheduled":
      return `FlowOps: ${appt} has been rescheduled to ${when}. ${OPT_OUT}`;
    case "cancelled":
      return `FlowOps: ${appt} on ${when} has been cancelled. ${OPT_OUT}`;
  }
}

/**
 * SMS body for a booking notification. Returns null for a subject that isn't one of the three
 * campaign messages, so callers never send text that carriers haven't approved.
 */
export function smsBodyFor(subject: string, b: { date: string; time: string }, businessName?: string | null): string | null {
  const kind = smsKindFromSubject(subject);
  return kind ? smsText(kind, b, businessName) : null;
}
