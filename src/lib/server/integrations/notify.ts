import "server-only";
import type { NotifierAdapter } from "@/lib/booking/types";
import { maskPhone, toE164 } from "@/lib/phone";

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
    const r = await sendEmail(to, subject, text, process.env.RESEND_REPLY_TO || undefined);
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

export async function sendEmail(to: string, subject: string, text: string, replyTo?: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || "FlowOps <onboarding@resend.dev>",
      to: [to],
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return { ok: false, detail: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const j = (await res.json()) as { id?: string };
  return { ok: true, detail: j.id ? `resend id ${j.id}` : undefined };
}

/** Send one SMS through the Twilio REST API. Never throws; failures are logged (no secrets, masked number) and returned. */
export async function sendSms(to: string, body: string, ref?: string): Promise<{ ok: boolean; detail?: string }> {
  const dest = toE164(to);
  const tag = `sms${ref ? ` ${ref}` : ""} to ${maskPhone(to)}`;
  if (!dest) {
    console.error(`[twilio] ${tag} not sent: invalid phone number`);
    return { ok: false, detail: "Twilio: invalid phone number" };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const params = new URLSearchParams({ To: dest, Body: body.slice(0, 600) });
  const mss = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (mss) params.set("MessagingServiceSid", mss);
  else params.set("From", twilioFrom()!);
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
      console.error(`[twilio] ${tag} failed — ${detail}`);
      return { ok: false, detail };
    }
    return { ok: true, detail: j.sid ? `twilio sid ${j.sid}${j.status ? ` (${j.status})` : ""}` : undefined };
  } catch (e) {
    const detail = `Twilio request failed: ${e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network error"}`;
    console.error(`[twilio] ${tag} failed — ${detail}`);
    return { ok: false, detail };
  }
}

/** SMS text: business name first (carrier requirement), short, with opt-out language. */
export function smsBody(subject: string, ref: string, businessName?: string) {
  return `${businessName ? `${businessName}: ` : ""}${subject}. Ref ${ref}. Reply STOP to opt out.`;
}

/** Real Notification Agent backend. Returns undefined when neither Resend nor Twilio is configured. */
export function notifierAdapter(opts: { businessName?: string } = {}): NotifierAdapter | undefined {
  const email = resendConfigured();
  const sms = twilioConfigured();
  if (!email && !sms) return undefined;
  return {
    channels: { email, sms },
    async send(b, subject, body, channel) {
      if (channel === "email") return sendEmail(b.email, subject, body, process.env.RESEND_REPLY_TO || undefined);
      return sendSms(b.phone!, smsBody(subject, b.id, opts.businessName), b.id);
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
