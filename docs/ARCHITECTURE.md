# FlowOps — Architecture Audit (read-only)

- **Reflects commit:** `d09ffb6` (GitHub `main` of `brianflowops-glitch/flowops`, the PR #5 merge). The first version of this doc described `57458cd`. This revision covers everything merged since then, in merge order: `13ae74f` + `ee4079f` (`/sms-consent` page), `d42c566` (PR #1), `3be3a70` (PR #10), `87b92d0` (PR #3), `7b9b70d` (PR #4), `982b210` (PR #6), `7555304` (PR #11), `db84465` (PR #7), `29df4ec` (PR #9) and `d09ffb6` (PR #5). Every file:line reference below is at `d09ffb6`.
- **Date:** Oct 26, 2026 · **Author:** Flow Agent (Software Architect / Documentation & Progress Manager)
- **Method:** I read the diff `57458cd..d09ffb6` and the resulting files under `src/`, `drizzle/`, `scripts/`, `tests/`, `docs/` and `.github/` in a public read-only clone. In a scratch checkout of `d09ffb6` I ran `npm ci`, `npm test` (vitest: **7 files, 90 tests passed**), `npm run test:sim` (**20 passed, 0 failed**), `npm run test:billing` and `npm run test:billing:ui` (all passed, offline), `npm run lint` (clean), `npm run typecheck` (`next typegen && tsc --noEmit`, clean) and `npm run build` (succeeded). I did **not** run `test:db` or `test:billing:db` (they need a local throwaway Postgres), any migration, or anything against production data or Stripe. Env vars are listed by name only.
- **Rule:** this doc only states what the code shows. Anything that depends on production config, GitHub settings or infrastructure is marked **unverified** or **reported** (told to me by a teammate, not visible in the repo).

---

## 1. Stack

| Layer | Technology (from `package.json`) |
|---|---|
| Framework | Next.js 16.4.3 (App Router, `cacheComponents`, `partialPrefetching`, Turbopack), React 19.3 |
| Language | TypeScript 5, Tailwind CSS 4 |
| Auth | Better Auth 1.7 (email + password, Drizzle adapter, `nextCookies` plugin) |
| DB | Postgres (Neon) via `pg` Pool + Drizzle ORM 0.45. Migrations use drizzle-kit 0.31, applied by `scripts/db-migrate.ts` (Neon serverless driver over WebSocket for `*.neon.tech`) |
| AI | AI SDK 6 (`ai`, `@ai-sdk/react`) calling Vercel AI Gateway by model string (default `openai/gpt-4.1-mini`) |
| Email | Resend REST API (raw `fetch`), outbound + signed (Svix) inbound webhooks |
| SMS | Twilio REST API (raw `fetch`), outbound + signed inbound/status webhooks |
| Billing | Stripe Node SDK 23 (`stripe`), hosted Checkout + Customer Portal, webhook. Behind `BILLING_ENABLED` (off by default) |
| Calendar | Google Calendar v3 REST + OAuth 2 (raw `fetch`) |
| Validation | Zod 4.6 |
| Tests | Vitest 4 with an in-process PGlite Postgres (`@electric-sql/pglite`) for integration tests, plus `tsx` script suites |
| CI | GitHub Actions (`.github/workflows/ci.yml`) |
| Hosting | Vercel (`@vercel/functions` `attachDatabasePool`, `ipAddress`, `waitUntil`) |

## 2. Folder layout

```
.github/workflows/ci.yml lint → next typegen → tsc → npm test (vitest) → next build, on every PR and on push to main
docs/                    ARCHITECTURE.md (this file), BILLING.md, reliability-notifications.md
drizzle/                 0000_init … 0006_billing (7 migrations, + meta snapshots and _journal.json)
scripts/
  db-migrate.ts          apply migrations + idempotent demo seed (MIGRATE_ONLY=1 skips seed)
  run-tests.ts           npm run test:sim: FL-001…FL-008 engine simulations + RT (retry), WH (webhook signature), RL (rate-limit fallback) unit cases
  test-db.ts             npm run test:db: DB-backed checks, needs TEST_DATABASE_URL pointing at a local throwaway Postgres
  billing-tests.ts, billing-lock-ui-tests.ts, billing-db-tests.ts   npm run test:billing / test:billing:ui / test:billing:db
tests/                   vitest: auth, booking-simulation, fault-injection, flowai-authz, invites-verification, roles, tenancy (+ helpers/: PGlite DB, app harness)
vitest.config.mts        dummy env values only; DATABASE_URL=pglite://in-memory-test-db
src/
  proxy.ts               Next "proxy" (middleware): cookie-presence redirect only
  app/
    (marketing)/         home, terms, privacy, sms-consent (public)
    (dashboard)/         layout.tsx = real session gate + billing lock screen; pages: / (Command Center), admin, agents,
                         analytics, automation, booking, integrations, network, security, testing
    sign-in, sign-up, forgot-password, reset-password, verify-email, invite/[token], book/[orgSlug]
    api/                 route handlers (see §4). There are no server actions ("use server" isn't used anywhere)
    robots.ts, sitemap.ts
  components/            client UI. views/* map 1:1 to dashboard pages. billing/billing-locked.tsx is the lock screen.
                         automation/integrations/network/security are static sample-data pages (views/static-pages.tsx)
  lib/
    auth.ts, auth-client.ts         Better Auth server / client
    db/schema.ts, db/index.ts       Drizzle schema, lazy pg Pool (max 5)
    booking/engine.ts               6-agent pipeline (pure, adapter-injected), types.ts, tests.ts, store.tsx (client store)
    billing/                        config, stripe client, checkout helpers, webhook processing, status, access(-rules), lock-copy
    server/                         context (authz + billing guard), pipeline (DB-backed engine runner, post-commit side effects),
                                    assistant-tools, flowai-policy, fault-injection, notification-sweeper, rate-limit(+memory),
                                    validation, reset-link, invite-email, public-org, ai-errors,
                                    integrations/{google,notify,retry,notification-failures,crypto}.ts, webhooks/{signatures,store}.ts
    tenancy/                        membership, invites, team-rules, defaults
    data/                           sample/static data for the demo pages
```

## 3. Data model

There are 7 migrations, and all of them are additive (new tables, new nullable or defaulted columns, new indexes; no drops, renames or type changes):

| Migration | Adds | From |
|---|---|---|
| `0000_init` | every original table except `team_invite` | |
| `0001_team_invites` | `team_invite` | |
| `0002_booking_sms_consent` | `booking.sms_consent`, `booking.sms_consent_at` | |
| `0003_notification_failures` | `notification_failure` + indexes (org, created_at) and (created_at) | PR #4 |
| `0004_provider_webhooks` | `message_delivery_event`, `provider_webhook_event` (unique (provider, event_key)), `sms_opt_out` | PR #4 |
| `0005_notification_sweeper` | `notification.claimed_at`, `notification.sweep_attempts` (default 0), index (delivery_status, at) | PR #4 |
| `0006_billing` | `billing_customer`, `subscription`, `stripe_event` + unique/lookup indexes | PR #5 |

There are no DB enums, so the "enum" columns are plain `text` checked only in TypeScript (`subscription.status` uses a Drizzle text enum, which is still a plain `text` column in SQL). IDs are app-generated `text`.

### Better Auth core
| Table | Columns |
|---|---|
| `user` | id PK, name, email UNIQUE, email_verified bool=false, image, business_name, created_at, updated_at (timestamp, no tz) |
| `session` | id PK, expires_at, token UNIQUE, created_at, updated_at, ip_address, user_agent, user_id → user (cascade). Index on user_id |
| `account` | id PK, account_id, provider_id, user_id → user (cascade), access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password (hash), created_at, updated_at |
| `verification` | id PK, identifier (indexed), value, expires_at, created_at, updated_at. Holds reset tokens as `reset-password:<token>` → userId |
| `rate_limit` | id PK, key UNIQUE, count int, last_request bigint (ms). Shared by Better Auth and the FlowOps limiter (keys prefixed `flowops:`) |

### Tenancy
| Table | Columns |
|---|---|
| `organization` (tenant) | id PK, slug UNIQUE, name, time_zone='America/New_York', hours jsonb (WeekHours, 0=Sun), public_booking bool=true, google_refresh_token_enc (AES-256-GCM), google_calendar_id, google_account_email, is_demo bool, created_at |
| `member` | id PK, organization_id → organization (cascade), user_id → user (cascade), role text owner\|admin\|staff, created_at. **UNIQUE(user_id): a user belongs to exactly one org.** Index on org |
| `team_invite` | id PK, organization_id → org (cascade), email, role admin\|staff, token_hash (SHA-256) UNIQUE, invited_by → user (set null), created_at, expires_at (7 days), last_sent_at, accepted_at, accepted_by → user (set null), revoked_at (all timestamptz). Index on (org, email) |
| `staff_invite` (legacy, pre-v2.1) | id PK, organization_id → org (cascade), email UNIQUE (global), invited_by → user (set null), created_at. Nothing in the code creates rows anymore. Since PR #9 a row is only honored for a verified email and within 7 days of `created_at` |

### Booking data (each table has `organization_id` → organization, on delete cascade)
| Table | Columns |
|---|---|
| `service` | id PK, organization_id, name, category appointment\|travel\|restaurant\|workforce, duration_min=60, resource, description, active=true, sort_order=0, created_at. Index on org |
| `booking` | id PK (`BK-…`), organization_id, customer, email, phone (E.164 when parseable), sms_consent=false, sms_consent_at (tz), category, service (**text copy, no FK to service**), resource (text, the conflict key), date `YYYY-MM-DD` and time `HH:MM` (org-local text), duration_min, notes, status confirmed\|cancelled, calendar_event_id, source dashboard\|assistant\|public, history jsonb[], created_at, updated_at (tz). Indexes on (org, date) and (org, status) |
| `audit_entry` | id PK, organization_id, at (tz), action, booking_id (no FK; null for team actions such as `member.removed`), agent, outcome, detail, actor. Index on (org, at) |
| `notification` | id PK, organization_id, at (tz), booking_id (no FK), recipient, channel, subject, delivery_status (`queued` → `sent` \| `failed` for real sends; `simulated` etc. otherwise), detail, claimed_at (tz), sweep_attempts int=0. Indexes on (org, at) and (delivery_status, at) |

### Notification reliability (PR #4)
| Table | Columns |
|---|---|
| `notification_failure` | id PK, organization_id → organization (cascade, **nullable**: account emails and provider-webhook failures have none), channel sms\|email, tag (no PII, e.g. `booking:BK-…`), target (masked), failure_kind permanent\|transient_exhausted\|ambiguous\|undelivered\|bounced\|complained, detail (links/emails/numbers scrubbed), attempts, created_at |
| `provider_webhook_event` | id PK, provider twilio\|resend, event_key, event_type, received_at. UNIQUE (provider, event_key) = webhook dedupe |
| `message_delivery_event` | id PK, provider, message_id (Twilio SID / Resend email id), status, error_code, detail (scrubbed), occurred_at, created_at. Append-only. Index (provider, message_id) |
| `sms_opt_out` | phone PK (E.164), opted_out bool, keyword, updated_at. **Not org-scoped**: all orgs share the FlowOps sender number |

### Billing (PR #5, Stripe is the source of truth; see `docs/BILLING.md`)
| Table | Columns |
|---|---|
| `billing_customer` | organization_id PK → organization (cascade), stripe_customer_id UNIQUE, created_at, updated_at |
| `subscription` | id PK, organization_id → organization (cascade), stripe_subscription_id UNIQUE, status (trialing\|active\|past_due\|canceled\|incomplete\|incomplete_expired\|unpaid\|paused), price_id, current_period_end, cancel_at_period_end=false, last_event_created (ordering guard), created_at, updated_at. Index on org |
| `stripe_event` | id PK (`evt_…`), type, processed_at. Webhook idempotency |

### How tenancy is enforced
- Isolation happens in the application only. There is no Postgres RLS. Every handler gets the org from `getContextFromHeaders` (`src/lib/server/context.ts:20-39`), which looks up `member` by `session.user.id`, and every query on tenant tables adds `eq(organizationId, ctx.org.id)`. I checked every route in §4 and each one scopes by `ctx.org.id`, by the slug-resolved org on the public routes, or (webhooks/cron) by provider ids and booking/org ids taken from the stored rows.
- If a signed-in user has no `member` row but the `user` row still exists, `getContextFromHeaders` calls `ensureMembership` (`context.ts:25-31`), which gives them a new workspace (see §5, removed members).
- Membership changes (`ensureMembership`, `joinOrgWithInvite`, `claimLegacyInviteAfterVerification`, `removeMemberFromOrg` in `src/lib/tenancy/membership.ts`) all run under the global advisory lock `flowops:membership`. `ensureMembership` order: token invite → legacy `staff_invite` email match (verified email and < 7 days only) → claim the demo org `org_flowops_demo` if it has no owner (limited by `FLOWOPS_OWNER_EMAILS`) → otherwise create a new org with the user as Owner.
- Pipeline writes are serialized per org with `pg_advisory_xact_lock(hashtext('flowops:org:<id>'))` (`src/lib/server/pipeline.ts:144`). The post-commit side effects (§8) run after the lock is released.

## 4. API routes and authorization

`requireApi(req, opts)` (`src/lib/server/context.ts:58-67`) returns 503 if there's no DB, 401 if there's no session or membership, 403 if `owner:true` and the role isn't owner, 403 if `manager:true` and the role isn't owner or admin, and then **402 `billing_locked`** from `requireBillingAccess` (`context.ts:64`, §11a) when billing is on and the org is locked. The real check happens in each route. `src/proxy.ts` only checks that a cookie is present, and it excludes `/api/*` and the public pages (now including `/sms-consent`).

| Route | Method | Auth check | Notes |
|---|---|---|---|
| `/api/auth/[...all]` | GET/POST | Better Auth | sign-up/in/out, reset, verify. Better Auth rate limits. Exempt from the billing lock |
| `/api/state` | GET | `requireApi()` any member | bookings, audit, notifications (200 each), services, team counts, integration status, `faultInjection` flag |
| `/api/bookings` | POST | `requireApi()` any member | create/reschedule/cancel through the pipeline. `failAgent` → **403 unless `canInjectFaults(role)`** (PR #6) |
| `/api/assistant` | GET | **none** | returns `{configured, model}` |
| `/api/assistant` | POST | `requireApi()` any member + rate limit | FlowAI stream, tools filtered by role (see §7) |
| `/api/admin/org` | PATCH | owner | name, slug, timeZone, hours, publicBooking, googleCalendarId |
| `/api/admin/services` | GET | any member | |
| `/api/admin/services` | POST | owner | |
| `/api/admin/services/[id]` | PATCH, DELETE | owner, org-scoped | PATCH uses `serviceUpdate` (no defaults) and 400s on an empty body (PR #1) |
| `/api/admin/staff` | GET | any member (invites only if manager) | |
| `/api/admin/staff` | DELETE | manager + `canRemove` | `removeMemberFromOrg`: deletes **only the membership**, signs the user out, writes `audit_entry` `member.removed` (PR #11) |
| `/api/admin/invites` | POST | manager + `canInviteRole` | returns the raw link, emails it if Resend is set |
| `/api/admin/invites/[id]` | DELETE | manager + `canInviteRole`, org-scoped | revoke |
| `/api/admin/invites/[id]/resend` | POST | manager + `canInviteRole`, org-scoped | new token + expiry |
| `/api/admin/members/[id]/reset-link` | POST | manager + `canResetFor`, org-scoped | 24 h one-time reset link returned in the response |
| `/api/invites/[token]` | GET | public (token is the secret) | shows the invitee email only while pending |
| `/api/invites/[token]/accept` | POST | Better Auth session (no membership needed) | `joinOrgWithInvite`, verified email required when Resend is configured (PR #9). Exempt from the billing lock |
| `/api/integrations/google/connect` | GET | owner | HMAC-signed state `org:user:ts` |
| `/api/integrations/google/callback` | GET | owner + state check (same org/user, ≤15 min) | stores the encrypted refresh token |
| `/api/integrations/google/disconnect` | POST | owner | nulls the token columns |
| `/api/public/[slug]` | GET | public, needs `public_booking=true` | no rate limit. **Not billing-gated** |
| `/api/public/[slug]/availability` | GET | public, 60/min/IP | not billing-gated |
| `/api/public/[slug]/book` | POST | public, 8/10 min per page/IP, 20/h/IP, 5/email/org/day, honeypot `website` | response strips other customers' data. **Not billing-gated** (open decision D-15) |
| `/api/billing/checkout` | POST | 404 unless `BILLING_ENABLED=true`; 503 if no usable Stripe key; `requireApi({manager:true})` | one subscription per org: expires open sessions, 409 if Stripe already has a live subscription (PR #5) |
| `/api/billing/portal` | POST | same as checkout | Stripe Customer Portal session (PR #5) |
| `/api/billing/webhook` | POST | 404 unless `BILLING_ENABLED=true`; 503 without `STRIPE_WEBHOOK_SECRET`/DB; Stripe signature (`constructEventAsync`) | 400 on a missing/bad signature, 500 → Stripe retries (PR #5) |
| `/api/webhooks/twilio/inbound` | POST | `X-Twilio-Signature` (HMAC-SHA1, `TWILIO_AUTH_TOKEN`); 503 if unset, 403 if bad | STOP/START/HELP (PR #4) |
| `/api/webhooks/twilio/status` | POST | same | message status callbacks (PR #4) |
| `/api/webhooks/resend` | POST | Svix signature (`RESEND_WEBHOOK_SECRET`, 5-min tolerance); 503 if unset, 401 if bad | bounces, complaints, failures (PR #4) |
| `/api/cron/notifications` | GET | `Authorization: Bearer $CRON_SECRET` (constant-time compare); 503 if unset, 401 if wrong | stuck-queued sweeper (PR #4). **Not scheduled** (no `vercel.json`) |

Role rules (`src/lib/tenancy/team-rules.ts`): Owner can invite Admin or Staff, and Admin can invite Staff only. For reset links, Owner can reset anyone and Admin can reset Staff and themselves. No one can remove an Owner, and no one can remove themselves; Admin can remove Staff only. Org settings, services and Google are Owner-only. Billing checkout/portal are Owner or Admin (`canManageTeam`). Bookings (dashboard) are open to every role. In FlowAI, every role can read, create and reschedule (each write needs UI approval), and **only Owner and Admin can cancel** (PR #7, §7). Fault injection is Owner/Admin and non-production only (PR #6).

Dashboard pages: `src/app/(dashboard)/layout.tsx:13-47` redirects to `/sign-in` when `getContext()` returns null (line 24), and renders `BillingLocked` instead of the app when `getBillingAccess` says locked (lines 26-31). The pages are client components that fetch `/api/state`; a 402 `billing_locked` there triggers `router.refresh()` so the layout shows the lock screen (`src/lib/booking/store.tsx`).

## 5. Auth, sessions, password reset, invites, team removal

- **Config:** `src/lib/auth.ts:26-118`. Email and password are enabled with a minimum length of 10 (line 40), and `autoSignIn` is on. Sessions live in Postgres with a 5-minute cookie cache (line 83). Cookies are SameSite=Lax (Better Auth default). Trusted origins are flowopsagent.ai, www, flowops-blue.vercel.app, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, plus localhost outside production. Client IP comes from the `x-vercel-forwarded-for`, `x-real-ip` and `x-forwarded-for` headers.
- **Email verification:** `requireEmailVerification` (sign-in blocked until verified) is only true when `REQUIRE_EMAIL_VERIFICATION=true` **and** `RESEND_API_KEY` is set (`notify.ts:42-44`, `auth.ts:43`). The production value is **unverified**. Since PR #9, verification is also enforced in two narrower places regardless of that flag: (1) an existing account accepting a token invite must have `email_verified=true` whenever Resend is configured (`api/invites/[token]/accept/route.ts:15`, `membership.ts:133-136`); (2) a legacy `staff_invite` email match is only honored for a verified email, either at sign-up or later through Better Auth's `afterEmailVerification` hook → `claimLegacyInviteAfterVerification` (`auth.ts:62-68`, `membership.ts:160-181`). Signing up *with* an invite token does not require verification: the `user.create.before` hook only checks the token is usable for that email (`auth.ts:103-108`).
- **Password reset:** Better Auth's `/request-password-reset` emails a link valid for 1 h, and other sessions are revoked on reset (`auth.ts:45`). Owners and Admins can also mint a 24 h link (`src/lib/server/reset-link.ts:14-20`), which writes a Better Auth `verification` row directly.
- **Invites:** `src/lib/tenancy/invites.ts`. Tokens are 32 random bytes (base64url), only the SHA-256 hash is stored, they expire after `INVITE_TTL_DAYS = 7` days (line 6), and they are single-use through a conditional `UPDATE … RETURNING` (`consumeInvite`). Existing users accept through `joinOrgWithInvite` (`membership.ts:122-152`): the invite is validated before the transaction (so a refusal leaves it usable), then the verified-email check, then: an existing Staff or Admin membership is replaced; an owner of an *empty* auto-created workspace (no other members, no bookings, not the demo org) has that workspace deleted; an owner of a non-empty workspace or of the demo workspace is refused.
- **Team removal (PR #11):** `removeMemberFromOrg` (`membership.ts:190-221`) deletes only that org's `member` row, deletes all of the user's `session` rows, deletes any legacy `staff_invite` for that email in that org, and writes `audit_entry` (`action: "member.removed"`, `agent: "TeamAdmin"`, actor = remover). The `user`, `account`, bookings and other data are kept. Owners can't be removed. **What the removed person sees next (D-14, open):** their sessions are deleted (Better Auth's 5-minute cookie cache, `auth.ts:83`, may let an already-issued cookie keep working until it expires; I did not test this), and the next time they are signed in `getContextFromHeaders` finds no membership and `ensureMembership` creates a brand-new empty workspace with them as Owner (`context.ts:25-31`; the code comment at `membership.ts:186` says the same). Whether that is the desired experience is Brian's decision.

## 6. Integrations and env vars (names only)

| Integration | Code | Env vars read |
|---|---|---|
| Postgres | `src/lib/db/index.ts`, `scripts/db-migrate.ts` | `DATABASE_URL`, `DB_DRIVER`, `MIGRATE_ONLY` (scripts), `TEST_DATABASE_URL` (test scripts) |
| Better Auth | `src/lib/auth.ts`, `invites.ts` | `BETTER_AUTH_SECRET` (implicit in Better Auth, also `crypto.ts`, `assistant/route.ts:74`), `BETTER_AUTH_URL`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `NODE_ENV` |
| Ownership | `membership.ts` | `FLOWOPS_OWNER_EMAILS` |
| Resend | `src/lib/server/integrations/notify.ts` | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (falls back to `onboarding@resend.dev`), `RESEND_REPLY_TO`, `REQUIRE_EMAIL_VERIFICATION`, `RESEND_WEBHOOK_SECRET` |
| Twilio | `notify.ts`, `api/webhooks/twilio/*`, `webhooks/store.ts` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_STATUS_CALLBACK_URL`, `TWILIO_WEBHOOK_BASE_URL`, `TWILIO_KEYWORD_REPLIES` |
| Ops alerts | `integrations/notification-failures.ts` | `ALERT_WEBHOOK_URL`, `ALERT_EMAIL` (needs `RESEND_API_KEY`) |
| Sweeper cron | `api/cron/notifications/route.ts` | `CRON_SECRET` |
| Fault injection | `server/fault-injection.ts` | `VERCEL_ENV`, `NODE_ENV`, `FLOWOPS_ENABLE_FAULT_INJECTION` |
| Stripe | `src/lib/billing/*`, `api/billing/*` | `BILLING_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_ALLOW_LIVE`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_<PLAN>`, `BILLING_EXEMPT_ORG_IDS` |
| AI Gateway | `src/app/api/assistant/route.ts` | `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `VERCEL`, `AI_GATEWAY_MODEL` |
| Google Calendar | `src/lib/server/integrations/google.ts`, `api/integrations/google/*` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_URL` (redirect URI) |

`.env.example` lists the reliability vars (alerts, webhooks, `CRON_SECRET`) but not the billing vars; those are listed in `docs/BILLING.md` §8.

- **Google:** scopes are `calendar.events`, `openid` and `email`. The OAuth is per org, and the refresh token is AES-256-GCM encrypted with a key derived from `BETTER_AUTH_SECRET`. Events are created, patched (recreated on a 404 or 410) and deleted. Since PR #3 the calendar call runs **after** the booking commits (§8); a failed post-commit call is recorded as a warning `audit_entry`, not rolled back.
- **Resend and Twilio, outbound (PR #3 + PR #4):** sends are captured during the pipeline run and executed after commit. `withRetry` (`integrations/retry.ts:87`) makes up to 3 attempts with exponential backoff (300 ms base, ±20 % jitter, 2 s cap, `Retry-After` honored up to the cap, 12 s budget). HTTP 429/5xx and pre-connect network errors are retried; other 4xx are permanent. Timeouts/resets are retried for email only, because every Resend attempt carries the same `Idempotency-Key` (`flowops-notification-<row id>` for booking mail); Twilio has no idempotency key, so an ambiguous SMS failure is not retried. A final failure is written to `notification_failure` and alerted (`ALERT_WEBHOOK_URL` / `ALERT_EMAIL`, throttled to one per key per 5 min per instance). `sendSms` skips numbers in `sms_opt_out` (`notify.ts:143`) and adds `StatusCallback` when `TWILIO_STATUS_CALLBACK_URL` is set.
- **Inbound webhooks (PR #4):** each event is claimed in `provider_webhook_event` and processed in the same transaction (`webhooks/store.ts:15-25`), so a replay is a no-op and a failure lets the provider retry. Twilio inbound: STOP sets `sms_opt_out` and `booking.sms_consent=false` on every booking with that normalized phone, across all orgs, keeping `sms_consent_at` and appending a history entry; START clears the opt-out and restores consent only on confirmed bookings that STOP turned off and whose `date >= to_char(now(), 'YYYY-MM-DD')` (`store.ts:85-103`); HELP changes nothing. By default the route returns empty TwiML so Twilio's own Advanced Opt-Out replies are used (route comment, `inbound/route.ts:8`); `TWILIO_KEYWORD_REPLIES=true` makes FlowOps reply instead. Twilio status and Resend events append to `message_delivery_event`; `failed`/`undelivered`, bounces, complaints and Resend failures also go to `notification_failure` + alert.
- Each integration falls back to "simulated" when its env vars are missing.

## 7. FlowAI (assistant)

`src/app/api/assistant/route.ts` + `src/lib/server/assistant-tools.ts` + `src/lib/server/flowai-policy.ts` (PR #7).
- **Auth:** `requireApi()`, so any member role can chat (and the billing lock applies). Rate limits are 6 per minute per user and 40 per hour per org. The last 30 UI messages are validated against the tool schemas. Limits are 8 steps and 1500 output tokens, with `maxDuration` of 60 s. The system prompt embeds the org name, user name and role, business hours and services.
- **Policy (`FLOWAI_POLICY`, `flowai-policy.ts:44-51`):** default-deny (a tool missing from the table is denied for everyone). `assistantTools` (`assistant-tools.ts:46-62`) only offers the model the tools the user's role may use, sets `needsApproval` from the policy, and re-checks the role inside every `execute`. Settings, services and team management are not exposed to FlowAI at all.
  | Tool | Effect | Roles | Approval |
  |---|---|---|---|
  | `listServices` | read | all | no |
  | `listBookings` | read (≤200 rows from DB, 50 returned; includes customer email) | all | no |
  | `checkAvailability` | read | all | no |
  | `createBooking` | write + sends real email/SMS | all | **yes** |
  | `rescheduleBooking` | write + sends notifications | all | **yes** |
  | `cancelBooking` | write + sends notifications | **Owner, Admin** | **yes** |
- Approvals are AI SDK tool approvals signed with `sha256("flowops:approval:"+BETTER_AUTH_SECRET)` (`route.ts:74`). The UI shows a per-tool confirmation card (`components/assistant-panel.tsx`). Writes go through `runPipeline` and are audited as `flowai:<email>`.

## 8. Booking pipeline (PR #3)

`runPipeline` (`src/lib/server/pipeline.ts:129-234`) opens a DB transaction and takes the per-org advisory lock. It loads the working set (confirmed bookings from about 36 h ago onward, plus the target booking) and runs `BookingEngine` through Intent → Booking → Availability → Calendar → Notification → Audit, but with **deferred adapters** (`deferredCalendar`, `deferredNotifier`, lines 83-118) that only record the intended Google call and sends. Inside the transaction it persists the booking, all audit entries, and (on success) notification rows; real sends are stored with `delivery_status='queued'` (line 221). No network call happens while the transaction or lock is held.

After commit, `runSideEffects` (lines 247-325) performs the calendar call and stores the real event id, then sends each queued notification (with the row-based Resend idempotency key) and moves its row from `queued` to `sent` or `failed`. Any post-commit problem becomes a warning `audit_entry` with `outcome:"failed"`. It never throws. If the run fails, nothing is sent and only the failure audit is stored.

**Recovery (PR #4):** `sweepQueuedNotifications` (`src/lib/server/notification-sweeper.ts:45-111`), called by `GET /api/cron/notifications`, picks rows still `queued` after 5 min (and less than 24 h old), claims up to 25 with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` (10-min lease, max 3 sweeps), re-sends them, and finalizes only rows that are still `queued`. It skips (marks `failed` with a reason) rows whose booking is gone, that a newer notification for the same booking + channel supersedes, or whose SMS consent was withdrawn. Rows older than 24 h or out of sweeps are expired to `failed` and logged + alerted. **There is no `vercel.json`, so nothing calls the cron yet**; the schedule is part of the go-live setup (D-10).

## 9. Rate limiting

- Better Auth (DB storage) allows 60 requests per 60 s by default, `/sign-up/*` is limited to 5 per 600 s, and `/sign-in/*` to 10 per 60 s (`auth.ts:87-95`).
- The FlowOps limiter (`src/lib/server/rate-limit.ts:19-44`) is a fixed window built on one atomic upsert into `rate_limit`. Since PR #4 it **no longer fails open**: on a DB error it falls back to a per-instance in-memory fixed window with the same limits (`rate-limit-memory.ts`, capped at 10 000 keys) and fires a throttled ops alert (lines 35-43). Across N warm instances the effective limit during an outage is up to N×. The IP comes from `ipAddress()` and falls back to `"unknown"` (line 53), which means one shared bucket.
- It's used on public book, availability and FlowAI (see §4 and §7). Invite lookup, invite accept, `/api/public/[slug]`, `/api/bookings`, the admin routes, billing and the webhooks have no app-level limit (the webhooks and cron are signature/secret-gated).

## 10. Tests and CI (PR #10)

- **`npm test` = `vitest run`** (`vitest.config.mts`): 7 files under `tests/` with integration tests that run the real route handlers, Better Auth and Drizzle against an in-process PGlite database with dummy env values (no real DB or secrets): auth, booking simulation (FL-00x), fault injection, FlowAI authorization, invite verification, roles, tenancy (including member removal). **I ran it at `d09ffb6`: 90 passed.**
- Not run by `npm test` (and so not by CI): `npm run test:sim` (FL + RT retry + WH webhook-signature + RL rate-limit-fallback cases; **20 passed** when I ran it), `npm run test:billing` and `test:billing:ui` (passed, offline), and the DB-backed `test:db` / `test:billing:db` (need a local throwaway Postgres; I did not run them). Billing, the provider webhooks, the sweeper and the retry logic therefore have no coverage in CI.
- **CI:** `.github/workflows/ci.yml` runs on every pull request and on push to `main`: `npm ci` → `npm run lint` → `npx next typegen` → `npx tsc --noEmit` → `npm test` → `npm run build` (Node 22, `contents: read`, no secrets). There is no migration or deploy step. **Reported:** branch protection is off, so CI is not a required check (a GitHub setting, not visible in the repo).

## 11. Billing (PR #5)

Full design: `docs/BILLING.md`. Summary of what the code does:
- **Config (`billing/config.ts`):** everything is env-driven and off by default. `BILLING_ENABLED=true` turns the routes and the lock on. Plans come only from `STRIPE_PRICE_<PLAN>` env vars (no prices in code). Live keys (`sk_live_`/`rk_live_`) are refused unless `STRIPE_ALLOW_LIVE=true`.
- **Checkout/portal:** Owner or Admin. One Stripe customer per org (`getOrCreateCustomer`, idempotency key per org + user so a second admin doesn't hit a 500, `billing/checkout.ts:9-22`). Checkout expires open sessions and returns 409 if Stripe already has a live subscription for the customer.
- **Webhook (`billing/webhook.ts:65-101`):** handles `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`. Duplicate check, then the current subscription is fetched from Stripe **outside** the transaction, then one transaction inserts `stripe_event` and upserts `subscription` with two guards: canceled is terminal, and writes from strictly older events are skipped (line 166). Errors → 500 so Stripe retries.
- **Card-failure lock (policy in `access-rules.ts:3` and `docs/BILLING.md`: a failed card locks the org immediately):** `getBillingAccess(orgId, role)` (`billing/access.ts:23-38`) → `{access: "full"|"locked", reason, status, canManageBilling}`. Full for `active`/`trialing`, for orgs in `BILLING_EXEMPT_ORG_IDS`, or when billing is off; locked for no subscription and every other status (`access-rules.ts:57-63`). `requireBillingAccess` (`access.ts:45-51`), called from `requireApi`, returns **402 `{error:"billing_locked", reason, status, canManageBilling}`**; `/api/billing/*`, `/api/auth/*` and `/api/invites/*` are exempt by path (`access-rules.ts:69`). The lock never changes or deletes data, and access returns on the next request once the webhook writes `active`.
- **Lock screen:** the dashboard layout renders `BillingLocked` (`components/billing/billing-locked.tsx`) with copy from `lockScreenCopy` (`billing/lock-copy.ts`). Owner/Admin get "Choose <plan>" buttons (plan keys only, never price ids) for `no_subscription`/`incomplete_expired`, or "Manage billing" (portal) for everything else, **including `canceled`** (line 28-29); Staff get a contact-an-admin message. Every variant has Sign out.
- **Not gated by the lock (by design for now):** the public booking routes, the sweeper cron and the Twilio/Resend webhooks (`docs/BILLING.md` §6). Whether the public booking page keeps taking bookings while a card has failed is open decision D-15.

## 12. Public `/sms-consent` page (`13ae74f`, `ee4079f`)

`src/app/(marketing)/sms-consent/page.tsx` documents the A2P 10DLC opt-in: the FlowOps number, the message types, the exact booking-form checkbox text (`SMS_CONSENT_TEXT` from `src/lib/phone.ts`, unchecked by default and optional), and the text-us-first path. `ee4079f` added `sms-consent` to the `proxy.ts` matcher exclusions so it is public without sign-in; it is also in `robots.ts` (allow) and `sitemap.ts`, and linked from the footer and Terms §7.

---

## 13. Findings

Severity: **critical** = exploitable or data loss now · **high** = must fix before release gate · **medium** = fix before commercial launch · **low** = hardening.
**Status at `d09ffb6`:** "Fixed" means the fix is merged into `main` (merge commit cited). None of it is deployed: **reported** production is still `ee4079f`, and there is no auto-deploy step in the repo.

### Status summary
| ID | Title | Status at `d09ffb6` |
|---|---|---|
| H1 | External calls inside the DB transaction | **Fixed** — PR #3 `87b92d0` (+ sweeper, PR #4 `7b9b70d`, not yet scheduled) |
| H2 | Email ownership never verified | **Partly fixed** — PR #9 `29df4ec`; open parts below |
| H3 | No automated tests or CI | **Mostly fixed** — PR #10 `3be3a70`; open parts below |
| M1 | Service PATCH resets fields | **Fixed** — PR #1 `d42c566` |
| M2 | Fault injection reachable in production | **Fixed** — PR #6 `982b210` |
| M3 | FlowAI has no role gate, writes without approval | **Fixed** — PR #7 `db84465` |
| M4 | SMS consent can be set by the model | Open |
| M5 | Rate limiter fails open, shared unknown-IP bucket | **Partly fixed** — PR #4 `7b9b70d` (fail-open); rest open |
| M6 | Destructive hard deletes, no audit | **Partly fixed** — PR #11 `7555304` (member removal); rest open |
| M7 | No Twilio/Resend webhooks, no retry | **Fixed** — PR #4 `7b9b70d`; follow-ups in N3, N4 |
| M8 | One organization per user | Open (product decision) |
| M9 | Manual migrations, no backups documented | Open |
| L1–L11 | Hardening | Open (L6 impact reduced by PR #3) |
| N1–N7 | New in this revision | Open |

### High
- **H1. External calls ran inside the DB transaction and advisory lock. — FIXED in PR #3 (`87b92d0`).** `runPipeline` now records calendar and notification intent with deferred adapters and runs the real calls only after commit (`pipeline.ts:83-118`, `230-233`, `247-325`). A failed save never notifies anyone, and no pool connection or per-org lock is held during network calls. Notification rows go `queued` → `sent`/`failed`. If the function dies between commit and send, rows stay `queued`; the recovery sweeper from PR #4 (`7b9b70d`) handles them, but it only runs once a cron calls it (**open:** no `vercel.json`, waiting on go-live setup D-10). Remaining limit, from the code's own comment (`pipeline.ts:239-245`): side effects run outside the lock, so two quick reschedules can reach Google out of order (see N6).
- **H2. Email ownership is never verified. — PARTLY FIXED in PR #9 (`29df4ec`).** Fixed: a legacy `staff_invite` email match now requires a verified email and is only valid for 7 days (`membership.ts:16-19`, `74`, `160-181`), so registering an invited address first no longer grants Staff access; existing accounts must be verified to accept a token invite when Resend is configured (`accept/route.ts:15`). **Still open:** verification only gates invite acceptance and legacy invite claims. Sign-in, the dashboard, bookings and FlowAI do not require a verified email unless `REQUIRE_EMAIL_VERIFICATION=true` with Resend configured (`notify.ts:42-44`); the production value is **unverified**. Token-invite acceptance is not gated when Resend is not configured. Whether production `staff_invite` has rows is still **unverified**.
- **H3. No automated tests and no CI. — MOSTLY FIXED in PR #10 (`3be3a70`).** Vitest + PGlite integration tests now cover auth, tenancy, roles, invites, FlowAI authorization and fault injection, and later PRs added to them (90 tests at `d09ffb6`). CI runs lint, typecheck, tests and build on every PR and on `main` (§10). **Still open:** (a) CI is not a required check (branch protection off, **reported**), so a red PR can still be merged; (b) the billing, webhook, sweeper and retry suites are not part of `npm test` and don't run in CI (N1); (c) there is no auto-deploy: production is **reported** at `ee4079f`, and deploys are manual.

### Medium
- **M1. Service PATCH silently reset fields to their defaults. — FIXED in PR #1 (`d42c566`).** PATCH now uses `serviceUpdate`, a plain partial with no defaults, and rejects an empty body (`validation.ts`, `api/admin/services/[id]/route.ts`).
- **M2. Fault injection was reachable in production. — FIXED in PR #6 (`982b210`).** `faultInjectionEnabled` (`server/fault-injection.ts:11-15`) is always false when `VERCEL_ENV=production`, true for local dev/tests, and on preview deployments only with `FLOWOPS_ENABLE_FAULT_INJECTION=true`. `canInjectFaults` adds Owner/Admin only. `/api/bookings` returns 403 for a `failAgent` request that isn't allowed (`bookings/route.ts:13-14`), and the UI hides the control unless `/api/state` reports `faultInjection`.
- **M3. FlowAI had no role gate and wrote without approval. — FIXED in PR #7 (`db84465`).** Default-deny `FLOWAI_POLICY`, per-role tool filtering plus a re-check in every `execute`, approval on every write, and cancel limited to Owner/Admin (§7). Prompt-injected text from public bookings can still *propose* a create or reschedule, but it cannot run without the signed-in user approving it.
- **M4. SMS consent can be set by the model. — OPEN.** `createBooking` still takes `smsConsent` from the model (`assistant-tools.ts:131`, `151`). The new approval card for `createBooking` shows service, customer, date, time and email, but not whether SMS consent is being recorded, so the approver can't see it. The staff dashboard checkbox records no attestation beyond the audit actor. Needs a compliance review for the Twilio A2P campaign.
- **M5. The rate limiter failed open and shared one bucket for unknown IPs. — PARTLY FIXED in PR #4 (`7b9b70d`).** Fixed: DB errors now fall back to a per-instance in-memory limiter plus an alert (`rate-limit.ts:35-43`). **Still open:** requests without an IP still share the `"unknown"` key (`rate-limit.ts:53`), the fallback is per instance (up to N× during an outage), and nothing ever deletes `rate_limit` rows.
- **M6. Destructive hard deletes with no audit trail. — PARTLY FIXED in PR #11 (`7555304`).** Fixed: removing a team member no longer deletes the `user`; it deletes only the membership, signs them out and writes a `member.removed` audit row (`membership.ts:190-221`). **Still open:** accepting an invite (or a legacy-invite claim after verification) still deletes the user's previous empty auto-created workspace with no audit entry (`membership.ts:137-141`, `173-176`); this is now limited to workspaces with no other members and no bookings. The removed-member experience itself is open decision D-14 (§5).
- **M7. No inbound or status webhooks for Twilio and Resend, and no retry. — FIXED in PR #4 (`7b9b70d`).** Bounded retries with backoff, `notification_failure` + alerts, signed and deduped Twilio inbound/status and Resend webhooks, STOP/START written back to `sms_opt_out` and `booking.sms_consent`, and opted-out numbers skipped before sending (§6). Follow-ups: N3 (START date check) and N4 (webhook results not linked to notification rows). The webhook URLs, `RESEND_WEBHOOK_SECRET` and `TWILIO_STATUS_CALLBACK_URL` still have to be configured at go-live (**unverified**).
- **M8. One organization per user. — OPEN.** `member_user_unique` in `src/lib/db/schema.ts`. A founder who runs several businesses can't belong to more than one workspace with the same login. Product and architecture decision for Brian.
- **M9. Migrations run by hand from a workstation using a production env file. — OPEN.** README "Deploy" step 3 and `scripts/db-migrate.ts`; CI has no migration step. There are now seven migrations; whether `0003`–`0006` have been applied to production is **unverified**. Neon PITR and backups are **unverified**.

### Low
- **L1. — OPEN.** The public booking per-email cap (`src/app/api/public/[slug]/book/route.ts`) is checked outside the per-org lock, so concurrent requests can go over 5 per day.
- **L2. — OPEN.** Google disconnect only nulls the columns. The refresh token isn't revoked at Google.
- **L3. — OPEN.** Every derived secret comes from `BETTER_AUTH_SECRET` (`integrations/crypto.ts`, `assistant/route.ts:74`). Rotating it invalidates stored Google tokens, OAuth state and pending FlowAI approvals, and the approval secret falls back to `sha256("flowops:approval:")` if the env var is unset. This matters more now that every FlowAI write relies on approvals.
- **L4. — OPEN.** No security headers or CSP are configured (`next.config.ts`). HSTS at the Vercel edge is **unverified**.
- **L5. — OPEN.** The custom API routes rely on SameSite=Lax cookies alone for CSRF protection, with no Origin check, and `readJson` parses any content type. Defence-in-depth only.
- **L6. — OPEN, impact reduced by PR #3.** IDs still use `Math.random` (4 chars) plus a time slice plus a per-instance counter (`src/lib/booking/engine.ts:73-77`). A collision now aborts the transaction **before** anything is sent, so it no longer causes messages without records.
- **L7. — OPEN.** `GET /api/assistant` is unauthenticated and reveals the model name. `GET /api/public/[slug]` has no rate limit.
- **L8. — OPEN (accepted).** `joinOrgWithInvite` validates the invite outside the transaction (now deliberately, `membership.ts:124-127`). `consumeInvite` re-checks atomically, so the only effect is a less precise error message.
- **L9. — OPEN.** Timestamps are mixed: Better Auth, `organization` and `service` use `timestamp` without a time zone; the booking-side, reliability and billing tables use `timestamptz`. `booking.date` and `time` are org-local text.
- **L10. — OPEN.** Unique-pending-invite and slug-uniqueness checks happen in application code before insert or update. A race surfaces as a 500 from the DB unique index, or as two pending invites.
- **L11. — OPEN.** The Google `id_token` payload is decoded without signature verification. It's only used for a display email and comes directly from Google's token endpoint over TLS.

### New in this revision
- **N1. Several suites don't run in CI (medium).** `npm test` runs only vitest; the retry (RT), webhook-signature (WH) and rate-limit-fallback (RL) cases live in `scripts/run-tests.ts` (`test:sim`), and billing has its own `test:billing`, `test:billing:ui` and DB-backed `test:billing:db`; `test:db` also needs a local Postgres. None of these is in `ci.yml`. Recommendation: add `test:sim`, `test:billing` and `test:billing:ui` to CI (offline), or port them to vitest, and run the DB suites against PGlite or a service container.
- **N2. Canceled plan offers "Manage billing" (low).** `lockScreenCopy` maps `canceled` to the portal with "Restart it in billing" (`lock-copy.ts:28-29`), while the code treats canceled as terminal (`webhook.ts:166`) and checkout only refuses when a *live* subscription exists, so the working path back is a new checkout, not the portal. **Reported:** Bot's follow-up (show "Choose a plan" for `canceled`) is not merged into `main`.
- **N3. START restores consent using the database's date, not the business's (low).** `applySmsKeyword` compares `booking.date` (org-local text) with `to_char(now(), 'YYYY-MM-DD')` in the DB session's time zone (`webhooks/store.ts:98`), so near midnight a same-day booking can be missed or a just-past one restored. The STOP/START phone match also has no index on the normalized phone expression. **Reported:** Agent's follow-up (an additive phone index migration `0007` + an org-time-zone check, FO-044/FO-045) is not merged into `main`.
- **N4. Provider delivery results don't update notification rows (low).** Twilio status and Resend webhooks write `message_delivery_event` and, for failures, `notification_failure` with `organization_id = null` (`api/webhooks/twilio/status/route.ts`, `api/webhooks/resend/route.ts`). The `notification` row stays `sent` (meaning "provider accepted"), and the failure isn't tied to an org or booking, so a business can't see in its own dashboard that a text bounced.
- **N5. Stale comments after PR #3 (docs only).** `integrations/retry.ts:38` and `docs/reliability-notifications.md:6` still say notifications run inside the booking transaction; since PR #3 they run after commit.
- **N6. Post-commit side effects run outside the per-org lock (low).** Stated in `pipeline.ts:239-245`. Two quick reschedules of one booking can reach Google Calendar out of order.
- **N7. Text messages promised but not sent (low, compliance).** The `/sms-consent` page and `SMS_CONSENT_TEXT` (`src/lib/phone.ts:31`) list appointment **reminders**, but no code under `src/` sends reminders: notifications are only sent on create, reschedule and cancel. Either build reminders or drop them from the opt-in wording before the A2P campaign is reviewed.

### Unverified (needs infra, env or GitHub access, not visible in code)
- Production values of `REQUIRE_EMAIL_VERIFICATION`, `FLOWOPS_OWNER_EMAILS`, `BILLING_ENABLED`, `BILLING_EXEMPT_ORG_IDS`, `CRON_SECRET`, `RESEND_WEBHOOK_SECRET`, `TWILIO_STATUS_CALLBACK_URL`, and whether `staff_invite` has rows (affects H2).
- Whether the production schema matches migrations 0000–0006 (`__drizzle_migrations` table). Migrations 0003–0006 are on `main`; their production status isn't visible from the repo.
- Which commit production runs (**reported** `ee4079f`), branch protection / required checks (**reported** off), and CI run results on GitHub (I ran the same steps locally, see Method).
- Webhook endpoints configured in Twilio, Resend and Stripe; Twilio Advanced Opt-Out settings; the Vercel plan (cron frequency); Neon backup and PITR; the AI Gateway spend cap; Vercel edge headers and HSTS; the Google OAuth consent-screen mode.
- The DB-backed suites (`test:db`, `test:billing:db`), which I did not run.
