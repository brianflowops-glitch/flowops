# FlowOps — Architecture Audit (read-only)

- **Reflects commit:** `57458cd` (GitHub `main` of `brianflowops-glitch/flowops`). I first audited `4e76128` (v2.3.1). The only change in `4e76128..57458cd` is the import merge with the initial commit, which adds `LICENSE` (MIT). No source, schema, migration or config file changed, so every file:line reference below is the same at `57458cd`.
- **Date:** Oct 26, 2026 · **Author:** Flow Agent (Software Architect / Documentation & Progress Manager)
- **Method:** I read every file under `src/`, `drizzle/` and `scripts/` in a private clone. I ran `npm test` (8/8 simulation tests pass) and a Zod 4.6.7 behaviour check. I did not run any migrations, use any production data or read any env values. Env vars are listed by name only.
- **Rule:** this doc only states what the code shows. Anything that depends on production config or infrastructure is marked **unverified**.

---

## 1. Stack

| Layer | Technology (from `package.json`) |
|---|---|
| Framework | Next.js 16.4.3 (App Router, `cacheComponents`, `partialPrefetching`, Turbopack), React 19.3 |
| Language | TypeScript 5, Tailwind CSS 4 |
| Auth | Better Auth 1.7 (email + password, Drizzle adapter, `nextCookies` plugin) |
| DB | Postgres (Neon) via `pg` Pool + Drizzle ORM 0.45. Migrations use drizzle-kit 0.31, applied by `scripts/db-migrate.ts` (Neon serverless driver over WebSocket for `*.neon.tech`) |
| AI | AI SDK 6 (`ai`, `@ai-sdk/react`) calling Vercel AI Gateway by model string (default `openai/gpt-4.1-mini`) |
| Email | Resend REST API (raw `fetch`) |
| SMS | Twilio REST API (raw `fetch`) |
| Calendar | Google Calendar v3 REST + OAuth 2 (raw `fetch`) |
| Validation | Zod 4.6 |
| Hosting | Vercel (`@vercel/functions` `attachDatabasePool`, `ipAddress`) |

## 2. Folder layout

```
drizzle/                 0000_init.sql, 0001_team_invites.sql, 0002_booking_sms_consent.sql (+ meta snapshots)
scripts/
  db-migrate.ts          apply migrations + idempotent demo seed (MIGRATE_ONLY=1 skips seed)
  run-tests.ts           runs FL-001…FL-008 engine simulation suite (npm test)
src/
  proxy.ts               Next "proxy" (middleware): cookie-presence redirect only
  app/
    (marketing)/         home, terms, privacy (public)
    (dashboard)/         layout.tsx = real session gate; pages: / (Command Center), admin, agents,
                         analytics, automation, booking, integrations, network, security, testing
    sign-in, sign-up, forgot-password, reset-password, verify-email, invite/[token], book/[orgSlug]
    api/                 route handlers (see §4). There are no server actions ("use server" isn't used anywhere)
    robots.ts, sitemap.ts
  components/            client UI. views/* map 1:1 to dashboard pages. automation/integrations/network/
                         security are static sample-data pages (views/static-pages.tsx)
  lib/
    auth.ts, auth-client.ts         Better Auth server / client
    db/schema.ts, db/index.ts       Drizzle schema, lazy pg Pool (max 5)
    booking/engine.ts               6-agent pipeline (pure, adapter-injected), types.ts, tests.ts, store.tsx (client store)
    server/                         context (authz), pipeline (DB-backed engine runner), assistant-tools,
                                    rate-limit, validation, reset-link, invite-email, public-org, ai-errors,
                                    integrations/{google,notify,crypto}.ts
    tenancy/                        membership, invites, team-rules, defaults
    data/                           sample/static data for the demo pages
```

## 3. Data model

There are 3 migrations, and all of them are additive. `0000` creates every table except `team_invite`, `0001` adds `team_invite`, and `0002` adds `booking.sms_consent` and `booking.sms_consent_at`. There are no DB enums, so the "enum" columns are plain `text` checked only in TypeScript. IDs are app-generated `text`.

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
| `staff_invite` (legacy, pre-v2.1) | id PK, organization_id → org (cascade), email UNIQUE (global), invited_by → user (set null), created_at. Nothing in the code creates rows anymore. It is only read, consumed and deleted |

