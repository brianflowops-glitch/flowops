/**
 * Webhook signature + keyword unit tests (WH-001 … WH-003), phone normalization (WH-004), time-zone-aware START
 * (WH-005) and the 0007 phone index matching the STOP/START expression (WH-006). Expected signatures were produced with the official
 * `twilio` (6.2.0, getExpectedTwilioSignature) and `svix` (1.99.1, Webhook.sign) libraries.
 */
import type { Assertion, TestCase } from "@/lib/booking/tests";
import { toE164 } from "@/lib/phone";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { phoneE164Sql } from "@/lib/db/phone-sql";
import { smsKeyword, twilioSignature, verifySvix, verifyTwilioSignature } from "./signatures";
import { isUpcomingInZone, startPrefilterDate } from "./upcoming";

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
  {
    id: "WH-005",
    name: "START restores only bookings upcoming in the business's time zone",
    description: "Booking date/time are org-local; 'upcoming' compares them to now in organization.time_zone, not UTC or server time.",
    run: async () => {
      // 2030-06-15 03:30 UTC = 2030-06-14 23:30 in New York, 2030-06-14 17:30 in Honolulu, 2030-06-15 17:30 in Kiritimati (+14).
      const now = new Date("2030-06-15T03:30:00Z");
      return [
        check("NY: later tonight (06-14 23:45) is upcoming though its date is before the UTC date", isUpcomingInZone("2030-06-14", "23:45", "America/New_York", now)),
        check("NY: earlier tonight (06-14 23:00) is past", !isUpcomingInZone("2030-06-14", "23:00", "America/New_York", now)),
        check("NY: the exact current minute counts as upcoming", isUpcomingInZone("2030-06-14", "23:30", "America/New_York", now)),
        check("Honolulu: 06-14 18:00 is upcoming", isUpcomingInZone("2030-06-14", "18:00", "Pacific/Honolulu", now)),
        check("Kiritimati: 06-15 09:00 is past though it is the UTC date", !isUpcomingInZone("2030-06-15", "09:00", "Pacific/Kiritimati", now)),
        check("Kiritimati: 06-15 18:00 is upcoming", isUpcomingInZone("2030-06-15", "18:00", "Pacific/Kiritimati", now)),
        check("unknown zone falls back to the date-only UTC rule", isUpcomingInZone("2030-06-15", "00:00", "Not/AZone", now) && !isUpcomingInZone("2030-06-14", "23:59", "Not/AZone", now)),
        check("SQL prefilter date is 2 days before the UTC date", startPrefilterDate(now) === "2030-06-13", startPrefilterDate(now)),
      ];
    },
  },
  {
    id: "WH-006",
    name: "0007 phone index is the exact STOP/START match expression",
    description: "Postgres only uses an expression index for an identical expression; the migration must equal phoneE164Sql (planner use verified in npm run test:db).",
    run: async () => {
      const rendered = new PgDialect().sqlToQuery(phoneE164Sql(sql`${sql.identifier("phone")}`));
      const migration = readFileSync(join(process.cwd(), "drizzle", "0007_phone_e164_idx.sql"), "utf8");
      const m = /^CREATE INDEX IF NOT EXISTS "booking_phone_e164_idx" ON "booking" USING btree \(([\s\S]*)\);\s*$/.exec(migration);
      return [
        check("migration is additive (CREATE INDEX IF NOT EXISTS only)", !!m),
        check("expression has no bind params", rendered.params.length === 0, String(rendered.params.length)),
        check("index expression === query expression", m?.[1] === rendered.sql, m ? undefined : "migration did not parse"),
      ];
    },
  },
];
