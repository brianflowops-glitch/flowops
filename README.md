# FLOWOPS — Unified Operations Intelligence Platform (v2 beta)

FLOWOPS is an ops dashboard built around the **FLOWOPS Agent Matrix** (FLOWOPS Core, FlowNet, FlowSec, FlowBiz, FlowAI, FlowConnect, FlowPulse). v2 adds a real backend: accounts, a Postgres database, per-business data, a public booking page and FlowAI tools that act on bookings.

| Page | What it does |
| --- | --- |
| **Sign up / Sign in** (`/sign-up`, `/sign-in`) | Email + password (Better Auth, sessions in Postgres). Every dashboard page requires sign-in |
| **Command Center** | Live booking stats for your org, sample ops KPIs (labelled), schedule and module status |
| **Booking Center** | **Working feature.** Pipeline Intent → Booking → Availability → Calendar → Notification → Audit → VERIFIED, saved in Postgres per org. Create / reschedule / cancel, conflicts, fault injection, audit log (with actor), notifications outbox |
| **Public booking page** (`/book/<org-slug>`) | Customers (no account) pick a service, date and open time, enter name/email/phone. Same pipeline + conflict checks; shows up in the dashboard with source "public" |
| **Administration** | Owner only: business name, booking-page slug and on/off, opening hours, services (duration, resource), team invites (Staff), integrations (Google Calendar connect) |
| **Testing Lab** | Simulation tests FL-001 … FL-007 against the pipeline in the browser |
| **FlowAI Assistant** (slide-out) | Vercel AI Gateway (AI SDK v6). Tools: list services, list bookings, check availability, create, reschedule, cancel (cancel asks you to confirm in the panel). Every tool action runs through the same pipeline and is audited as `flowai:<email>` |
| Automation, Network, Security, Integrations | Planned features with **sample data (labelled)** |

### Accounts and roles

- **Owner** — the first sign-up. On a fresh database the first sign-up whose email is in `FLOWOPS_OWNER_EMAILS` (or anyone, if unset) becomes Owner of the seeded demo org `flowops-demo` (renamed to their business name if they enter one).
- Any other sign-up gets **its own new organization** (and is its Owner).
- **Staff** — invited by an Owner in Administration → Team, then signs up with that email. Staff can use bookings and FlowAI but not Administration.
- **Customers** have no accounts; they use the public booking page.

### What is real and what is simulated

- **Real:** accounts/sessions, organizations, bookings, audit log, notifications outbox, services and hours — all in Postgres, isolated per org. Pipeline runs are transactional (row-locked per org); if any agent fails nothing is saved and the failure is audited (FL-006).
- **Calendar Agent** — real Google Calendar once `GOOGLE_CLIENT_ID/SECRET` are set **and** the Owner connects a calendar; otherwise **simulated** (`SIMCAL-…` IDs, labelled).
- **Notification Agent** — real email via Resend when `RESEND_API_KEY` (+ `RESEND_FROM_EMAIL`) is set, real SMS via Twilio when `TWILIO_*` is set; otherwise **simulated** ("email (simulated)", nothing sent).
- Not yet: email verification / password reset emails, invite emails (tell staff to sign up with the invited address).
- Network, Security, Automation and the "Operations" KPIs are **sample data**, labelled.

## Run locally

```bash
npm install
cp .env.example .env.development.local   # fill DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL
npm run db:migrate:local   # applies drizzle/ migrations + seeds demo org "flowops-demo"
npm run dev                # http://localhost:3000 → sign up first to become Owner
npm test                   # FL-001 … FL-007 simulation suite in Node
npm run lint && npm run build
```

Schema changes: edit `src/lib/db/schema.ts`, then `npm run db:generate` and `npm run db:migrate`.

FlowAI locally: `vercel env pull` (short-lived `VERCEL_OIDC_TOKEN`) or `AI_GATEWAY_API_KEY`.

## Deploy to Vercel

1. Database: add **Neon** from the Vercel Marketplace (free plan) to project `flowops` — it injects `DATABASE_URL`.
2. Env vars (Production): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://flowopsagent.ai`, `FLOWOPS_OWNER_EMAILS`. Optional integration vars from `.env.example`.
3. Migrate: `vercel env pull .env.production.local --environment production` then `npx dotenv -e .env.production.local -- npm run db:migrate` (delete the file afterwards).
4. Deploy: `npx vercel deploy --prod --yes --scope flowopsagent`.
5. Domain `flowopsagent.ai` is already attached.

## Project structure

```
src/
  app/
    (dashboard)/             # signed-in app: layout (session gate), Command Center + module pages
    sign-in/ sign-up/        # auth pages
    book/[orgSlug]/          # public booking page
    api/auth/[...all]        # Better Auth
    api/state, api/bookings  # org state + pipeline actions
    api/admin/*              # org, services, staff (Owner)
    api/public/[slug]/*      # public info, availability, book
    api/integrations/google  # OAuth connect/callback/disconnect
    api/assistant            # FlowAI (AI Gateway + tools)
  proxy.ts                   # redirects signed-out users to /sign-in
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
    tenancy/                 # demo org defaults, membership/ownership rules
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
- [~] Real **Notification Agent** — Resend/Twilio code ready; needs API keys
- [ ] Email verification, password reset and invite emails
- [ ] Billing / plans for selling FlowOps
- [ ] Event bus (NATS/Kafka/RabbitMQ) for agent-to-agent messaging
- [ ] Durable workflows (Temporal/Prefect) for the Automation Center
- [ ] FlowNet/FlowSec/FlowPulse connectors: Firewalla, SNMP/syslog, CrowdStrike/SentinelOne, Datadog/Grafana/Zabbix
- [ ] FlowAI: RAG memory, policy context (OPA/Casbin), tool routing
- [ ] Monorepo split (`apps/web`, `services/api`, `services/agents`, `services/booking`, `packages/shared`) as services are added
