/**
 * Unit tests for the notification retry policy (RT-001 … RT-007). Pure: no network, no DB,
 * no real sleeping (sleep/now/random are injected). Run with `npm test`.
 */
import type { Assertion, TestCase } from "@/lib/booking/tests";
import { type AttemptOutcome, classifyNetworkError, maskEmail, parseRetryAfter, scrubDetail, withRetry } from "./retry";

const check = (label: string, pass: boolean, detail?: string): Assertion => ({ label, pass, detail });

function harness(outcomes: AttemptOutcome[]) {
  const sleeps: number[] = [];
  let clock = 0;
  let calls = 0;
  return {
    sleeps,
    get calls() {
      return calls;
    },
    attempt: async () => outcomes[Math.min(calls++, outcomes.length - 1)],
    opts: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      random: () => 0.5, // jitter factor exactly 1.0
    },
  };
}

const netErr = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
const timeoutErr = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

export const RETRY_TEST_CASES: TestCase[] = [
  {
    id: "RT-001",
    name: "Retries 5xx then succeeds",
    description: "Two 503s then success → 3 attempts, exponential backoff 300ms, 600ms.",
    run: async () => {
      const h = harness([{ kind: "http", status: 503, detail: "x" }, { kind: "http", status: 503, detail: "x" }, { kind: "ok", detail: "id 1" }]);
      const r = await withRetry(h.attempt, h.opts);
      return [check("ok after retries", r.ok && r.attempts === 3, JSON.stringify(r)), check("backoff 300, 600", h.sleeps.join(",") === "300,600", h.sleeps.join(","))];
    },
  },
  {
    id: "RT-002",
    name: "No retry on 4xx validation errors",
    description: "Twilio 400 (invalid To) is permanent: exactly one attempt.",
    run: async () => {
      const h = harness([{ kind: "http", status: 400, detail: "Twilio 400 code 21211" }]);
      const r = await withRetry(h.attempt, h.opts);
      return [check("one attempt", h.calls === 1 && r.attempts === 1), check("permanent", !r.ok && r.failureKind === "permanent", JSON.stringify(r)), check("no sleep", h.sleeps.length === 0)];
    },
  },
  {
    id: "RT-003",
    name: "429 retried, Retry-After honored (capped)",
    description: "429 with Retry-After 1s waits 1000ms; Retry-After 30s is capped at 2000ms; exhausts after 3.",
    run: async () => {
      const h = harness([{ kind: "http", status: 429, detail: "rl", retryAfterSec: 1 }, { kind: "http", status: 429, detail: "rl", retryAfterSec: 30 }, { kind: "http", status: 429, detail: "rl" }]);
      const r = await withRetry(h.attempt, h.opts);
      return [
        check("3 attempts, exhausted", !r.ok && r.attempts === 3 && r.failureKind === "transient_exhausted", JSON.stringify(r)),
        check("delays 1000, 2000", h.sleeps.join(",") === "1000,2000", h.sleeps.join(",")),
      ];
    },
  },
  {
    id: "RT-004",
    name: "Pre-connect network errors are retried",
    description: "ECONNREFUSED / ENOTFOUND never reached the provider, so retry is safe.",
    run: async () => {
      const h = harness([{ kind: "error", error: netErr("ECONNREFUSED"), detail: "net" }, { kind: "error", error: netErr("ENOTFOUND"), detail: "net" }, { kind: "ok" }]);
      const r = await withRetry(h.attempt, h.opts);
      return [check("ok on 3rd", r.ok && r.attempts === 3, JSON.stringify(r)), check("classified pre_connect", classifyNetworkError(netErr("ECONNREFUSED")) === "pre_connect")];
    },
  },
  {
    id: "RT-005",
    name: "Timeouts not retried without idempotency key (no double-send)",
    description: "SMS (no idempotency key): a timeout is final + 'ambiguous'. Email (Idempotency-Key): retried.",
    run: async () => {
      const sms = harness([{ kind: "error", error: timeoutErr(), detail: "timeout" }, { kind: "ok" }]);
      const r1 = await withRetry(sms.attempt, sms.opts);
      const mail = harness([{ kind: "error", error: timeoutErr(), detail: "timeout" }, { kind: "ok" }]);
      const r2 = await withRetry(mail.attempt, { ...mail.opts, ambiguousRetrySafe: true });
      const reset = harness([{ kind: "error", error: netErr("ECONNRESET"), detail: "reset" }, { kind: "ok" }]);
      const r3 = await withRetry(reset.attempt, reset.opts);
      return [
        check("SMS timeout: 1 attempt, ambiguous", !r1.ok && sms.calls === 1 && r1.failureKind === "ambiguous", JSON.stringify(r1)),
        check("Email timeout: retried and ok", r2.ok && mail.calls === 2, JSON.stringify(r2)),
        check("ECONNRESET without key: not retried", !r3.ok && reset.calls === 1, JSON.stringify(r3)),
      ];
    },
  },
  {
    id: "RT-006",
    name: "Time budget and thrown attempts",
    description: "Stops when the next delay would exceed the budget; a throwing attempt is treated as a network error.",
    run: async () => {
      const h = harness([{ kind: "http", status: 500, detail: "boom" }]);
      const r = await withRetry(h.attempt, { ...h.opts, budgetMs: 100 });
      let n = 0;
      const r2 = await withRetry(
        async () => {
          n++;
          throw timeoutErr();
        },
        { sleep: async () => {} },
      );
      return [
        check("budget stops after 1 attempt", !r.ok && h.calls === 1 && h.sleeps.length === 0, JSON.stringify(r)),
        check("thrown timeout → 1 attempt, ambiguous", !r2.ok && n === 1 && r2.failureKind === "ambiguous", JSON.stringify(r2)),
      ];
    },
  },
  {
    id: "RT-007",
    name: "Redaction helpers",
    description: "Stored/alerted detail has no links, emails or phone numbers; targets are masked.",
    run: async () => {
      const d = scrubDetail("Resend 422: bad to jane.doe@example.com see https://resend.com/docs?x=1 call +1 (610) 555-0134 code 21211");
      return [
        check("no link/email/phone, keeps error code", !/https?:|@|555/.test(d) && d.includes("21211"), d),
        check("maskEmail", maskEmail("jane.doe@example.com") === "j•••@example.com" && maskEmail("bad") === "•••"),
        check("parseRetryAfter", parseRetryAfter("2") === 2 && parseRetryAfter(null) === undefined && parseRetryAfter(new Date(10_000).toUTCString(), 4_000) === 6),
      ];
    },
  },
];