### Booking data (each table has `organization_id` → organization, on delete cascade)
| Table | Columns |
|---|---|
| `service` | id PK, organization_id, name, category appointment\|travel\|restaurant\|workforce, duration_min=60, resource, description, active=true, sort_order=0, created_at. Index on org |
| `booking` | id PK (`BK-…`), organization_id, customer, email, phone (E.164 when parseable), sms_consent=false, sms_consent_at (tz), category, service (**text copy, no FK to service**), resource (text, the conflict key), date `YYYY-MM-DD` and time `HH:MM` (org-local text), duration_min, notes, status confirmed\|cancelled, calendar_event_id, source dashboard\|assistant\|public, history jsonb[], created_at, updated_at (tz). Indexes on (org, date) and (org, status) |
| `audit_entry` | id PK, organization_id, at (tz), action, booking_id (no FK), agent, outcome, detail, actor. Index on (org, at) |
| `notification` | id PK, organization_id, at (tz), booking_id (no FK), recipient, channel, subject, delivery_status, detail. Index on (org, at) |

### How tenancy is enforced
- Isolation happens in the application only. There is no Postgres RLS. Every handler gets the org from `getContextFromHeaders` (`src/lib/server/context.ts:18-37`), which looks up `member` by `session.user.id`, and every query on tenant tables adds `eq(organizationId, ctx.org.id)`. I checked every route in §4 and each one scopes by `ctx.org.id`, or by the slug-resolved org on the public routes.
- Membership assignment (`src/lib/tenancy/membership.ts:28-80`) runs under the global advisory lock `flowops:membership`. The order is: token invite → legacy `staff_invite` email match → claim the demo org `org_flowops_demo` if it has no owner (limited by `FLOWOPS_OWNER_EMAILS`) → otherwise create a new org with the user as Owner.
- Pipeline writes are serialized per org with `pg_advisory_xact_lock(hashtext('flowops:org:<id>'))` (`src/lib/server/pipeline.ts:84`).

## 4. API routes and authorization

`requireApi(req, opts)` (`src/lib/server/context.ts:51-58`) returns 503 if there's no DB, 401 if there's no session or membership, 403 if `owner:true` and the role isn't owner, and 403 if `manager:true` and the role isn't owner or admin. The real check happens in each route. `src/proxy.ts` only checks that a cookie is present, and it excludes `/api/*`.

| Route | Method | Auth check | Notes |
|---|---|---|---|
| `/api/auth/[...all]` | GET/POST | Better Auth | sign-up/in/out, reset, verify. Better Auth rate limits |
| `/api/state` | GET | `requireApi()` any member | bookings, audit, notifications (200 each), services, team counts, integration status |
| `/api/bookings` | POST | `requireApi()` any member | create/reschedule/cancel through the pipeline. **Accepts `failAgent`** |
| `/api/assistant` | GET | **none** | returns `{configured, model}` |
| `/api/assistant` | POST | `requireApi()` any member + rate limit | FlowAI stream (see §7) |
| `/api/admin/org` | PATCH | owner | name, slug, timeZone, hours, publicBooking, googleCalendarId |
| `/api/admin/services` | GET | any member | |
| `/api/admin/services` | POST | owner | |
| `/api/admin/services/[id]` | PATCH, DELETE | owner, org-scoped | see finding M1 |
| `/api/admin/staff` | GET | any member (invites only if manager) | |
| `/api/admin/staff` | DELETE | manager + `canRemove` | removing a member **deletes the user row** |
| `/api/admin/invites` | POST | manager + `canInviteRole` | returns the raw link, emails it if Resend is set |
| `/api/admin/invites/[id]` | DELETE | manager + `canInviteRole`, org-scoped | revoke |
| `/api/admin/invites/[id]/resend` | POST | manager + `canInviteRole`, org-scoped | new token + expiry |
| `/api/admin/members/[id]/reset-link` | POST | manager + `canResetFor`, org-scoped | 24 h one-time reset link returned in the response |
| `/api/invites/[token]` | GET | public (token is the secret) | shows the invitee email only while pending |
| `/api/invites/[token]/accept` | POST | Better Auth session (no membership needed) | `joinOrgWithInvite` |
| `/api/integrations/google/connect` | GET | owner | HMAC-signed state `org:user:ts` |
| `/api/integrations/google/callback` | GET | owner + state check (same org/user, ≤15 min) | stores the encrypted refresh token |
| `/api/integrations/google/disconnect` | POST | owner | nulls the token columns |
| `/api/public/[slug]` | GET | public, needs `public_booking=true` | no rate limit |
| `/api/public/[slug]/availability` | GET | public, 60/min/IP | |
| `/api/public/[slug]/book` | POST | public, 8/10 min per page/IP, 20/h/IP, 5/email/org/day, honeypot `website` | response strips other customers' data |

