import "server-only";
import type { NotifierAdapter } from "@/lib/booking/types";

export function resendConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}
export function twilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID));
}

/** Best-effort E.164: 10 US digits → +1XXXXXXXXXX; keeps an explicit +country code. */
export function toE164(phone: string) {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function sendEmail(to: string, subject: string, text: string, replyTo?: string) {
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

async function sendSms(to: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const params = new URLSearchParams({ To: toE164(to), Body: body.slice(0, 600) });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) params.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else params.set("From", process.env.TWILIO_FROM_NUMBER!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return { ok: false, detail: `Twilio ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const j = (await res.json()) as { sid?: string };
  return { ok: true, detail: j.sid ? `twilio sid ${j.sid}` : undefined };
}

/** Real Notification Agent backend. Returns undefined when neither Resend nor Twilio is configured. */
export function notifierAdapter(): NotifierAdapter | undefined {
  const email = resendConfigured();
  const sms = twilioConfigured();
  if (!email && !sms) return undefined;
  return {
    channels: { email, sms },
    async send(b, subject, body, channel) {
      if (channel === "email") return sendEmail(b.email, subject, body, process.env.RESEND_REPLY_TO || undefined);
      return sendSms(b.phone!, `${subject}. Ref ${b.id}. — FLOWOPS`);
    },
  };
}

export function integrationStatus() {
  return {
    googleCalendar: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    resendEmail: resendConfigured(),
    resendFrom: Boolean(process.env.RESEND_FROM_EMAIL),
    twilioSms: twilioConfigured(),
  };
}
