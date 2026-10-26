import { maskPhone, toE164 } from "@/lib/phone";
import { verifyTwilioSignature, smsKeyword } from "@/lib/server/webhooks/signatures";
import { applySmsKeyword, onceForEvent, publicRequestUrl } from "@/lib/server/webhooks/store";

/**
 * Twilio inbound SMS webhook (configure on the number / Messaging Service: POST https://<host>/api/webhooks/twilio/inbound).
 * Validates X-Twilio-Signature with TWILIO_AUTH_TOKEN, dedupes by MessageSid, and applies STOP / START to
 * sms_opt_out + booking.sms_consent. Replies with empty TwiML by default: Twilio's Advanced Opt-Out already
 * sends the compliant STOP/START/HELP replies. Set TWILIO_KEYWORD_REPLIES=true to reply from here instead.
 */
const twiml = (msg?: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg.replace(/[<>&]/g, "")}</Message>` : ""}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });

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
  const from = toE164(params.From);
  if (!sid || !from) return twiml();

  const kw = smsKeyword(params.Body, params.OptOutType);
  const r = await onceForEvent("twilio", `inbound:${sid}`, kw ? `sms.${kw.toLowerCase()}` : "sms.inbound", async (tx) =>
    kw === "STOP" || kw === "START" ? applySmsKeyword(tx, from, kw) : 0,
  );
  if (!r.duplicate && kw) console.log(`[twilio] inbound ${kw} from ${maskPhone(from)} — ${r.result} booking(s) updated`);

  if (process.env.TWILIO_KEYWORD_REPLIES?.trim().toLowerCase() === "true" && !r.duplicate) {
    if (kw === "HELP") return twiml("FlowOps appointment texts. Reply STOP to opt out. Msg & data rates may apply. Help: see flowopsagent.ai/sms-consent");
    if (kw === "STOP") return twiml("You're unsubscribed from FlowOps appointment texts. No more messages will be sent. Reply START to resubscribe.");
    if (kw === "START") return twiml("You're resubscribed to FlowOps appointment texts. Msg & data rates may apply. Reply STOP to opt out, HELP for help.");
  }
  return twiml();
}