Role rules (`src/lib/tenancy/team-rules.ts`): Owner can invite Admin or Staff, and Admin can invite Staff only. For reset links, Owner can reset anyone and Admin can reset Staff and themselves. No one can remove an Owner, and no one can remove themselves. Org settings, services and Google are Owner-only. Bookings and FlowAI are open to **every** role, including Staff.

Dashboard pages: `src/app/(dashboard)/layout.tsx:8-36` (redirect at line 20) redirects to `/sign-in` when `getContext()` returns null. The pages are client components that fetch `/api/state`.

## 5. Auth, sessions, password reset, invites

- **Config:** `src/lib/auth.ts:26-109`. Email and password are enabled with a minimum length of 10, and `autoSignIn` is on. Sessions live in Postgres with a 5-minute cookie cache (`auth.ts:75`). Cookies are SameSite=Lax (Better Auth default). Trusted origins are flowopsagent.ai, www, flowops-blue.vercel.app, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, plus localhost outside production. Client IP comes from the `x-vercel-forwarded-for`, `x-real-ip` and `x-forwarded-for` headers.
- **Email verification:** `requireEmailVerification` is only true when `REQUIRE_EMAIL_VERIFICATION=true` **and** `RESEND_API_KEY` is set (`notify.ts:12-14`). The README says production has Resend live and this flag off, but that is **unverified** from code. Verification mail is sent on sign-up when Resend is configured.
- **Password reset:** Better Auth's `/request-password-reset` emails a link valid for 1 h, and other sessions are revoked on reset (`auth.ts:44-55`, revoke at line 45). Owners and Admins can also mint a 24 h link (`src/lib/server/reset-link.ts:14-20`), which writes a Better Auth `verification` row directly.
- **Invites:** `src/lib/tenancy/invites.ts`. Tokens are 32 random bytes (base64url), only the SHA-256 hash is stored, they expire after 7 days, and they are single-use through a conditional `UPDATE … RETURNING` (`consumeInvite`, lines 67-82). Sign-up with `inviteToken` is validated in the Better Auth `user.create.before` hook (`auth.ts:95-100`) and consumed in `after` → `ensureMembership`. Existing users accept through `joinOrgWithInvite` (`membership.ts:92-121`). An existing Staff or Admin membership is replaced. An owner of an empty workspace has that workspace deleted. An owner of a non-empty workspace, or of the demo workspace, is refused.

## 6. Integrations and env vars (names only)

