import "server-only";
import { randomUUID } from "node:crypto";
import { getDb, hasDatabase, schema } from "@/lib/db";
import type { FailureKind } from "./retry";
import { scrubDetail } from "./retry";

export interface NotificationFailure {
  channel: "sms" | "email";
  /** What the message was for, e.g. "booking:BK-123" or "account_email". No PII. */
  tag: string;
  organizationId?: string | null;
  /** Already-redacted target (maskPhone / maskEmail). */
  target: string;
  failureKind: FailureKind;
  detail: string;
  attempts: number;
}

/**
 * Persist a final notification failure and fire the ops alert. Never throws: a broken
 * failure log or alert destination must never break a booking or sign-in.
 * Written on its own pooled connection (outside the booking transaction) so the record
 * survives even if the caller's transaction later rolls back.
 */
export async function recordNotificationFailure(f: NotificationFailure): Promise<void> {
  const row = { ...f, detail: scrubDetail(f.detail), tag: f.tag.slice(0, 120) };
  if (hasDatabase()) {
    try {
      await getDb()
        .insert(schema.notificationFailure)
        .values({
          id: `NF-${randomUUID()}`,
          organizationId: row.organizationId ?? null,
          channel: row.channel,
          tag: row.tag,
          target: row.target,
          failureKind: row.failureKind,
          detail: row.detail,
          attempts: row.attempts,
        });
    } catch {
      console.error(`[notify] could not record ${row.channel} failure (${row.tag}) — database error`);
    }
  }
  await sendOpsAlert(row);
}

// Best-effort per-instance throttle so a provider outage doesn't fire one alert per booking.
const ALERT_WINDOW_MS = 5 * 60_000;
const lastAlertAt = new Map<string, number>();

export function alertConfigured() {
  return Boolean(process.env.ALERT_WEBHOOK_URL?.trim() || (process.env.ALERT_EMAIL?.trim() && process.env.RESEND_API_KEY));
}

/**
 * Ops alert for a final notification failure. Destinations (all optional; no-op when unset):
 * - ALERT_WEBHOOK_URL: POST JSON `{ text, ...fields }` (Slack/Discord-compatible `text`).
 * - ALERT_EMAIL: one or more comma-separated addresses, sent through Resend (needs RESEND_API_KEY).
 * The alert never contains message bodies, links, or unmasked contact details.
 */
export async function sendOpsAlert(f: NotificationFailure, now = Date.now()): Promise<{ webhook?: boolean; email?: boolean; throttled?: boolean }> {
  if (!alertConfigured()) return {};
  const key = `${f.channel}:${f.failureKind}:${f.detail.slice(0, 40)}`;
  const prev = lastAlertAt.get(key);
  if (prev && now - prev < ALERT_WINDOW_MS) return { throttled: true };
  lastAlertAt.set(key, now);

  const text =
    `FlowOps alert: ${f.channel.toUpperCase()} notification failed (${f.failureKind}) after ${f.attempts} attempt${f.attempts === 1 ? "" : "s"}` +
    ` · ${f.tag} · org ${f.organizationId ?? "n/a"} · to ${f.target} · ${f.detail}`;
  const out: { webhook?: boolean; email?: boolean } = {};

  const hook = process.env.ALERT_WEBHOOK_URL?.trim();
  if (hook) {
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source: "flowops", type: "notification_failure", ...f }),
        signal: AbortSignal.timeout(3_000),
      });
      out.webhook = res.ok;
      if (!res.ok) console.error(`[alert] webhook returned HTTP ${res.status}`);
    } catch {
      out.webhook = false;
      console.error("[alert] webhook request failed");
    }
  }

  const to = process.env.ALERT_EMAIL?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (to.length && process.env.RESEND_API_KEY) {
    // Direct Resend call (no retry, no failure recording) so a failing alert can't recurse.
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || "FlowOps <onboarding@resend.dev>",
          to,
          subject: `[FlowOps alert] ${f.channel} notification failed (${f.failureKind})`,
          text,
        }),
        signal: AbortSignal.timeout(3_000),
      });
      out.email = res.ok;
      if (!res.ok) console.error(`[alert] email returned HTTP ${res.status}`);
    } catch {
      out.email = false;
      console.error("[alert] email request failed");
    }
  }
  return out;
}
