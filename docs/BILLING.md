# FlowOps Billing (Stripe) — design

Status: **foundation only, behind `BILLING_ENABLED` (off by default)**. Test mode only. No prices are set in code; pricing waits on the founder.
Owner: Payments (Able). Branch: `feat/billing-foundation`.

> **Merge order:** this branch is stacked on **PR #3** (`fix/booking-side-effects-after-commit`) and the **automation PR** (`automation/retries-alerts`, migrations 0003–0005). Merge those first. The billing migration is `0006_billing`, and its Drizzle snapshot/journal were generated on top of the automation PR's `0005` snapshot. If either PR changes its migrations before merge, delete `drizzle/0006_billing.sql` + `drizzle/meta/0006_snapshot.json` + the idx 6 journal entry and re-run `npx drizzle-kit generate --name billing`.

## 1. Goals and non-goals

- One paid subscription per **organization** (the tenant), managed by the org **owner**.
- Stripe-hosted surfaces only: **Stripe Checkout** to subscribe, **Stripe Customer Portal** for card changes, invoices, plan changes and cancellation. FlowOps never sees card data (PCI SAQ-A).
- Stripe is the source of truth; our tables are a mirror maintained by webhooks.
- Non-goals for this PR: pricing page UI, feature gating in the app, usage-based billing, taxes, coupons, live mode.

## 2. Architecture

```
Owner (/admin) ──POST /api/billing/checkout {plan}──▶ FlowOps ──create Checkout Session──▶ Stripe
                                                                          │ (hosted checkout)
Owner ◀──────────────── redirect success_url /admin?billing=success ──────┘
Stripe ──POST /api/billing/webhook (signed)──▶ FlowOps: verify → dedupe → update tables (one tx)
Owner (/admin) ──POST /api/billing/portal──▶ FlowOps ──create Portal Session──▶ Stripe (hosted portal)
```

- **One Stripe customer per organization** (`billing_customer`, PK = `organization_id`). Created lazily on first checkout/portal call with `metadata.organizationId` and an idempotency key `flowops-customer-<orgId>`, so double clicks can't create two customers.
- Checkout sessions carry the org three ways: `client_reference_id`, `metadata.organizationId` and `subscription_data.metadata.organizationId`. The last one means subscription events can be matched to the org even if they arrive before `checkout.session.completed`.
- Only `owner` role can start checkout / open the portal (`requireApi(req, { owner: true })`).
- All routes return **404** unless `BILLING_ENABLED=true`, and **503** if keys are missing.

### Code layout

| Path | Purpose |
| --- | --- |
| `src/lib/billing/config.ts` | Feature flag, key checks (refuses `sk_live_`/`rk_live_` unless `STRIPE_ALLOW_LIVE=true`), plans from `STRIPE_PRICE_*` env |
| `src/lib/billing/stripe.ts` | Lazy Stripe client (build never needs a key) |
| `src/lib/billing/status.ts` | Status normalization and `hasPaidAccess()` (grace policy hook) |
| `src/lib/billing/webhook.ts` | `processStripeEvent()` — dedupe + state changes in one transaction |
| `src/lib/billing/checkout.ts` | `getOrCreateCustomer()` |
| `src/app/api/billing/{webhook,checkout,portal}/route.ts` | Route handlers |
| `drizzle/0006_billing.sql` | Additive migration (3 new tables, no changes to existing tables) |
| `scripts/billing-tests.ts`, `scripts/billing-db-tests.ts` | Offline tests and local-DB webhook tests |

`/api/*` is already excluded from the auth proxy matcher, so Stripe can reach the webhook without a session.

## 3. Plans and prices (config, not code)

Plans are **only** env vars: `STRIPE_PRICE_<PLAN>=price_…` (e.g. `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO_ANNUAL`). The plan key is `<PLAN>` lowercased. Amount, currency, interval and trial length live on the Price in Stripe, so the founder can change pricing in the Stripe dashboard without a deploy. With no `STRIPE_PRICE_*` set, there are no plans and checkout returns "Unknown plan".

