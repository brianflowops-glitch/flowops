/**
 * Bounded retry with exponential backoff for outbound notification providers (Twilio, Resend).
 *
 * Pure (no `server-only`, no DB) so it can be unit-tested with `npm test`.
 *
 * Idempotency rules — a retry must never double-send:
 * - HTTP 429 / 5xx: the provider explicitly did not accept the message → safe to retry.
 * - Other 4xx (invalid number, opted out, bad From, validation): permanent → never retried.
 * - Connection errors raised BEFORE the request reached the provider (DNS failure, connection
 *   refused) → safe to retry.
 * - Timeouts / connection resets: the provider MAY have accepted the message. Retried only when
 *   the caller sends a provider-side idempotency key (`ambiguousRetrySafe`, e.g. Resend's
 *   `Idempotency-Key`); otherwise treated as final so we never double-text a customer.
 */

export type AttemptOutcome =
  | { kind: "ok"; detail?: string }
  /** The provider answered with an HTTP error. */
  | { kind: "http"; status: number; detail: string; retryAfterSec?: number }
  /** fetch threw (network / timeout). */
  | { kind: "error"; error: unknown; detail: string };

export type FailureKind = "permanent" | "transient_exhausted" | "ambiguous";

export type RetryResult =
  | { ok: true; detail?: string; attempts: number }
  | { ok: false; detail: string; attempts: number; failureKind: FailureKind };

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff delay; doubles each retry (±20% jitter). Default 300 ms. */
  baseDelayMs?: number;
  /** Cap for a single backoff delay (also caps Retry-After). Default 2000 ms. */
  maxDelayMs?: number;
  /**
   * Overall budget: no new attempt starts if it would begin after this many ms.
   * Notifications run inside the booking transaction (advisory lock held), so keep it small. Default 12000 ms.
   */
  budgetMs?: number;
  /** True when a timeout/reset may be retried because the provider dedupes (idempotency key). */
  ambiguousRetrySafe?: boolean;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const PRE_CONNECT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const AMBIGUOUS_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function errCode(e: unknown): string | undefined {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const c = any?.code ?? any?.cause?.code;
  return typeof c === "string" ? c : undefined;
}

/** Classify a thrown fetch error: was the request definitely never delivered ("pre_connect"), or unknown ("ambiguous")? */
export function classifyNetworkError(e: unknown): "pre_connect" | "ambiguous" {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "ambiguous";
  const code = errCode(e);
  if (code && PRE_CONNECT_CODES.has(code)) return "pre_connect";
  if (code && AMBIGUOUS_CODES.has(code)) return "ambiguous";
  return "ambiguous"; // unknown → assume it may have been delivered
}

export function isRetryableStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parse a Retry-After header (seconds or HTTP date) into seconds. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : undefined;
}

export function backoffDelay(retryIndex: number, o: Required<Pick<RetryOptions, "baseDelayMs" | "maxDelayMs">> & { random: () => number }) {
  const raw = o.baseDelayMs * 2 ** retryIndex;
  const jitter = 0.8 + o.random() * 0.4;
  return Math.min(o.maxDelayMs, Math.round(raw * jitter));
}

export async function withRetry(attempt: (n: number) => Promise<AttemptOutcome>, opts: RetryOptions = {}): Promise<RetryResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 2000;
  const budgetMs = opts.budgetMs ?? 12_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const t0 = now();

  let last: { detail: string; failureKind: FailureKind } = { detail: "not attempted", failureKind: "transient_exhausted" };
  for (let n = 1; n <= maxAttempts; n++) {
    let out: AttemptOutcome;
    try {
      out = await attempt(n);
    } catch (e) {
      out = { kind: "error", error: e, detail: e instanceof Error ? e.message : String(e) };
    }
    if (out.kind === "ok") return { ok: true, detail: out.detail, attempts: n };

    let retryable: boolean;
    let retryAfterMs: number | undefined;
    if (out.kind === "http") {
      retryable = isRetryableStatus(out.status);
      if (out.retryAfterSec !== undefined) retryAfterMs = out.retryAfterSec * 1000;
      last = { detail: out.detail, failureKind: retryable ? "transient_exhausted" : "permanent" };
    } else {
      const cls = classifyNetworkError(out.error);
      retryable = cls === "pre_connect" || !!opts.ambiguousRetrySafe;
      last = { detail: out.detail, failureKind: cls === "ambiguous" && !opts.ambiguousRetrySafe ? "ambiguous" : "transient_exhausted" };
    }
    if (!retryable) return { ok: false, attempts: n, ...last };
    if (n === maxAttempts) break;

    const delay = Math.min(maxDelayMs, Math.max(retryAfterMs ?? 0, backoffDelay(n - 1, { baseDelayMs, maxDelayMs, random })));
    if (now() - t0 + delay > budgetMs) return { ok: false, attempts: n, ...last };
    await sleep(delay);
  }
  return { ok: false, attempts: maxAttempts, ...last };
}

/** Strip links, email addresses and long digit runs (phone numbers) from provider error text before storing/alerting. */
export function scrubDetail(s: string, max = 300) {
  return s
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .slice(0, max);
}

/** "jane.doe@example.com" → "j•••@example.com". */
export function maskEmail(email: string | null | undefined) {
  const e = (email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${e[0]}•••${e.slice(at)}`;
}
