# FLOWOPS — Unified Operations Intelligence Platform (v2.3 beta)

FLOWOPS is an ops dashboard built around the **FLOWOPS Agent Matrix** (FLOWOPS Core, FlowNet, FlowSec, FlowBiz, FlowAI, FlowConnect, FlowPulse). v2 adds a real backend: accounts, a Postgres database, per-business data, a public booking page and FlowAI tools that act on bookings.

| Page | What it does |
| --- | --- |
| **Landing page** (`/` signed out → renders `/home`) | Public marketing page: booking page, calendar sync, email confirmations, FlowAI, team roles, how it works, "Founding pilot program" CTA (mailto support@flowopsagent.ai, `CONTACT_EMAIL` in `src/components/marketing/site-chrome.tsx`). **No prices** until pricing is approved. The proxy *rewrites* `/` to `/home` when there is no session cookie, so the URL stays `flowopsagent.ai/` and signed-in users still get the Command Center at `/` |
| **Terms / Privacy** (`/terms`, `/privacy`) | Public, marked **"Draft — not legal advice, pending review"**. Privacy covers accounts, bookings, end-customer contact info, Google `calendar.events` (with Limited Use statement), Resend, AI Gateway/model providers, Vercel, Neon, Twilio, Cloudflare. Linked from the landing footer and sign-up form; these are the homepage + privacy URLs for Google OAuth verification. Also `/robots.txt`, `/sitemap.xml` |
| **Sign up / Sign in** (`/sign-up`, `/sign-in`) | Email + password (Better Auth, sessions in Postgres). Every dashboard page requires sign-in |
| **Forgot / reset password** (`/forgot-password`, `/reset-password`) | Request a reset link (same answer whether or not the email exists; link expires in 1 h, works once, signs out other sessions). While email is simulated, an Owner/Admin generates the link in Administration → Team |
| **Verify email** (`/verify-email`) | Landing page for the verification link. Unverified users see a banner; nothing is blocked unless `REQUIRE_EMAIL_VERIFICATION=true` |
| **Team invite** (`/invite/<token>`) | Invitee creates an account (or, if signed in with the invited email, joins) with the invited role |
| **Command Center** | **Getting-started checklist** for Owners of new workspaces (business name & hours, services, share booking link, connect Google Calendar, invite team) — auto-detected where possible, hides when all done or dismissed (remembered per workspace in the browser). Live booking stats for your org, sample ops KPIs (labelled), schedule and module status |
| **Booking Center** | **Working feature.** Pipeline Intent → Booking → Availability → Calendar → Notification → Audit → VERIFIED, saved in Postgres per org. Create / reschedule / cancel, conflicts, fault injection, audit log (with actor), notifications outbox |
| **Public booking page** (`/book/<org-slug>`) | Customers (no account) pick a service, date and open time, enter name/email/phone and an **unchecked SMS opt-in** ("Text me about this appointment. Msg & data rates may apply. Reply STOP to opt out."). Same pipeline + conflict checks; shows up in the dashboard with source "public" |
| **Administration** | Owner: business name, booking-page slug and on/off, opening hours, services (duration, resource), integrations (Google Calendar connect). Owner + Admin: **Team** — invite by email with a role, list / resend / revoke invites, one-time password-reset links, remove members |
| **Testing Lab** | Simulation tests FL-001 … FL-007 against the pipeline in the browser |
| **FlowAI Assistant** (slide-out) | Vercel AI Gateway (AI SDK v6). Tools: list services, list bookings, check availability, create, reschedule, cancel (cancel asks you to confirm in the panel). Every tool action runs through the same pipeline and is audited as `flowai:<email>` |
| Automation, Network, Security, Integrations | Planned features with **sample data (labelled)** |

### Accounts and roles

