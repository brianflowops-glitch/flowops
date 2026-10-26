import "server-only";
import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { NotifierAdapter } from "@/lib/booking/types";
import { maskPhone, toE164 } from "@/lib/phone";
import { isSmsOptedOut } from "@/lib/server/webhooks/store";
import { recordNotificationFailure } from "./notification-failures";
import { type AttemptOutcome, type FailureKind, maskEmail, parseRetryAfter, withRetry } from "./retry";

/** Where a send came from, for the failure log / alert. Never put PII in `tag`. */
export interface SendMeta {
  tag?: string;
  organizationId?: string | null;
}

/** Record a final failure + alert without blocking the caller (kept alive past the response on Vercel). */
function reportFailure(channel: "sms" | "email", target: string, meta: SendMeta | undefined, r: { detail: string; attempts: number; failureKind: FailureKind }) {
  const p = recordNotificationFailure({
    channel,
    tag: meta?.tag ?? `${channel}`,
    organizationId: meta?.organizationId ?? null,
    target,
    failureKind: r.failureKind,
    detail: r.detail,
    attempts: r.attempts,
  });
  waitUntil(p);
}

export function resendConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}
/**
 * REQUIRE_EMAIL_VERIFICATION=true blocks sign-in until the email is verified — but only once
 * Resend can actually deliver the verification email, so nobody gets locked out while email is simulated.
 */
export function emailVerificationRequired() {
  return process.env.REQUIRE_EMAIL_VERIFICATION?.trim().toLowerCase() === "true" && resendConfigured();
}

/**
 * Account emails (verification, password reset, invites). Real via Resend when configured;
 * otherwise nothing is sent and nothing is logged (links carry secrets).
 */
export async function sendAccountEmail(to: string, subject: string, text: string): Promise<{ sent: boolean; detail?: string }> {
  if (!resendConfigured()) return { sent: false, detail: "email simulated (Resend not configured)" };
  try {
    const r = await sendEmail(to, subject, text, process.env.RESEND_REPLY_TO || undefined, { tag: "account_email" });
    if (!r.ok) console.error("account email failed:", r.detail?.replace(/https?:\/\/\S+/g, "[link]"));
    return { sent: r.ok, detail: r.ok ? undefined : "email delivery failed" };
  } catch {
    console.error("account email failed: network error");
    return { sent: false, detail: "email delivery failed" };
  }
}

/** Account SID + Auth Token are set (credentials only — may still lack a sending number). */
export function twilioCredentialsSet() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID?.trim() && process.env.TWILIO_AUTH_TOKEN?.trim());
}
/** Real SMS needs credentials AND a sender (TWILIO_FROM_NUMBER or a Messaging Service). */
export function twilioConfigured() {
  return twilioCredentialsSet() && Boolean(twilioFrom() || process.env.TWILIO_MESSAGING_SERVICE_SID?.trim());
}
function twilioFrom() {
  const raw = process.env.TWILIO_FROM_NUMBER?.trim();
  return raw ? (toE164(raw) ?? raw) : null;
}
function twilioAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID!.trim()}:${process.env.TWILIO_AUTH_TOKEN!.trim()}`).toString("base64")}`;
}

/**
 * Send one email through Resend, retrying transient failures (network, 429, 5xx) up to 3 attempts.
 * Every attempt carries the same Resend `Idempotency-Key`, so a retry after a timeout can't double-send.
 * Never throws. A final failure is recorded in notification_failure and alerted (see notification-failures.ts).
 */
export async function sendEmail(to: string, subject: string, text: string, replyTo?: string, meta?: SendMeta): Promise<{ ok: boolean; detail?: string }> {
  const idempotencyKey = `flowops-${randomUUID()}`;
  const payload = JSON.stringify({
    from: process.env.RESEND_FROM_EMAIL || "FlowOps <onboarding@resend.dev>",
    to: [to],
    subject,
    text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });
  const r = await withRetry(
    async (): Promise<AttemptOutcome> => {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: payload,
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) {
          return {
            kind: "http",
            status: res.status,
            detail: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
            retryAfterSec: parseRetryAfter(res.headers.get("retry-after")),
          };
        }
        const j = (await res.json().catch(() => ({}))) as { id?: string };
        return { kind: "ok", detail: j.id ? `resend id ${j.id}` : undefined };
      } catch (e) {
        return { kind: "error", error: e, detail: `Resend request failed: ${e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network error"}` };
      }
    },
    { ambiguousRetrySafe: true },
  );
  if (r.ok) return { ok: true, detail: r.detail };
  const detail = r.attempts > 1 ? `${r.detail} (after ${r.attempts} attempts)` : r.detail;
  reportFailure("email", maskEmail(to), meta, r);
  return { ok: false, detail };
}

/**
 * Send one SMS through the Twilio REST API. Never throws; failures are logged (no secrets, masked number) and returned.
 * Retries (up to 3 attempts, exponential backoff) only when Twilio definitely did NOT accept the message:
 * HTTP 429/5xx, or a connection error before the request was sent. Timeouts/resets are NOT retried
 * (Twilio has no idempotency key for Messages, so a retry could double-text the customer).
 * A final failure is recorded in notification_failure and alerted.
 */
