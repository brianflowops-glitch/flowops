import { recordNotificationFailure } from "@/lib/server/integrations/notification-failures";
import { maskEmail } from "@/lib/server/integrations/retry";
import { verifySvix } from "@/lib/server/webhooks/signatures";
import { onceForEvent, recordDeliveryEvent } from "@/lib/server/webhooks/store";

/**
 * Resend webhook (add in Resend → Webhooks: POST https://<host>/api/webhooks/resend). Verifies the Svix signature
 * with RESEND_WEBHOOK_SECRET (whsec_…), dedupes by svix-id, appends to message_delivery_event, and records +
 * alerts a notification failure for bounces, complaints and failures. Open/click events are ignored.
 */
type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string; subType?: string; message?: string }; failed?: { reason?: string } };
};

const PROBLEM = new Set(["email.bounced", "email.complained", "email.failed"]);
const IGNORED = new Set(["email.opened", "email.clicked"]);

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return new Response("Not configured", { status: 503 });
  const body = await req.text();
  const h = { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") };
  const v = verifySvix(secret, h, body);
  if (!v.ok) return new Response("Invalid signature", { status: 401 });

  let evt: ResendEvent;
  try {
    evt = JSON.parse(body) as ResendEvent;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const type = evt.type ?? "unknown";
  const emailId = evt.data?.email_id;
  if (!emailId || IGNORED.has(type)) return new Response(null, { status: 204 });

  const detail = evt.data?.bounce
    ? `bounce ${evt.data.bounce.type ?? ""}${evt.data.bounce.subType ? `/${evt.data.bounce.subType}` : ""}: ${evt.data.bounce.message ?? ""}`
    : (evt.data?.failed?.reason ?? null);
  const r = await onceForEvent("resend", h.id!, type, (tx) =>
    recordDeliveryEvent(tx, { provider: "resend", messageId: emailId, status: type, detail, occurredAt: evt.created_at ? new Date(evt.created_at) : null }),
  );
  if (!r.duplicate && PROBLEM.has(type)) {
    const to = Array.isArray(evt.data?.to) ? evt.data?.to[0] : evt.data?.to;
    await recordNotificationFailure({
      channel: "email",
      tag: `resend:${emailId}`,
      organizationId: null,
      target: maskEmail(to),
      failureKind: type === "email.complained" ? "complained" : type === "email.bounced" ? "bounced" : "undelivered",
      detail: `Resend ${type}${detail ? ` — ${detail}` : ""}`,
      attempts: 1,
    });
  }
  return new Response(null, { status: 204 });
}