- **Owner** — the first sign-up. On a fresh database the first sign-up whose email is in `FLOWOPS_OWNER_EMAILS` (or anyone, if unset) becomes Owner of the seeded demo org `flowops-demo` (renamed to their business name if they enter one).
- Any other sign-up without an invite gets **its own new organization** (and is its Owner). `FLOWOPS_OWNER_EMAILS` only controls who may claim `flowops-demo`; it never puts a stranger into an existing business.
- **Admin** — invited by the Owner. Manages the team (invites Staff, resend/revoke, reset links for Staff and themselves, remove Staff). Can't change settings, invite Admins, or touch the Owner.
- **Staff** — invited by an Owner or Admin. Uses bookings and FlowAI; no Administration changes.
- **Customers** have no accounts; they use the public booking page.

#### Invites

- Owner/Admin enters an email + role in Administration → Team. FlowOps creates a **single-use token** (256-bit, only its SHA-256 hash is stored in `team_invite`), valid **7 days**, scoped to that organization. The inviter always gets a **copyable link** (`/invite/<token>`); it is also emailed when Resend is configured.
- **Resend** issues a new token and expiry (the previous link stops working) — also how you get a fresh link for an expired or revoked invite. **Revoke** disables the link immediately.
- Accepting: a new person signs up on the invite page (email fixed to the invited address — the token must match that email); an existing user signed in with that email clicks *Accept* and is moved into the organization (accounts belong to one org; an empty auto-created workspace is removed, a workspace with bookings or teammates blocks the move).
- Older email-match invites (`staff_invite`, pre-v2.1) still work: signing up with that email joins as Staff.

#### Password reset and email verification

- `/forgot-password` always answers "If an account exists…". With Resend configured the link is emailed (1 h); without it the link is **dropped — never sent, logged or shown**.
- Owner/Admin → Team → key icon generates a **one-time reset link** (24 h) for a member of their own org (Owner: anyone; Admin: Staff and self). It is shown only to them, to share privately. Using it signs that member out elsewhere.
- Verification emails go out on sign-up when Resend is configured (link valid 24 h → `/verify-email`). Unverified users see a "Verify your email" banner (with a *Send verification email* button once Resend is live).
- `REQUIRE_EMAIL_VERIFICATION=true` (default off) blocks sign-in until verified — **only once Resend is configured**, so nobody is locked out while email is simulated. Existing users signed up unverified; turning it on later means they verify on their next sign-in (a fresh link is emailed automatically).
- Sessions use a 5-minute cookie cache, so a revoked session (password reset, removed member) can linger up to 5 minutes.

### Rate limits (v2.2)

All stored in the Postgres `rate_limit` table (shared with Better Auth; FlowOps keys are prefixed `flowops:`), keyed by client IP from `x-vercel-forwarded-for` / `x-real-ip`. Helper: `src/lib/server/rate-limit.ts` (fails open on DB errors).

| Endpoint | Limit |
| --- | --- |
| `/api/auth/sign-up/*` | 5 / 10 min per IP (+ Better Auth's 3 / 10 s) |
| `/api/auth/sign-in/*` | 10 / min per IP |
| Password-reset / verification emails | 3 / min per IP (Better Auth default) |
| Other auth endpoints | 60 / min per IP |
| `POST /api/public/<slug>/book` | 8 / 10 min per IP per booking page, 20 / hour per IP overall (plus the existing 5 bookings / email / day) |
| `GET /api/public/<slug>/availability` | 60 / min per IP |
| `POST /api/assistant` (FlowAI) | 6 / min per user, 40 / hour per workspace |

FlowAI turns AI Gateway errors into friendly messages (`src/lib/server/ai-errors.ts`): rate limit → "wait about a minute", out of credit, auth, other. 429s return JSON `{ error, retryAfter }` with `Retry-After`.

### What is real and what is simulated

- **Real:** accounts/sessions, organizations, bookings, audit log, notifications outbox, services and hours — all in Postgres, isolated per org. Pipeline runs are transactional (row-locked per org); if any agent fails nothing is saved and the failure is audited (FL-006).
- **Calendar Agent** — real Google Calendar once `GOOGLE_CLIENT_ID/SECRET` are set **and** the Owner connects a calendar; otherwise **simulated** (`SIMCAL-…` IDs, labelled).
- **Notification Agent** — real email via Resend when `RESEND_API_KEY` (+ `RESEND_FROM_EMAIL`) is set, real SMS via Twilio when `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID`) are set; otherwise **simulated** ("email (simulated)", nothing sent).

