/**
 * Webhook signature + keyword unit tests (WH-001 … WH-003). Expected signatures were produced with the official
 * `twilio` (6.2.0, getExpectedTwilioSignature) and `svix` (1.99.1, Webhook.sign) libraries.
 */
import type { Assertion, TestCase } from "@/lib/booking/tests";
import { toE164 } from "@/lib/phone";
import { smsKeyword, twilioSignature, verifySvix, verifyTwilioSignature } from "./signatures";

const check = (label: string, pass: boolean, detail?: string): Assertion => ({ label, pass, detail });

const TW_URL = "https://flowopsagent.ai/api/webhooks/twilio/inbound";
const TW_PARAMS = { MessageSid: "SM123", From: "+16105550134", Body: "STOP", To: "+16105550100", OptOutType: "STOP" };
const SECRET = "whsec_c3VwZXJzZWNyZXRrZXktMDEyMzQ1Njc4OWFiY2RlZg==";
const BODY = '{"type":"email.bounced","data":{"email_id":"e1"}}';
const TS = 1793040000;

export const WEBHOOK_TEST_CASES: TestCase[] = [
  {
    id: "WH-001",
    name: "Twilio signature validation",
    description: "Matches the official twilio library; rejects wrong token, tampered params and missing header.",
    run: async () => {
      const sig = "sgtp1lOXuq+k8sVLouNXjt1vErQ=";
      return [
        check("matches twilio lib", twilioSignature("authtok123", TW_URL, TW_PARAMS) === sig, twilioSignature("authtok123", TW_URL, TW_PARAMS)),
        check("verifies", verifyTwilioSignature("authtok123", TW_URL, TW_PARAMS, sig)),
        check("wrong token rejected", !verifyTwilioSignature("other", TW_URL, TW_PARAMS, sig)),
        check("tampered body rejected", !verifyTwilioSignature("authtok123", TW_URL, { ...TW_PARAMS, Body: "START" }, sig)),
        check("missing header rejected", !verifyTwilioSignature("authtok123", TW_URL, TW_PARAMS, null)),
      ];
    },
  },
  {
    id: "WH-002",
    name: "Resend (Svix) signature verification",
    description: "Accepts a svix-lib signature (incl. multi-signature header); rejects tampering, stale timestamps, missing secret.",
    run: async () => {
      const sig = "v1,2l1QhCajmpmooc9B1VZTdXb3r829ECeugMf+d6YLVLk=";
      const h = { id: "msg_abc", timestamp: String(TS), signature: sig };
      return [
        check("valid", verifySvix(SECRET, h, BODY, TS).ok),
        check("multi-signature header", verifySvix(SECRET, { ...h, signature: `v1,AAAA ${sig}` }, BODY, TS).ok),
        check("tampered body rejected", !verifySvix(SECRET, h, BODY + " ", TS).ok),
        check("stale (>5 min) rejected", !verifySvix(SECRET, h, BODY, TS + 301).ok),
        check("no secret rejected", !verifySvix("", h, BODY, TS).ok),
      ];
    },
  },
  {
    id: "WH-003",
    name: "STOP / START / HELP keywords",
    description: "OptOutType wins; exact keyword match only (a sentence containing 'stop' is not an opt-out).",
    run: async () => [
      check("STOP variants", ["stop", "Stop.", " UNSUBSCRIBE ", "cancel", "quit"].every((b) => smsKeyword(b) === "STOP")),
      check("START / HELP", smsKeyword("start") === "START" && smsKeyword("unstop") === "START" && smsKeyword("help") === "HELP" && smsKeyword("INFO") === "HELP"),
      check("OptOutType preferred", smsKeyword("anything", "STOP") === "STOP"),
      check("sentences ignored", smsKeyword("please don't stop texting me") === null && smsKeyword("") === null),
    ],
  },
  {
    id: "WH-004",
    name: "Stored phone formats normalize to Twilio's From",
    description: "Bookings may store phones as typed; STOP/START match on E.164 (SQL mirror verified in npm run test:db).",
    run: async () => {
      const formats = ["610-555-0134", "(610) 555-0134", "610 555 0134", "+1 610 555 0134", "+16105550134", "1-610-555-0134", "610.555.0134", "610-555-0134 ext 12"];
      const bad = formats.filter((f) => toE164(f) !== "+16105550134");
      return [check("all formats → +16105550134", bad.length === 0, bad.join(" | ") || undefined)];
    },
  },
];
