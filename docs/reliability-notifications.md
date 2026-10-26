# Outbound notification reliability (v2.4, branch `automation/retries-alerts`)

## Retry policy (`src/lib/server/integrations/retry.ts`)
- Up to **3 attempts**, exponential backoff 300 ms → 600 ms (±20% jitter), single delay capped at 2 s
  (`Retry-After` honored up to the cap), overall budget 12 s. Notifications run inside the booking
  transaction (per-org advisory lock), so the budget is deliberately small.
- **Retried:** HTTP 429 / 5xx; connection errors before the request left (ENOTFOUND, ECONNREFUSED, EAI_AGAIN, …).
- **Never retried:** other 4xx (invalid number, STOP opt-out 21610, trial restrictions, bad From, Resend 422).
- **Ambiguous (timeout / connection reset):**
  - Email (Resend): retried — every attempt carries the same `Idempotency-Key`, so Resend dedupes.
  - SMS (Twilio): **not** retried — Twilio's Messages API has no idempotency key, so a retry could
    double-text the customer. Recorded as `failure_kind = ambiguous`.

## Failure log — migration `0003_notification_failures` (additive: one new table + 2 indexes)
`notification_failure(id, organization_id → organization ON DELETE CASCADE (nullable for account emails), channel, tag,
target (masked), failure_kind, detail (links/emails/phone numbers scrubbed), attempts, created_at)`.
Written on a separate pooled connection so it survives a rolled-back booking transaction; errors are swallowed.

## Alerts (`src/lib/server/integrations/notification-failures.ts`)
Optional env vars (no-op when unset):
| Var | Purpose |
| --- | --- |
| `ALERT_WEBHOOK_URL` | POST JSON `{ text, source, type, channel, tag, organizationId, target, failureKind, detail, attempts }` (Slack/Discord-compatible `text`) |
| `ALERT_EMAIL` | Comma-separated recipients, sent via Resend (requires `RESEND_API_KEY`) |

Throttled per instance: one alert per channel + failure kind + error prefix every 5 min. Alert sends are
direct (no retry, no failure recording) so a broken alert destination can't recurse.

## Recommendation: `rate-limit.ts` fails open (not changed)
`rateLimit()` returns `{ ok: true }` when the database call throws. That keeps the app up during a DB blip,
but it means a DB outage (or an attacker who can induce DB errors/timeouts) removes brute-force protection on
sign-in/sign-up, booking spam protection, and the FlowAI cost cap at the same time.
Recommended (needs owner sign-off; not implemented here):
1. **Fail closed for cost/abuse-sensitive keys** (FlowAI, sign-up, sign-in): add a `failMode: "open" | "closed"`
   option, default open, and pass `"closed"` from those routes (return 429/503 with `Retry-After: 30`).
2. **Small in-memory fallback** when the DB errors: a per-instance fixed window with a stricter limit, so a DB
   outage degrades protection instead of removing it.
3. **Alert on fail-open**: count limiter DB errors and call the ops alert hook (throttled) so it isn't silent.
4. Keep the public booking page fail-open (availability matters more there), with the in-memory fallback.

## Inbound provider webhooks — migration `0004_provider_webhooks` (additive: 3 new tables)
| Route | Verifies | Dedupe key | Writes |
| --- | --- | --- | --- |
| `POST /api/webhooks/twilio/inbound` | `X-Twilio-Signature` (HMAC-SHA1, `TWILIO_AUTH_TOKEN`) | `inbound:<MessageSid>` | STOP → `sms_opt_out.opted_out=true`, `booking.sms_consent=false` for that phone (all orgs; `sms_consent_at` kept as the original opt-in record; history entry `sms_opt_out`). START → opt-out cleared; consent restored (new `sms_consent_at`) only on upcoming confirmed bookings previously revoked by STOP. HELP → no DB change. |
| `POST /api/webhooks/twilio/status` | same | `status:<MessageSid>:<MessageStatus>` | `message_delivery_event`; `failed`/`undelivered` → `notification_failure` + alert |
| `POST /api/webhooks/resend` | Svix (`svix-id/timestamp/signature`, `RESEND_WEBHOOK_SECRET`, 5-min tolerance) | `svix-id` | `message_delivery_event`; `email.bounced/complained/failed` → `notification_failure` + alert. Opens/clicks ignored. |

Dedupe claim and processing share one transaction (unique index on `provider_webhook_event(provider, event_key)`),
so a replay is a no-op and a failed processing attempt is retried by the provider. Missing secret → 503 (fail closed).
`sendSms` now skips numbers in `sms_opt_out` (no alert) and adds `StatusCallback` when `TWILIO_STATUS_CALLBACK_URL` is set.

New env vars (all optional):
| Var | Purpose |
| --- | --- |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret (`whsec_…`) |
| `TWILIO_STATUS_CALLBACK_URL` | e.g. `https://flowopsagent.ai/api/webhooks/twilio/status`; sent with each SMS |
| `TWILIO_WEBHOOK_BASE_URL` | Public origin Twilio signs against if the request host differs (e.g. `https://flowopsagent.ai`) |
| `TWILIO_KEYWORD_REPLIES` | `true` = reply to STOP/START/HELP from FlowOps (leave off if Twilio Advanced Opt-Out replies) |
