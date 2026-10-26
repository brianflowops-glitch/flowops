import { maskPhone } from "@/lib/phone";
import { recordNotificationFailure } from "@/lib/server/integrations/notification-failures";
import { verifyTwilioSignature } from "@/lib/server/webhooks/signatures";
import { onceForEvent, publicRequestUrl, recordDeliveryEvent } from "@/lib/server/webhooks/store";

/**
 * Twilio message StatusCallback (sent per message when TWILIO_STATUS_CALLBACK_URL is set; see sendSms).
 * Validates X-Twilio-Signature, dedupes by MessageSid + MessageStatus, appends to message_delivery_event,
 * and records + alerts a notification failure for `failed` / `undelivered`.
 */
export async function POST(req: Request) {
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!token) return new Response("Not configured", { status: 503 });
  const form = await req.formData().catch(() => null);
  if (!form) return new Response("Bad request", { status: 400 });
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
  if (!verifyTwilioSignature(token, publicRequestUrl(req), params, req.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const sid = params.MessageSid || params.SmsSid;
  const status = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
  if (!sid || !status) return new Response(null, { status: 204 });

  const errorCode = params.ErrorCode || null;
  const r = await onceForEvent("twilio", `status:${sid}:${status}`, `sms.${status}`, (tx) =>
    recordDeliveryEvent(tx, { provider: "twilio", messageId: sid, status, errorCode, detail: params.ErrorMessage || null }),
  );
  if (!r.duplicate && (status === "failed" || status === "undelivered")) {
    await recordNotificationFailure({
      channel: "sms",
      tag: `twilio:${sid}`,
      organizationId: null,
      target: maskPhone(params.To),
      failureKind: "undelivered",
      detail: `Twilio status ${status}${errorCode ? ` code ${errorCode}` : ""}`,
      attempts: 1,
    });
  }
  return new Response(null, { status: 204 });
}