## 4. Data model (migration `0006_billing`, additive only)

| Table | Columns | Notes |
| --- | --- | --- |
| `billing_customer` | `organization_id` PK→organization (cascade), `stripe_customer_id` (unique), `created_at`, `updated_at` | one customer per org |
| `subscription` | `id` PK, `organization_id`→organization (cascade, indexed), `stripe_subscription_id` (unique), `status` (text), `price_id`, `current_period_end`, `cancel_at_period_end`, `created_at`, `updated_at` | mirror of the Stripe subscription |
| `stripe_event` | `id` PK (`evt_…`), `type`, `processed_at` | idempotency ledger |

Conventions followed: text ids, text status column without a DB enum (like `member.role`), `timestamp with time zone`, FKs cascade on org delete. The migration only `CREATE`s new tables/indexes and adds FKs **on the new tables**; nothing existing is altered or dropped. Verified against a throwaway local Postgres 17 (not Neon): 0000–0006 apply cleanly in order.

Note: since Stripe API version 2025-03-31, `current_period_end` lives on subscription **items**; we read it from the first item.

## 5. Subscription lifecycle

| Stripe status | Meaning | Paid access (`hasPaidAccess`) |
| --- | --- | --- |
| `incomplete` | first payment not yet confirmed (e.g. 3-D Secure pending) | no |
| `trialing` | in a free trial (only if the Price/checkout has a trial) | yes |
| `active` | paid and current | yes |
| `past_due` | renewal payment failed, Stripe retrying (Smart Retries) | **founder decision** — default yes (grace) |
| `canceled` | ended (terminal; never becomes active again) | no |
| also stored: `incomplete_expired`, `unpaid`, `paused` | Stripe edge states | no |

`cancel_at_period_end=true` means the owner cancelled in the portal; access continues until `current_period_end`. Unknown future statuses are stored as `incomplete` (fail closed). A `canceled` row is never overwritten by a late, out-of-order `updated` event.

## 6. Failed payments — options (founder decision)

Stripe handles the retries (Smart Retries, configurable in Dashboard → Billing → Revenue recovery) and can send its own failed-payment emails. What FlowOps does while `past_due`:

- **A. Soft grace (recommended default):** full access during Stripe's retry window (~1–3 weeks), banner for the owner + link to the portal; when Stripe gives up the subscription becomes `canceled`/`unpaid` and paid features turn off.
- **B. Fixed grace:** full access for N days after the first failure, then read-only (bookings still visible, no new public bookings/FlowAI).
- **C. Immediate lock:** paid features off at the first failure. Simplest, but hurts customers with an expired card.
- Also decide: who gets notified (Stripe's emails vs. our Resend emails to the owner), and whether existing customer bookings keep sending confirmations while locked (recommended: yes — never break the end customer's appointment).

The hook point is `invoice.payment_failed` in `webhook.ts` and the `pastDueGrace` option of `hasPaidAccess()`.

## 7. Webhook endpoint

`POST /api/billing/webhook`

1. 404 unless `BILLING_ENABLED=true`; 503 if `STRIPE_WEBHOOK_SECRET` or the DB is missing.
2. Read the **raw** body (`req.text()`) and verify the `Stripe-Signature` header with `stripe.webhooks.constructEventAsync(payload, sig, STRIPE_WEBHOOK_SECRET)` (default 5-minute tolerance, replay-safe). Bad/missing signature → 400.
3. In **one DB transaction**: `INSERT INTO stripe_event (id, type) ON CONFLICT DO NOTHING`. If no row was inserted, the event is a duplicate → 200 `{status:"duplicate"}`. Otherwise apply the state change.
4. Any error rolls back the transaction (including the `stripe_event` row) and returns 500, so Stripe's retry gets a clean second attempt. Success → 200.
5. No network calls inside the transaction (everything comes from the event payload), which keeps the 5-connection pool free.

Events handled:

