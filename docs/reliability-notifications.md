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

## `rate-limit.ts`: no longer fails open
Previously `rateLimit()` returned `{ ok: true }` on any database error, which silently removed booking-spam
protection and the FlowAI cost cap during a DB blip. Now, on a DB error it falls back to a per-instance in-memory
fixed-window limiter (`rate-limit-memory.ts`) with the same limits for every key (`book:*`, `avail:*`,
`ai:user:*`, `ai:org:*`) and fires a throttled ops alert. Caveat: per-instance only, so across N warm instances
the effective limit is up to N× during an outage. Sign-in/sign-up limits belong to Better Auth (`auth.ts`) and
are unchanged. Possible follow-up: true fail-closed (503) for `ai:*` if the founder prefers cost safety over availability.

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

## Recovery sweeper for stuck "queued" notifications — migration `0005_notification_sweeper` (additive)
Depends on PR #3 (`fix/booking-side-effects-after-commit`, 9d20c66), which writes notification rows as `queued`
in the booking transaction and sends right after commit. If the function dies in between, rows stay `queued`.
- `GET /api/cron/notifications` (Vercel Cron, `Authorization: Bearer $CRON_SECRET`; 503 if unset, 401 on mismatch)
  runs `sweepQueuedNotifications()` (`src/lib/server/notification-sweeper.ts`).
- Adds `notification.claimed_at`, `notification.sweep_attempts` (default 0) and index `(delivery_status, at)`.
- Picks rows `queued` for > 5 min and < 24 h. Atomic claim: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
  RETURNING` sets `claimed_at` (10-min lease) and bumps `sweep_attempts` (max 3), so overlapping runs never claim the
  same row. Finalizes with `WHERE delivery_status = 'queued'` so it never overwrites PR #3's own result.
- Skips (marks `failed` with a reason) when the booking is gone, a newer notification exists for the same booking +
  channel (rescheduled/cancelled since), or SMS consent was withdrawn. Rows older than 24 h, or out of sweeps, are
  expired → `failed` + failure log + alert.
- Re-sends use the retry logic above; email uses Resend `Idempotency-Key: flowops-notification-<row id>`.
- Body is rebuilt from the booking with the engine's template (duplicated in `emailBodyFor`; keep in sync).
- Schedule needs a `vercel.json` cron entry (not committed; deployment-setting change needs approval):
  `{ "crons": [{ "path": "/api/cron/notifications", "schedule": "*/5 * * * *" }] }` (Hobby plans only allow daily crons).

## Email-only appointment reminders — migration `0008_email_reminders` (additive)
Off by default. Set `EMAIL_REMINDERS_ENABLED=true` (and have `RESEND_API_KEY` set) to send one reminder **email**
~24 h before each upcoming confirmed booking that has a customer email. No SMS code path: no phone, consent or
Twilio call is read or made. With the flag off, `/api/cron/notifications` behaves exactly as before.
- Runs from `GET /api/cron/notifications` right after the sweeper (`src/lib/server/reminders/run.ts`), so it needs the
  cron to be enabled (`CRON_SECRET` set + a `vercel.json` cron entry; Vercel Hobby allows daily crons only).
- Window: start in (now + 30 min, now + 24 h] in the organization's time zone (`organization.time_zone`, DST-aware);
  `EMAIL_REMINDER_LEAD_HOURS` / `EMAIL_REMINDER_MIN_LEAD_MINUTES` tune it. With a once-a-day cron set the lead to 30 h so
  every booking is covered (reminders then go out 6–30 h ahead). Bookings made or rescheduled inside the window, demo
  organizations, cancelled bookings and past bookings are skipped.
- Exactly once: adds nullable `notification.dedupe_key` + unique partial index. Key `reminder-<bookingId>-<startsAtISO>`
  (a reschedule changes the start, so it gets a new reminder; the old one is skipped at send time). Insert is
  `ON CONFLICT DO NOTHING`; sending is claimed with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` (10-min
  lease, max 3 attempts) and uses the key as the Resend `Idempotency-Key`. Rows use status `sending` (never `queued`), so
  the recovery sweeper ignores them.