export async function sendSms(to: string, body: string, ref?: string, meta?: SendMeta): Promise<{ ok: boolean; detail?: string }> {
  const dest = toE164(to);
  const tag = `sms${ref ? ` ${ref}` : ""} to ${maskPhone(to)}`;
  const failMeta: SendMeta = { tag: meta?.tag ?? (ref ? `booking:${ref}` : "sms"), organizationId: meta?.organizationId };
  if (!dest) {
    console.error(`[twilio] ${tag} not sent: invalid phone number`);
    reportFailure("sms", maskPhone(to), failMeta, { detail: "invalid phone number", attempts: 0, failureKind: "permanent" });
    return { ok: false, detail: "Twilio: invalid phone number" };
  }
  if (await isSmsOptedOut(dest)) {
    // Customer replied STOP (see /api/webhooks/twilio/inbound). Not an ops failure, so no alert.
    console.error(`[twilio] ${tag} not sent: customer opted out (STOP)`);
    return { ok: false, detail: "Twilio: not sent — customer has opted out (replied STOP)" };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const params = new URLSearchParams({ To: dest, Body: body.slice(0, 600) });
  const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL?.trim();
  if (statusCallback) params.set("StatusCallback", statusCallback);
  const mss = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (mss) params.set("MessagingServiceSid", mss);
  else params.set("From", twilioFrom()!);
  const r = await withRetry(async (n): Promise<AttemptOutcome> => {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: twilioAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(8_000),
      });
      const j = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
      if (!res.ok) {
        // Common codes: 21608/21219 trial → unverified number, 21610 recipient replied STOP, 21211 invalid To, 21606/21659 bad From.
        const hint =
          j.code === 21610
            ? " (customer has opted out — replied STOP)"
            : j.code === 21608 || j.code === 21219
              ? " (trial account: can only text verified numbers)"
              : "";
        const detail = `Twilio ${res.status}${j.code ? ` code ${j.code}` : ""}: ${(j.message ?? "error").slice(0, 160)}${hint}`;
        console.error(`[twilio] ${tag} failed (attempt ${n}) — ${detail}`);
        return { kind: "http", status: res.status, detail, retryAfterSec: parseRetryAfter(res.headers.get("retry-after")) };
      }
      return { kind: "ok", detail: j.sid ? `twilio sid ${j.sid}${j.status ? ` (${j.status})` : ""}` : undefined };
    } catch (e) {
      const detail = `Twilio request failed: ${e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network error"}`;
      console.error(`[twilio] ${tag} failed (attempt ${n}) — ${detail}`);
      return { kind: "error", error: e, detail };
    }
  });
  if (r.ok) return { ok: true, detail: r.detail };
  reportFailure("sms", maskPhone(to), failMeta, r);
  const suffix = r.failureKind === "ambiguous" ? " (not retried: Twilio may have accepted it)" : r.attempts > 1 ? ` (after ${r.attempts} attempts)` : "";
  return { ok: false, detail: `${r.detail}${suffix}` };
}

/** SMS text: business name first (carrier requirement), short, with opt-out language. */
export function smsBody(subject: string, ref: string, businessName?: string) {
  return `${businessName ? `${businessName}: ` : ""}${subject}. Ref ${ref}. Reply STOP to opt out.`;
}

/** Real Notification Agent backend. Returns undefined when neither Resend nor Twilio is configured. */
export function notifierAdapter(opts: { businessName?: string; organizationId?: string } = {}): NotifierAdapter | undefined {
  const email = resendConfigured();
  const sms = twilioConfigured();
  if (!email && !sms) return undefined;
  return {
    channels: { email, sms },
    async send(b, subject, body, channel) {
      const meta: SendMeta = { tag: `booking:${b.id}`, organizationId: opts.organizationId };
      if (channel === "email") return sendEmail(b.email, subject, body, process.env.RESEND_REPLY_TO || undefined, meta);
      return sendSms(b.phone!, smsBody(subject, b.id, opts.businessName), b.id, meta);
    },
  };
}

export type SmsMode = "live" | "trial" | "needs_number" | "not_set" | "error";
let twilioCache: { at: number; key: string; type: string | null; status: string | null; ok: boolean } | null = null;

/** Twilio account type/status (Trial vs Full), cached 10 min. Read-only call; never sends anything. */
async function twilioAccount() {
  const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const key = `${sid}:${process.env.TWILIO_FROM_NUMBER ?? ""}`;
  if (twilioCache && twilioCache.key === key && Date.now() - twilioCache.at < 600_000) return twilioCache;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: { Authorization: twilioAuthHeader() },
      signal: AbortSignal.timeout(3_000),
    });
    const j = (await res.json().catch(() => ({}))) as { type?: string; status?: string };
    if (!res.ok) console.error(`[twilio] account check failed — HTTP ${res.status}`);
    twilioCache = { at: Date.now(), key, type: j.type ?? null, status: j.status ?? null, ok: res.ok };
  } catch {
    console.error("[twilio] account check failed — network error");
    twilioCache = { at: Date.now() - 540_000, key, type: null, status: null, ok: false }; // retry in ~1 min
  }
  return twilioCache;
}

export async function smsStatus(): Promise<{ mode: SmsMode; fromNumber: string | null; accountStatus: string | null }> {
  const fromNumber = twilioFrom();
  if (!twilioCredentialsSet()) return { mode: "not_set", fromNumber, accountStatus: null };
  const acct = await twilioAccount();
  if (!acct.ok || (acct.status && acct.status !== "active")) return { mode: "error", fromNumber, accountStatus: acct.status };
  if (!twilioConfigured()) return { mode: "needs_number", fromNumber, accountStatus: acct.status };
  return { mode: acct.type === "Trial" ? "trial" : "live", fromNumber, accountStatus: acct.status };
}

export async function integrationStatus() {
  const sms = await smsStatus();
  return {
    smsMode: sms.mode,
    smsFrom: sms.fromNumber,
    googleCalendar: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    resendEmail: resendConfigured(),
    resendFrom: Boolean(process.env.RESEND_FROM_EMAIL),
    twilioSms: twilioConfigured(),
    emailVerificationRequired: emailVerificationRequired(),
  };
}