| Event | Action |
| --- | --- |
| `checkout.session.completed` | link `stripe_customer_id` ↔ org (`client_reference_id`) |
| `customer.subscription.created` / `.updated` / `.deleted` | upsert `subscription` (status, price, period end, cancel flag); resolve org from subscription metadata, else `billing_customer`; unknown org → 500 so Stripe retries |
| `invoice.paid` | recorded (status flips via `subscription.updated`); future: receipts/analytics |
| `invoice.payment_failed` | recorded; hook for the failed-payment policy (§6) |

Other event types are acknowledged with 200 `{status:"ignored"}` and not stored. Configure the Stripe endpoint to send only the six events above.

## 8. Environment variables (names only)

| Name | Where | Notes |
| --- | --- | --- |
| `BILLING_ENABLED` | Preview first, Production later | `true` to turn routes on |
| `STRIPE_SECRET_KEY` | Vercel (sensitive) | `sk_test_…` only for now |
| `STRIPE_WEBHOOK_SECRET` | Vercel (sensitive) | `whsec_…` of the endpoint (differs per environment) |
| `STRIPE_PRICE_<PLAN>` | Vercel | one per plan, test-mode `price_…` ids |
| `STRIPE_ALLOW_LIVE` | Production only, at launch | must be `true` before an `sk_live_` key is accepted |

No publishable key is needed (hosted Checkout/Portal via redirect).

## 9. Test plan (test mode only)

Automated, no network:
- `npm run test:billing` — plan config parsing, live-key refusal, status/access rules, signature verification (valid accepted, tampered rejected) with a locally generated header.
- `DATABASE_URL=<throwaway local postgres> npm run test:billing:db` — runs `processStripeEvent` against a scratch DB after `npm run db:migrate`: checkout links customer, created/updated/deleted upsert, duplicate event skipped, late update can't resurrect a canceled sub, unknown org rolls back (event not recorded). The script refuses hosted DB URLs.

Manual with the Stripe CLI (test mode, after the founder provides a test key; Preview deployment or local dev):
1. `stripe login` (founder's account, test mode) → create test Products/Prices in the dashboard → set `STRIPE_PRICE_*`.
2. `stripe listen --forward-to localhost:3000/api/billing/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed` → put the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
3. As a test org owner, `POST /api/billing/checkout {"plan":"<key>"}`, pay with `4242 4242 4242 4242` → expect `billing_customer` + `subscription(status=active)`.
4. 3-D Secure: `4000 0025 0000 3155` → `incomplete` then `active`.
5. Failed renewal: card `4000 0000 0000 0341` + `stripe trigger invoice.payment_failed` / test clocks → `past_due`.
6. Cancel in the portal → `cancel_at_period_end=true`; advance a test clock → `canceled`.
7. `stripe events resend <evt_id>` → response `duplicate`, no data change.
8. Send a request with a wrong signature → 400.
9. Never use `org_flowops_demo` or Brian's org on production for these tests.

## 10. Founder decisions needed (Brian)

1. **Plans and prices**: number of tiers, monthly price each, annual option/discount, currency (USD?).
2. **Free trial**: yes/no and length; card required up front?
3. **Founding/pilot pricing**: keep a pilot price for early customers (Stripe coupon or separate Price)?
4. **Self-serve vs. invite-only**: can any new org subscribe itself, or only orgs we approve?
5. **What is gated** by a paid plan (public booking page, FlowAI, SMS, team seats) and what a free/lapsed org keeps.
6. **Failed-payment policy** (§6: A soft grace / B fixed N-day grace / C immediate lock) and who sends dunning emails.
7. **Cancellation**: end of period (recommended) or immediate; allow plan switches/proration in the portal?
8. **Taxes**: turn on Stripe Tax? (depends on where customers are).
9. **Stripe account**: confirm it is in the name of FlowOps Inc., and provide a **test-mode** secret key (`sk_test_…`) privately — never in a group chat. Live keys only at launch.
10. **Receipts/invoices**: Stripe's emails, or branded FlowOps emails via Resend.
