# FLOWOPS — Unified Operations Intelligence Platform (v1 prototype)

FLOWOPS is an ops dashboard built around the **FLOWOPS Agent Matrix**. The modules are FLOWOPS Core, FlowNet, FlowSec, FlowBiz, FlowAI, FlowConnect and FlowPulse. Version 1 is a Next.js port of the v0.1 Streamlit prototype.

| Page | What it does in v1 |
| --- | --- |
| **Command Center** | Live Booking Engine stats from this browser, sample ops KPIs (labelled), the Phase 1 schedule and module status |
| **Agent Matrix** | The 24 proposed agents (CoreAI, OpsAgent, NetAgent, SecAgent, BizAgent and others) with module filters and the agent system model |
| **Booking Center** | **Working feature.** It runs the booking pipeline: Intent → Booking → Availability → Calendar → Notification → Audit → VERIFIED. You can create, reschedule and cancel bookings, and there are tabs for conflict detection, fault injection, the audit log and the notifications outbox |
| **Testing Lab** | Runs simulation tests FL-001 to FL-007 against the real pipeline in the browser and shows pass/fail per assertion |
| **Analytics** | Live booking charts from this browser, plus one sample trend chart (labelled) |
| Automation, Network, Security, Integrations, Administration | Planned features shown with **sample data (labelled "Sample data — not connected")** and the integrations the plan calls for |
| **FlowAI Assistant** (slide-out panel) | Calls OpenAI through `/api/assistant` when `OPENAI_API_KEY` is set. Otherwise it says the backend isn't connected |

### What is real and what is simulated

- Bookings, audit entries and notifications are kept **in memory and persisted to the browser's `localStorage`**. Nothing is stored on a server, and each browser has its own data. *Reset* clears it.
- The **Calendar Agent and Notification Agent are simulated.** Calendar event IDs look like `SIMCAL-…`, and no event is created and no email is sent.
- Every pipeline run is transactional. If any agent fails, the draft is discarded and the Audit Agent still records the failure (FL-006).
- Numbers on the Network, Security, Automation and Administration pages and the "Operations" KPIs are **sample data**, and they're labelled that way everywhere they appear.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # FL-001 … FL-007 simulation suite in Node
npm run build && npm start   # production build
```

Optional: copy `.env.example` to `.env.local` and set `OPENAI_API_KEY` (and `OPENAI_MODEL`, default `gpt-4o-mini`) to turn on the assistant.

## Deploy to Vercel

The app needs **no environment variables** to deploy.

1. Push this repo to GitHub (e.g. `brianflowops-glitch/flowops`).
2. In Vercel, go to team **Flowops** (`flowopsagent`), choose **Add New → Project**, import the repo and keep the defaults (framework: Next.js).
   Or use the CLI: `npx vercel --scope flowopsagent` for a preview, then `npx vercel --prod`.
3. Optional: in Project → Settings → Environment Variables, add `OPENAI_API_KEY` and redeploy.
4. Domain: add `flowopsagent.ai` under Project → Settings → Domains. Then, in Cloudflare DNS, create the records Vercel shows (usually `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com`) with the proxy set to **DNS only**.

## Project structure

```
src/
  app/
    layout.tsx               # shell: sidebar, top bar, assistant panel, booking store
    page.tsx                 # Command Center
    agents/ booking/ automation/ network/ security/
    testing/ analytics/ integrations/ admin/   # one page.tsx each
    api/assistant/route.ts   # FlowAI → OpenAI (optional)
  components/
    app-shell.tsx  assistant-panel.tsx  pipeline.tsx  ui.tsx
    views/                   # page bodies (client components where interactive)
  lib/
    booking/
      types.ts               # Booking, AgentStep, AuditEntry, …
      engine.ts              # BookingEngine: the 6-agent pipeline
      tests.ts               # FL-001 … FL-007
      store.tsx              # React context + localStorage persistence
    data/
      platform.ts            # modules, agents, nav, phases, roadmap
      integrations.ts        # integration targets
      sample.ts              # SAMPLE data (labelled in the UI)
scripts/run-tests.ts         # `npm test`
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

- [ ] **Postgres** for bookings, audit log, agent execution history and simulation results
- [ ] **Backend API** service behind FLOWOPS Core (REST/GraphQL) so state is shared instead of kept per browser
- [ ] **Authentication, permissions and tenants** (Administration page)
- [ ] **Google Calendar**: a test calendar first, then a live Calendar Agent
- [ ] Real **Notification Agent** (Gmail or an email provider)
- [ ] Event bus (NATS/Kafka/RabbitMQ) for agent-to-agent messaging
- [ ] Durable workflows (Temporal/Prefect) for the Automation Center
- [ ] FlowNet/FlowSec/FlowPulse connectors: Firewalla, SNMP/syslog, CrowdStrike/SentinelOne, Datadog/Grafana/Zabbix
- [ ] FlowAI: RAG memory, policy context (OPA/Casbin), tool routing
- [ ] Monorepo split (`apps/web`, `services/api`, `services/agents`, `services/booking`, `packages/shared`) as services are added
