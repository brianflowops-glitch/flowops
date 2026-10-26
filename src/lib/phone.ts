/**
 * Basic E.164 normalization, US-first (shared by server and client).
 * - 10 digits (NANP: area code and exchange start 2–9) → +1XXXXXXXXXX
 * - 11 digits starting with 1 → +1XXXXXXXXXX
 * - "+<country><number>" with 8–15 digits is kept as-is (non-US is passed through, not validated further)
 * Returns null when the input can't be a dialable number.
 */
export function toE164(phone: string | null | undefined): string | null {
  const trimmed = (phone ?? "").trim();
  if (!trimmed) return null;
  if (/[a-z]/i.test(trimmed.replace(/(ext\.?|x)\s*\d+$/i, ""))) return null;
  const main = trimmed.replace(/\s*(ext\.?|x)\s*\d+$/i, ""); // drop an extension
  const digits = main.replace(/\D/g, "");
  const nanp = (d: string) => /^[2-9]\d{2}[2-9]\d{6}$/.test(d);
  if (main.startsWith("+")) {
    if (digits.startsWith("1")) return digits.length === 11 && nanp(digits.slice(1)) ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10 && nanp(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && nanp(digits.slice(1))) return `+${digits}`;
  return null;
}

/** "+16105551234" → "•••1234" for logs. */
export function maskPhone(phone: string | null | undefined) {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `•••${d.slice(-4)}` : "•••";
}

export const SMS_CONSENT_TEXT =
  "Yes, text me about this appointment (FlowOps texts: confirmations, reschedules, cancellations and reminders). Consent is not required to book. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.";
