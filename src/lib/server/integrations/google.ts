import "server-only";
import type { Booking, CalendarAdapter } from "@/lib/booking/types";
import { decrypt } from "./crypto";

/** Google Calendar is available when the app has OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). */
export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "openid", "email"];

export function googleRedirectUri(origin: string) {
  return `${process.env.BETTER_AUTH_URL || origin}/api/integrations/google/callback`;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  return (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string };
}

async function accessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status}) — reconnect Google Calendar in Administration`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Adds minutes to a naive local "YYYY-MM-DD" + "HH:MM" and returns "YYYY-MM-DDTHH:MM:00". */
function localEnd(date: string, time: string, minutes: number) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60_000);
  return t.toISOString().slice(0, 16) + ":00";
}

function eventBody(b: Booking, timeZone: string) {
  return {
    summary: `${b.service} — ${b.customer}`,
    description: `FLOWOPS booking ${b.id}\nCustomer: ${b.customer} <${b.email}>${b.phone ? `\nPhone: ${b.phone}` : ""}\nResource: ${b.resource}${b.notes ? `\nNotes: ${b.notes}` : ""}`,
    location: b.resource,
    start: { dateTime: `${b.date}T${b.time}:00`, timeZone },
    end: { dateTime: localEnd(b.date, b.time, b.durationMin), timeZone },
  };
}

/** Real Calendar Agent backend for one organization's connected Google account. */
export function googleCalendarAdapter(org: { googleRefreshTokenEnc: string | null; googleCalendarId: string | null; timeZone: string }): CalendarAdapter | undefined {
  if (!googleConfigured() || !org.googleRefreshTokenEnc) return undefined;
  const cal = encodeURIComponent(org.googleCalendarId || "primary");
  const base = `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`;
  let token: string | null = null;
  const auth = async () => (token ??= await accessToken(decrypt(org.googleRefreshTokenEnc!)));
  const call = async (url: string, init: RequestInit) => {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await auth()}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    return res;
  };
  return {
    label: "Google Calendar",
    async create(b) {
      const res = await call(base, { method: "POST", body: JSON.stringify(eventBody(b, org.timeZone)) });
      if (!res.ok) throw new Error(`Google Calendar create failed (${res.status})`);
      return ((await res.json()) as { id: string }).id;
    },
    async update(b) {
      const res = await call(`${base}/${encodeURIComponent(b.calendarEventId!)}`, { method: "PATCH", body: JSON.stringify(eventBody(b, org.timeZone)) });
      if (res.status === 404 || res.status === 410) return this.create(b);
      if (!res.ok) throw new Error(`Google Calendar update failed (${res.status})`);
      return ((await res.json()) as { id: string }).id;
    },
    async remove(eventId) {
      const res = await call(`${base}/${encodeURIComponent(eventId)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google Calendar delete failed (${res.status})`);
    },
  };
}
