/**
 * Provider webhook signature checks + keyword parsing. Pure (node:crypto only) so `npm test` can cover them.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Twilio request validation (X-Twilio-Signature): base64(HMAC-SHA1(authToken, url + concat(sorted key+value)))
 * over the exact public URL Twilio called (including any query string) and the POSTed form params.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null) {
  if (!authToken || !header) return false;
  return safeEqual(twilioSignature(authToken, url, params), header);
}

/**
 * Resend webhooks are signed with Svix: headers svix-id, svix-timestamp, svix-signature ("v1,<base64> v1,<base64>…").
 * Signed content = `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 keyed with base64-decoded secret (after "whsec_").
 * Rejects timestamps more than `toleranceSec` (default 5 min) from now (replay protection).
 */
export function svixSignature(secret: string, id: string, timestamp: string, body: string) {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function verifySvix(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "not configured" };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = svixSignature(secret, id, timestamp, body);
  const ok = signature
    .split(" ")
    .map((s) => s.trim())
    .some((s) => s.startsWith("v1,") && safeEqual(s.slice(3), expected));
  return ok ? { ok: true } : { ok: false, reason: "bad signature" };
}

// CTIA / Twilio default opt-out keywords.
const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START = new Set(["START", "YES", "UNSTOP"]);
const HELP = new Set(["HELP", "INFO"]);

/** Classify an inbound SMS. Prefers Twilio's OptOutType (Advanced Opt-Out), else exact single-keyword match. */
export function smsKeyword(body: string | null | undefined, optOutType?: string | null): "STOP" | "START" | "HELP" | null {
  const t = optOutType?.trim().toUpperCase();
  if (t === "STOP" || t === "START" || t === "HELP") return t;
  const w = (body ?? "").trim().toUpperCase().replace(/[.!\s]+$/g, "");
  if (STOP.has(w)) return "STOP";
  if (START.has(w)) return "START";
  if (HELP.has(w)) return "HELP";
  return null;
}
