import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

/**
 * "Automations executed per week" for one organization, from rows the app already writes (no telemetry, no migration):
 *
 * - bookingRuns: booking pipeline runs that completed end to end (create / reschedule / cancel). The Audit Agent writes
 *   exactly one `audit_entry` row with agent = 'AuditAgent' and outcome = 'success' per such run, whether it came from
 *   the dashboard, FlowAI or the public booking page. Halted runs (conflict / invalid / failed), post-save warnings and
 *   admin actions such as `member.removed` are not counted.
 * - reminders: appointment reminder emails actually sent by the reminders cron (`notification` rows with a
 *   `reminder-…` dedupe key and delivery_status = 'sent'). Confirmation emails/texts sent during a booking run are
 *   part of that run, so they are not counted again.
 *
 * Weeks start on Monday in the organization's time zone; the current (partial) week is last. Every row is scoped by
 * organization_id.
 */
export const TREND_WEEKS = 12;

export interface AutomationWeek {
  /** Monday of the week, YYYY-MM-DD in the org's time zone. */
  weekStart: string;
  bookingRuns: number;
  reminders: number;
  total: number;
}

export interface AutomationTrend {
  timeZone: string;
  weeks: AutomationWeek[];
  total: number;
}

async function query(orgId: string, timeZone: string, now: Date, weeks: number): Promise<AutomationWeek[]> {
  const res = await getDb().execute<{ week_start: string; booking_runs: number; reminders: number }>(sql`
    with weeks as (
      select generate_series(
        date_trunc('week', ${now.toISOString()}::timestamptz at time zone ${timeZone}) - make_interval(weeks => ${weeks - 1}),
        date_trunc('week', ${now.toISOString()}::timestamptz at time zone ${timeZone}),
        interval '1 week'
      ) as wk
    ),
    bounds as (select min(wk) at time zone ${timeZone} as since from weeks),
    runs as (
      select date_trunc('week', a.at at time zone ${timeZone}) as wk, count(*)::int as n
      from audit_entry a, bounds
      where a.organization_id = ${orgId}
        and a.agent = 'AuditAgent'
        and a.outcome = 'success'
        and a.action in ('create', 'reschedule', 'cancel')
        and a.at >= bounds.since
        and a.at <= ${now.toISOString()}::timestamptz
      group by 1
    ),
    rem as (
      select date_trunc('week', n.at at time zone ${timeZone}) as wk, count(*)::int as n
      from notification n, bounds
      where n.organization_id = ${orgId}
        and n.dedupe_key like 'reminder-%'
        and n.delivery_status = 'sent'
        and n.at >= bounds.since
        and n.at <= ${now.toISOString()}::timestamptz
      group by 1
    )
    select to_char(w.wk, 'YYYY-MM-DD') as week_start,
           coalesce(r.n, 0)::int as booking_runs,
           coalesce(m.n, 0)::int as reminders
    from weeks w
    left join runs r on r.wk = w.wk
    left join rem m on m.wk = w.wk
    order by w.wk`);
  return res.rows.map((r) => {
    const bookingRuns = Number(r.booking_runs);
    const reminders = Number(r.reminders);
    return { weekStart: r.week_start, bookingRuns, reminders, total: bookingRuns + reminders };
  });
}

export async function automationTrend(org: { id: string; timeZone: string }, opts: { now?: Date; weeks?: number } = {}): Promise<AutomationTrend> {
  const now = opts.now ?? new Date();
  const weeks = Math.min(Math.max(Math.trunc(opts.weeks ?? TREND_WEEKS), 1), 52);
  let timeZone = org.timeZone || "UTC";
  let rows: AutomationWeek[];
  try {
    rows = await query(org.id, timeZone, now, weeks);
  } catch (e) {
    // An unknown zone name makes Postgres throw; fall back to UTC rather than failing the page.
    if (timeZone === "UTC") throw e;
    timeZone = "UTC";
    rows = await query(org.id, timeZone, now, weeks);
  }
  return { timeZone, weeks: rows, total: rows.reduce((s, w) => s + w.total, 0) };
}
