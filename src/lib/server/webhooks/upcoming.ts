/**
 * "Is this booking still upcoming?" in the business's own time zone. Bookings store `date` (YYYY-MM-DD) and `time`
 * (HH:MM) as the org's local wall clock, so they are compared with "now" rendered in organization.time_zone — the
 * same rule the booking engine uses to reject times in the past. Pure (no DB, no server-only) so `npm test` covers it.
 */
import { localStamp } from "@/lib/booking/engine";

/** True when the booking's start (org-local) is at or after the current org-local minute. */
export function isUpcomingInZone(date: string, time: string, timeZone: string | null | undefined, now: Date = new Date()): boolean {
  let local: string;
  try {
    local = localStamp(now, timeZone || "UTC");
  } catch {
    // Unknown zone (time_zone is validated on save, so only legacy/bad rows land here): fall back to the
    // previous date-only rule against UTC rather than failing the whole STOP/START webhook.
    return date >= now.toISOString().slice(0, 10);
  }
  return `${date}T${time}` >= local;
}

/**
 * Coarse SQL prefilter for START candidates: a booking dated before this (UTC date minus 2 days) cannot be upcoming
 * in any zone (none is more than ~12h behind UTC), so the exact per-zone check only runs on recent/future rows.
 */
export function startPrefilterDate(now: Date = new Date()): string {
  return new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
}