| Integration | Code | Env vars read |
|---|---|---|
| Postgres | `src/lib/db/index.ts:12,33`, `scripts/db-migrate.ts` | `DATABASE_URL`, `DB_DRIVER`, `MIGRATE_ONLY` (scripts) |
| Better Auth | `src/lib/auth.ts`, `invites.ts:33` | `BETTER_AUTH_SECRET` (implicit in Better Auth, also `crypto.ts:5`, `assistant/route.ts:74`), `BETTER_AUTH_URL`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `NODE_ENV` |
| Ownership | `membership.ts:10` | `FLOWOPS_OWNER_EMAILS` |
| Resend | `src/lib/server/integrations/notify.ts:5-64` | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (falls back to `onboarding@resend.dev`), `RESEND_REPLY_TO`, `REQUIRE_EMAIL_VERIFICATION` |
| Twilio | `notify.ts:32-156` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID` |
| AI Gateway | `src/app/api/assistant/route.ts:19-22` | `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `VERCEL`, `AI_GATEWAY_MODEL` |
| Google Calendar | `src/lib/server/integrations/google.ts`, `api/integrations/google/*` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_URL` (redirect URI) |

- **Google:** scopes are `calendar.events`, `openid` and `email`. The OAuth is per org, and the refresh token is AES-256-GCM encrypted with a key derived from `BETTER_AUTH_SECRET` (`crypto.ts:3-20`). Access tokens are refreshed for each pipeline run. Events are created, patched (recreated on a 404 or 410) and deleted. If a run fails, any event it created is deleted as compensation (`engine.ts:446-450`).
- **Resend and Twilio:** these are called from the Notification Agent (`engine.ts:363-399`) through `notifierAdapter` (`notify.ts:113-124`), with an 8 s timeout each. SMS is only sent when `sms_consent` is set and the phone parses to E.164. Failures are written to `notification.delivery_status='failed'` and logged with a masked number. There is **no** inbound webhook (STOP, HELP or delivery status callbacks) and no retry.
- Each integration falls back to "simulated" when its env vars are missing.

## 7. FlowAI (assistant)

`src/app/api/assistant/route.ts` + `src/lib/server/assistant-tools.ts`.
- **Auth:** `requireApi()`, so any member role works. There's no extra role gate, and rate limits are 6 per minute per user and 40 per hour per org. The last 30 UI messages are validated against the tool schemas. Limits are 8 steps and 1500 output tokens, with `maxDuration` of 60 s. The system prompt embeds the org name, user name and role, business hours and services.
- **Tools** (all scoped to `ctx.org.id`, with writes going through `runPipeline` and audited as `flowai:<email>`):
  | Tool | Effect | Guard |
  |---|---|---|
  | `listServices` | read | org scope |
  | `listBookings` | read (≤200 rows from DB, 50 returned; includes customer email) | org scope |
  | `checkAvailability` | read | org scope |
  | `createBooking` | write + sends real email/SMS | none beyond pipeline validation. `smsConsent` is set by the model |
  | `rescheduleBooking` | write + sends notifications | **no approval** |
  | `cancelBooking` | write + sends notifications | `needsApproval: true`, an AI SDK tool-approval signed with `sha256("flowops:approval:"+BETTER_AUTH_SECRET)` |

## 8. Booking pipeline

`runPipeline` (`src/lib/server/pipeline.ts:77-164`) opens a DB transaction and takes the per-org advisory lock. It loads the working set (confirmed bookings from yesterday onward, plus the target booking) and runs `BookingEngine` through Intent → Booking → Availability → Calendar → Notification → Audit. It then persists the booking, audit and notifications in the same transaction. Notifications are only stored when the run succeeds, but audit entries for failures are always stored.

## 9. Rate limiting

- Better Auth (DB storage) allows 60 requests per 60 s by default, `/sign-up/*` is limited to 5 per 600 s, and `/sign-in/*` to 10 per 60 s (`auth.ts:79-88`).
- The FlowOps limiter (`src/lib/server/rate-limit.ts:16-36`) is a fixed window built on one atomic upsert into `rate_limit`. It **fails open** on DB errors. The IP comes from `ipAddress()` and falls back to `"unknown"`, which means a single shared bucket.
- It's used on public book, availability and FlowAI (see §4 and §7). Invite lookup, invite accept, `/api/public/[slug]`, `/api/bookings` and the admin routes have no app-level limit.

## 10. Tests and CI

- `npm test` → `scripts/run-tests.ts` runs `src/lib/booking/tests.ts`, which holds FL-001…FL-008. These are in-memory `BookingEngine` simulations (create, conflict, reschedule, cancel, notification, fault-injection rollback, audit, SMS opt-in). **I ran them on Oct 26, 2026 and got 8 passed, 0 failed.** The same suite runs in the browser on the Testing Lab page.
- There are **no** test files for API routes, auth, tenancy, authorization, invites, rate limiting, migrations or FlowAI tools, and no test framework (no vitest or jest).
- There is **no CI** (no `.github/workflows`, no other pipeline config). `eslint src` exits clean. `tsc --noEmit` fails on `LayoutProps` until `next typegen` or `next build` generates the route types, so CI will need `next typegen` first. I did not run `next build`.

---

## 11. Findings

Severity: **critical** = exploitable or data loss now · **high** = must fix before release gate · **medium** = fix before commercial launch · **low** = hardening.
I found no critical issues in the code itself. **Status at `57458cd`:** every finding below is still open, and none are fixed yet.

### High
- **H1. External calls run inside the DB transaction and advisory lock, and their side effects aren't rolled back.** `src/lib/server/pipeline.ts:83-100` wraps the whole engine run in `db.transaction` with the per-org lock. The Calendar step (`src/lib/booking/engine.ts:333-360`) and Notification step (`engine.ts:363-399`) make up to about 4 sequential network calls, each with an 8 s timeout, while holding one of only 5 pool connections (`src/lib/db/index.ts:16`) and blocking every other booking for that org. If the later inserts fail (`pipeline.ts:124-160`, e.g. a PK collision, see L6), the transaction rolls back after the customer was already emailed or texted and the Google event was created, and no compensation runs for that case. Recommendation: commit the booking first, then send notifications and calendar writes through an outbox or queue with retries. This overlaps with Agent's alerts and retries work.
- **H2. Email ownership is never verified, and the legacy email-match invites rely on it.** `src/lib/auth.ts:43` together with `src/lib/server/integrations/notify.ts:12-14` (README: verification is off in prod, **unverified**). Anyone can register any email address. `src/lib/tenancy/membership.ts:45-52` puts a new sign-up into an org as Staff purely because its email matches a `staff_invite` row, so whoever registers that address first gets full booking and customer-PII access and FlowAI. The impact depends on whether any `staff_invite` rows exist in production (**unverified**). Recommendation: turn on `REQUIRE_EMAIL_VERIFICATION` (Resend is live), and retire or require verification for `staff_invite`.
- **H3. Authorization, tenancy, auth and API behaviour have no automated tests and no CI.** `scripts/run-tests.ts:1-15` only covers the in-memory engine. The procedure's Gate 3 can't be met. Jarvis is starting this.

### Medium
- **M1. Service PATCH silently resets fields to their defaults.** `src/app/api/admin/services/[id]/route.ts:10` uses `serviceInput.partial()`. In Zod 4.6.7, `.partial()` still applies `.default()`, which I confirmed by running it: `{name}` parses to `{name, category:"appointment", active:true, sortOrder:0}`. The Admin UI's show/hide toggle (`src/components/views/administration.tsx:199`) sends `{active}` only, so every toggle resets the service's `category` to `appointment` and `sort_order` to 0. Recommendation: build the partial schema without defaults.
- **M2. Fault injection is reachable in production.** `src/lib/server/validation.ts:23-25` and `src/app/api/bookings/route.ts:10-11` let any member pass `failAgent`. With `failAgent:"AuditAgent"`, real emails and texts still go out (`engine.ts:363-399`) but nothing is saved, so a Staff user can send messages to any address with no booking or notification record. Recommendation: allow `failAgent` only when `NODE_ENV!=="production"` or for the demo org.
- **M3. FlowAI has no role gate and writes without approval.** `src/app/api/assistant/route.ts:33` accepts any role. `rescheduleBooking` (`src/lib/server/assistant-tools.ts:142-147`) and `createBooking` (`:101-140`) run without approval. Tool output contains text typed by the public (customer names and emails from `/book`, see `assistant-tools.ts:76-87`), which makes indirect prompt injection that triggers reschedules or messages possible. Recommendation: `needsApproval` on every write, plus a role policy.
- **M4. SMS consent can be set by the model.** In `src/lib/server/assistant-tools.ts:107-110`, the model decides whether `smsConsent=true` from what the user says, and that becomes the A2P 10DLC consent record (`booking.sms_consent_at`). The staff dashboard checkbox works the same way and records no attestation beyond the audit actor. This needs a compliance review given the Twilio campaign situation.
- **M5. The rate limiter fails open and shares one bucket for unknown IPs.** `src/lib/server/rate-limit.ts:28-30` lets everything through on a DB error (Agent also flagged this). `rate-limit.ts:41` sends every request without an IP into one shared `"unknown"` key. Nothing ever deletes `rate_limit` rows, so the table grows without limit.
- **M6. Destructive hard deletes with no audit trail.** `src/app/api/admin/staff/route.ts:62` deletes the whole `user` (login, sessions, accounts) when someone is removed from the team, and `src/lib/tenancy/membership.ts:111` deletes the user's previous org when an invite is accepted. Neither writes an `audit_entry`, and there's no soft delete.
- **M7. No inbound or status webhooks for Twilio and Resend, and no retry.** `notify.ts:67-105` and `48-64` record only whether the API accepted the message. STOP opt-outs aren't written back to `booking.sms_consent`, and they only show up as error 21610 on the next send. There's no delivery-status tracking.
- **M8. One organization per user.** `member_user_unique` at `src/lib/db/schema.ts:120`. A founder who runs several businesses (Brian has four) can't belong to more than one workspace with the same login. This is a product and architecture decision for Brian.
- **M9. Migrations run by hand from a workstation using a production env file** (README "Deploy" step 3, `scripts/db-migrate.ts`). There's no migration step in CI, and nothing in the repo describes backups or restores. Neon PITR and backups are **unverified**.

### Low
- **L1.** The public booking per-email cap (`src/app/api/public/[slug]/book/route.ts:33-44`) is checked outside the per-org lock, so concurrent requests can go over 5 per day.
- **L2.** Google disconnect only nulls the columns (`src/app/api/integrations/google/disconnect/route.ts:8-11`). The refresh token isn't revoked at Google.
- **L3.** Every derived secret comes from `BETTER_AUTH_SECRET` (`src/lib/server/integrations/crypto.ts:3-7`, `src/app/api/assistant/route.ts:74`). Rotating it invalidates the stored Google tokens and the OAuth state, and the approval secret falls back to `sha256("flowops:approval:")` if the env var is unset.
- **L4.** No security headers or CSP are configured (`next.config.ts:3-15`). Whether HSTS is set at the Vercel edge is **unverified**.
- **L5.** The custom API routes rely on SameSite=Lax cookies alone for CSRF protection, with no Origin check, and `readJson` (`src/lib/server/validation.ts:82-88`) parses any content type. Lax currently blocks cross-site POSTs, so this is defence-in-depth only.
- **L6.** Booking, audit and notification IDs use `Math.random` with 4 chars plus a time slice plus a per-instance counter (`src/lib/booking/engine.ts:73-77`). A collision is unlikely but would abort the transaction after messages were sent (see H1).
- **L7.** `GET /api/assistant` (`route.ts:24-28`) is unauthenticated and reveals the model name. `GET /api/public/[slug]` has no rate limit.
- **L8.** `joinOrgWithInvite` validates the invite with `findUsableInvite` outside the transaction (`membership.ts:99`, `invites.ts:42-50` uses `getDb()`, not `tx`). `consumeInvite` re-checks atomically, so the only effect is a less precise error message.
- **L9.** Timestamps are mixed: Better Auth, `organization` and `service` tables use `timestamp` without a time zone, while the booking-side tables use `timestamptz`. `booking.date` and `time` are org-local text.
- **L10.** Unique-pending-invite and slug-uniqueness checks happen in application code before insert or update (`api/admin/invites/route.ts:29-42`, `api/admin/org/route.ts:16-24`). A race surfaces as a 500 from the DB unique index, or as two pending invites, since `team_invite` has no unique (org, email) pending constraint.
- **L11.** The Google `id_token` payload is decoded without signature verification (`api/integrations/google/callback/route.ts:21-25`). It's only used for a display email and comes directly from Google's token endpoint over TLS.

### Unverified (needs infra or env access, not visible in code)
- Production values of `REQUIRE_EMAIL_VERIFICATION` and `FLOWOPS_OWNER_EMAILS`, and whether `staff_invite` has rows (affects H2).
- Whether the production schema matches migrations 0000–0002 (`__drizzle_migrations` table).
- Neon backup and PITR settings, the AI Gateway spend cap, Vercel edge headers and HSTS, and the Google OAuth consent-screen mode (Ryan reports Testing).
- Whether `next build` succeeds at this commit (I didn't run it). Lint is clean, and `tsc` needs generated route types.