### SMS (Twilio, v2.3)

- Texts go out for **create / reschedule / cancel** only when the booking has a phone **and** `sms_consent = true` (public form checkbox, the staff "Customer agreed to get texts" box, or FlowAI's `smsConsent` when the user says the customer agreed). Consent + time are stored on the booking (`booking.sms_consent`, `booking.sms_consent_at`, migration `0002_booking_sms_consent`, additive) as the A2P 10DLC opt-in record.
- Phones are normalized to E.164 (`src/lib/phone.ts`, US-first: 10 digits → `+1…`, `1`+10 → `+1…`, explicit `+cc` kept). Opt-in with an invalid number is rejected; without opt-in the number is stored as entered if it can't be normalized.
- Message: `<Business>: Booking confirmed: … Ref BK-…. Reply STOP to opt out.` Twilio handles STOP/HELP on the number itself.
- Failures never block the booking: the notification is recorded as `failed` with the Twilio code (e.g. 21608 trial/unverified, 21610 opted out) and logged as `[twilio] sms BK-… to •••1234 failed — …` (masked number, no secrets).
- Administration → Integrations shows SMS as **configured** (full account + number), **trial** (trial account — texts only reach verified numbers), **needs number** (credentials set, no `TWILIO_FROM_NUMBER`), **not set**, or **error** (account check failed). The account type comes from a read-only Twilio Accounts API call cached 10 min.
- Production (Oct 25, 2026): `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (sensitive) set for Production; trial account, **no number yet** → status "needs number", SMS still simulated. To go live: `vercel env add TWILIO_FROM_NUMBER production` (E.164, e.g. `+16105550100`) and redeploy. Before texting real customers: upgrade the account and complete A2P 10DLC registration (the opt-in checkbox + `/privacy` SMS section are the evidence).
- **Account emails** (verification, password reset, invites) — real via Resend when configured; otherwise simulated: nothing is sent and links are only shown to Owners/Admins in Team.
- Network, Security, Automation and the "Operations" KPIs are **sample data**, labelled.

## Run locally

```bash
npm install
cp .env.example .env.development.local   # fill DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL
npm run db:migrate:local   # applies drizzle/ migrations + seeds demo org "flowops-demo"
npm run dev                # http://localhost:3000 → sign up first to become Owner
npm test                   # FL-001 … FL-008 simulation suite in Node
npm run lint && npm run build
```

Schema changes: edit `src/lib/db/schema.ts`, then `npm run db:generate` and `npm run db:migrate`.

FlowAI locally: `vercel env pull` (short-lived `VERCEL_OIDC_TOKEN`) or `AI_GATEWAY_API_KEY`.

## Deploy to Vercel

1. Database: add **Neon** from the Vercel Marketplace (free plan) to project `flowops` — it injects `DATABASE_URL`.
2. Env vars (Production): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://flowopsagent.ai`, `FLOWOPS_OWNER_EMAILS`. Optional: integration vars and `REQUIRE_EMAIL_VERIFICATION` from `.env.example`.
   - **Email is live in production** (Oct 25, 2026): `RESEND_API_KEY` (sensitive) and `RESEND_FROM_EMAIL=FlowOps <notifications@flowopsagent.ai>` are set for Production only; the `flowopsagent.ai` domain is verified in Resend (DNS records in Cloudflare). Verification, password-reset, invite and booking emails send for real. `REQUIRE_EMAIL_VERIFICATION` is still off.
3. Migrate: `vercel env pull .env.production.local --environment production` then `npx dotenv -e .env.production.local -- npm run db:migrate` (delete the file afterwards). Neon URLs migrate over Neon's serverless driver (port 443), so this works where port 5432 is blocked. Migrations are additive (`0001_team_invites` adds the `team_invite` table only; `0002_booking_sms_consent` adds two booking columns).
4. Deploy: `npx vercel deploy --prod --yes --scope flowopsagent`.
5. Domain `flowopsagent.ai` is already attached.

## Project structure

```
src/
  app/
    (marketing)/             # public: home (landing), terms, privacy
    (dashboard)/             # signed-in app: layout (session gate), Command Center + module pages
    sign-in/ sign-up/        # auth pages
    forgot-password/ reset-password/ verify-email/
    invite/[token]/          # accept a team invite
    book/[orgSlug]/          # public booking page
    api/auth/[...all]        # Better Auth
    api/state, api/bookings  # org state + pipeline actions
    api/admin/*              # org, services (Owner); staff, invites, members/[id]/reset-link (Owner/Admin)
    api/invites/[token]      # public invite lookup + accept (signed in)
    api/public/[slug]/*      # public info, availability, book
    api/integrations/google  # OAuth connect/callback/disconnect
    api/assistant            # FlowAI (AI Gateway + tools)
  proxy.ts                   # signed out: "/" → rewrite to /home; other app pages → /sign-in
  components/
    app-shell.tsx  assistant-panel.tsx  pipeline.tsx  ui.tsx
    views/                   # page bodies (client components where interactive)
  lib/
    booking/
      types.ts               # Booking, AgentStep, AuditEntry, …
      engine.ts              # BookingEngine: the 6-agent pipeline
      tests.ts               # FL-001 … FL-007
      store.tsx              # React context backed by the API
    db/                      # Drizzle schema + client
    auth.ts auth-client.ts   # Better Auth server/client
    tenancy/                 # demo org defaults, membership/ownership rules, invites, team permission rules
    server/                  # pipeline (Postgres), context, validation, assistant tools, integrations
    data/
      platform.ts            # modules, agents, nav, phases, roadmap
      integrations.ts        # integration targets
      sample.ts              # SAMPLE data (labelled in the UI)
scripts/run-tests.ts         # `npm test`
scripts/db-migrate.ts        # migrations + demo seed
drizzle/                     # SQL migrations
```

## Roadmap

Phase plan from the Phase 1 kickoff (2026):

| Phase | Dates | Focus |
| --- | --- | --- |
| P1 | Oct 24–25 | Booking Agent architecture (this prototype) |
| P2 | Oct 26–27 | Calendar integration testing on a Google Calendar **test calendar** |
| P3 | Oct 28–29 | Booking automation workflows |
| P4 | Oct 30–31 | Agent-to-agent communication |
| P5 | Nov 1–2 | End-to-end testing |
| P6 | Nov 3 | Results review and UI planning |

Next platform work:

- [x] **Postgres** for bookings, audit log and notifications (v2)
- [x] **Backend API** with per-org data (v2)
- [x] **Authentication, roles and tenants** (v2)
- [~] **Google Calendar** — code ready; needs OAuth client credentials
- [~] Real **Notification Agent** — Resend email live; Twilio SMS wired with opt-in (v2.3), waiting on a sending number + A2P 10DLC
- [x] Email verification, password reset and token team invites (v2.1 — emails go out once Resend is configured)
- [x] Public landing page, draft Terms/Privacy, onboarding checklist, rate limits (v2.2)
- [ ] Lawyer review of Terms/Privacy; Google OAuth verification (homepage `/`, privacy `/privacy`)
- [ ] Billing / plans for selling FlowOps
- [ ] Event bus (NATS/Kafka/RabbitMQ) for agent-to-agent messaging
- [ ] Durable workflows (Temporal/Prefect) for the Automation Center
- [ ] FlowNet/FlowSec/FlowPulse connectors: Firewalla, SNMP/syslog, CrowdStrike/SentinelOne, Datadog/Grafana/Zabbix
- [ ] FlowAI: RAG memory, policy context (OPA/Casbin), tool routing
- [ ] Monorepo split (`apps/web`, `services/api`, `services/agents`, `services/booking`, `packages/shared`) as services are added
