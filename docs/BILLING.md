# FlowOps Billing (Stripe) — design

Status: **foundation only, behind `BILLING_ENABLED` (off by default)**. Test mode only. No prices are set in code; pricing waits on the founder.
Owner: Payments (Able). Branch: `feat/billing-foundation`.

> **Merge order:** this branch is stacked on **PR #3** (`fix/booking-side-effects-after-commit`) and the **automation PR** (`automation/retries-alerts`, migrations 0003–0005). Merge those first. The billing migration is `0006_billing`, and its Drizzle snapshot/journal were generated on top of the automation PR's `0005` snapshot. If either PR changes its migrations before merge, delete `drizzle/0006_billing.sql` + `drizzle/meta/0006_snapshot.json` + the idx 6 journal entry and re-run `npx drizzle-kit generate --name billing`.

## 1. Goals and non-goals

- One paid subscription per **organization** (the tenant), managed by the org **Owner or Admin**.
- Stripe-hosted surfaces only: **Stripe Checkout** to subscribe, **Stripe Customer Portal** for card changes, invoices, plan changes and cancellation. FlowOps never sees card data (PCI SAQ-A).
- Stripe is the source of truth; our tables are a mirror maintained by webhooks.
- Non-goals for this PR: pricing page UI, the lock screen UI (Bot builds it on top of §6), per-feature gating, usage-based billing, taxes, coupons, live mode.

## 2. Architecture

```
Owner/Admin ─────POST /api/billing/checkout {plan}──▶ FlowOps ──create Checkout Session──▶ Stripe
                                                                          │ (hosted checkout)
Owner ◀──────────────── redirect success_url /admin?billing=success ──────┘
Stripe ──POST /api/billing/webhook (signed)──▶ FlowOps: verify → dedupe → update tables (one tx)
Owner/Admin ─────POST /api/billing/portal──▶ FlowOps ──create Portal Session──▶ Stripe (hosted portal)
```

- **One Stripe customer per organization** (`billing_customer`, PK = `organization_id`). Created lazily on first checkout/portal call with `metadata.organizationId` and an idempotency key `flowops-customer-<orgId>`, so double clicks can't create two customers.
- Checkout sessions carry the org three ways: `client_reference_id`, `metadata.organizationId` and `subscription_data.metadata.organizationId`. The last one means subscription events can be matched to the org even if they arrive before `checkout.session.completed`.
- **One subscription per organization.** Before creating a Checkout session the route asks Stripe (not our table, which can lag the webhook) for the customer's subscriptions; if one is `active`, `trialing`, `past_due`, `unpaid` or `paused` it returns **409** and the owner uses the portal instead (plan change, card update, paying a failed invoice). It also expires the customer's other open Checkout sessions, so an old checkout tab can't be completed later into a second subscription. Found in the sandbox end-to-end run: without this, an org on Pro could check out again and be billed twice.
- Only **Owner or Admin** can start checkout / open the portal (`requireApi(req, { manager: true })`, i.e. `canManageBilling`).
- A locked org (failed card, §6) gets **402** from every other `requireApi` route; `/api/billing/*` stays open so Owner/Admin can fix it.
- All routes return **404** unless `BILLING_ENABLED=true`, and **503** if keys are missing.

### Code layout

| Path | Purpose |
| --- | --- |
| `src/lib/billing/config.ts` | Feature flag, key checks (refuses `sk_live_`/`rk_live_` unless `STRIPE_ALLOW_LIVE=true`), plans from `STRIPE_PRICE_*` env |
| `src/lib/billing/stripe.ts` | Lazy Stripe client (build never needs a key) |
| `src/lib/billing/status.ts` | Status normalization and `hasPaidAccess()` (per-feature check; no `past_due` grace by default) |
| `src/lib/billing/access.ts`, `access-rules.ts` | `getBillingAccess()`, `requireBillingAccess()` (402 lock used by `requireApi`), pure access rules (§6) |
| `src/lib/billing/webhook.ts` | `processStripeEvent()` — dedupe + state changes in one transaction |
| `src/lib/billing/checkout.ts` | `getOrCreateCustomer()`, `findLiveStripeSubscription()`, `expireOpenCheckoutSessions()` |
| `src/app/api/billing/{webhook,checkout,portal}/route.ts` | Route handlers |
| `drizzle/0006_billing.sql` | Additive migration (3 new tables, no changes to existing tables) |
| `scripts/billing-tests.ts`, `scripts/billing-db-tests.ts` | Offline tests and local-DB webhook tests |

`/api/*` is already excluded from the auth proxy matcher, so Stripe can reach the webhook without a session.

## 3. Plans and prices (config, not code)

Plans are **only** env vars: `STRIPE_PRICE_<PLAN>=price_…` (e.g. `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO_ANNUAL`). The plan key is `<PLAN>` lowercased. Amount, currency, interval and trial length live on the Price in Stripe, so the founder can change pricing in the Stripe dashboard without a deploy. With no `STRIPE_PRICE_*` set, there are no plans and checkout returns "Unknown plan".

**Approved for now (Brian, 2026-10-26):** Starter **$49/mo** and Pro **$99/mo**, USD, monthly. In the US sandbox (`Flowops Inc sandbox`, test mode) these are `price_1UUvY25iQFiJ57ypFl4SOyNb` (Starter, lookup key `test_starter_monthly`) and `price_1UUvY35iQFiJ57ypBQeXz1q5` (Pro, `test_pro_monthly`) → `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO`. Live-mode Prices with the same amounts get created at launch. Add-ons (extra seats, locations, SMS bundles, FlowAI usage) are still open.

### Plan changes and cancellation (Brian, 2026-10-26)

- **Plan changes take effect at the next renewal, never mid-cycle, with no proration.** The app has no API-side plan-change code: plan changes only happen in the Stripe Customer Portal (checkout refuses a second subscription with 409). If one is added later it must use `proration_behavior: "none"` and a subscription schedule that starts the new price at `current_period_end`.
- Portal configuration `bpc_1UUvd05iQFiJ57yp2r2sV9Rv` (sandbox, default) was set on 2026-10-26 to `features.subscription_update.proration_behavior = "none"` and `schedule_at_period_end.conditions = [decreasing_item_amount, shortening_interval]`, so **downgrades** (Pro → Starter) are scheduled for the end of the period.
- **Limitation:** Stripe's portal can only schedule changes that *decrease* the amount or shorten the interval. An **upgrade** (Starter → Pro) in the portal applies the new plan right away. Because proration is off, nothing is charged mid-cycle and the customer pays the Pro price from the next renewal, so billing matches the "next renewal" rule but the Pro features start immediately. To defer upgrades too, we would need our own upgrade endpoint using a subscription schedule (or turn off upgrades in the portal). Founder call if that matters.
- **Cancellation:** Stripe default, at the end of the paid period (portal `subscription_cancel.mode = "at_period_end"`, `proration_behavior = "none"`, unchanged). The org keeps access until `current_period_end`; then the subscription becomes `canceled` and the org is locked (§6).
- The live-mode portal configuration needs the same settings (plus plan switching turned on) at launch.

## 4. Data model (migration `0006_billing`, additive only)

| Table | Columns | Notes |
| --- | --- | --- |
| `billing_customer` | `organization_id` PK→organization (cascade), `stripe_customer_id` (unique), `created_at`, `updated_at` | one customer per org |
| `subscription` | `id` PK, `organization_id`→organization (cascade, indexed), `stripe_subscription_id` (unique), `status` (text), `price_id`, `current_period_end`, `cancel_at_period_end`, `last_event_created` (`created` of the Stripe event that last wrote the row), `created_at`, `updated_at` | mirror of the Stripe subscription |
| `stripe_event` | `id` PK (`evt_…`), `type`, `processed_at` | idempotency ledger |

Conventions followed: text ids, text status column without a DB enum (like `member.role`), `timestamp with time zone`, FKs cascade on org delete. The migration only `CREATE`s new tables/indexes and adds FKs **on the new tables**; nothing existing is altered or dropped. Verified against a throwaway local Postgres 17 (not Neon): 0000–0006 apply cleanly in order.

Note: since Stripe API version 2025-03-31, `current_period_end` lives on subscription **items**; we read it from the first item.

## 5. Subscription lifecycle

| Stripe status | Meaning | App access (`getBillingAccess`) |
| --- | --- | --- |
| `incomplete` | first payment not yet confirmed (e.g. 3-D Secure pending) | locked |
| `trialing` | in a free trial (only if the Price/checkout has a trial) | full |
| `active` | paid and current | full |
| `past_due` | renewal payment failed, Stripe retrying (Smart Retries) | **locked immediately** (§6) |
| `canceled` | ended (terminal; never becomes active again) | locked (re-subscribe via Checkout) |
| also stored: `incomplete_expired`, `unpaid`, `paused` | Stripe edge states | locked |
| no subscription row | org never subscribed | locked (`no_subscription`), unless in `BILLING_EXEMPT_ORG_IDS` |

`cancel_at_period_end=true` means the owner cancelled in the portal; access continues until `current_period_end`. Unknown future statuses are stored as `incomplete` (fail closed). Ordering is handled in §7: state is fetched from Stripe, older events can't overwrite newer ones, and a `canceled` row is never overwritten.

## 6. Failed payments — policy: immediate lock (Brian, 2026-10-26)

**Decision:** if a customer's card fails, the business loses access to FlowOps right away (option C of the earlier proposal). Stripe still retries the card (Smart Retries, Dashboard → Billing → Revenue recovery) and can send its own failed-payment emails.

- **Lock:** with `BILLING_ENABLED=true`, any status other than `active`/`trialing` locks the org (`past_due`, `unpaid`, `incomplete`, `incomplete_expired`, `canceled`, `paused`, and unknown future statuses, which are stored as `incomplete`). Orgs with no subscription row are locked as `no_subscription` (see below).
- **Owner/Admin can still fix it:** sign-in, sign-out, password reset (`/api/auth/*`), invites (`/api/invites/*`) and all of `/api/billing/*` (checkout, portal, webhook) stay reachable. Checkout and the portal are open to Owner **and** Admin (`canManageBilling`). Staff of a locked org can sign in but get 402 everywhere else.
- **Data is never deleted:** the lock is read-only. Bookings, customers, team and settings stay as they are.
- **Unlock is automatic:** as soon as Stripe confirms payment, `invoice.paid` / `customer.subscription.updated` moves the row back to `active` and the very next request has full access. There is no cache.
- **Not gated (by design, for now):** the public booking page (`/api/public/*`), the notification cron, and the Twilio/Resend webhooks don't go through the guard, so existing customer appointments keep their confirmations and reminders. Changing that is a separate founder decision.

### How it is enforced

| Export (`src/lib/billing/access.ts`) | What it does |
| --- | --- |
| `getBillingAccess(organizationId, role?)` → `{ access: "full" \| "locked", reason, status, canManageBilling }` | `reason`: `"ok"`, `"billing_disabled"`, `"exempt"`, `"no_subscription"`, or the locked status (`"past_due"`, `"unpaid"`, `"incomplete"`, `"incomplete_expired"`, `"canceled"`, `"paused"`). `status` is the stored subscription status or `null`. `canManageBilling` = Owner or Admin. One indexed read of `subscription`; none when billing is off. |
| `requireBillingAccess(req, ctx)` | Called from the shared API guard `requireApi()` (`src/lib/server/context.ts`), after the auth and role checks, so every route that uses `requireApi` inherits it. Returns `null` (go ahead) or **402** `{ "error": "billing_locked", "reason", "status", "canManageBilling" }`. Paths under `/api/billing/`, `/api/auth/`, `/api/invites/` are exempt. |
| `canManageBilling(role)`, `isBillingExemptPath(path)`, `resolveBillingAccess(...)`, `billingExemptOrgIds(env)`, `effectiveSubscription(rows)` | Pure helpers (in `access-rules.ts`, unit-tested offline). |

If an org has several subscription rows (e.g. an old canceled one and a new active one), any `active`/`trialing` row wins; otherwise the most recently updated row decides. The dashboard lock screen (Bot) should call `getBillingAccess(ctx.org.id, ctx.role)` in the dashboard layout, or react to the 402 from `/api/state`.

### Orgs without a subscription, and exemptions (founder decision)

When billing is turned on, an org that has never subscribed is **locked** (`no_subscription`) and is sent to Checkout. Existing orgs that predate billing, such as `org_flowops_demo` (Brian's own workspace) and pilot customers, must be listed in `BILLING_EXEMPT_ORG_IDS` (comma-separated org ids) **before** `BILLING_ENABLED=true` goes on, or they get locked too. Exempt orgs always get full access, even with a failed or canceled subscription. **Brian to confirm:** which orgs are exempt, and whether new sign-ups should get a free trial instead of an immediate lock (a Stripe trial gives `trialing` → full).

With `BILLING_ENABLED` off (the default), `getBillingAccess` always returns `full` / `billing_disabled` and nothing is locked.

`hasPaidAccess()` in `status.ts` remains for per-feature checks and now defaults to no grace for `past_due`, matching this policy.

## 7. Webhook endpoint

`POST /api/billing/webhook`

1. 404 unless `BILLING_ENABLED=true`; 503 if `STRIPE_WEBHOOK_SECRET` or the DB is missing.
2. Read the **raw** body (`req.text()`) and verify the `Stripe-Signature` header with `stripe.webhooks.constructEventAsync(payload, sig, STRIPE_WEBHOOK_SECRET)` (default 5-minute tolerance, replay-safe). Bad/missing signature → 400.
3. Quick read of `stripe_event`: already seen → 200 `{status:"duplicate"}` without calling Stripe.
4. **Event as a signal (ordering):** Stripe does not guarantee delivery order. For `customer.subscription.*` and `invoice.*` events we take the subscription id (the object id, or `invoice.parent.subscription_details.subscription`) and call `stripe.subscriptions.retrieve(id)` **before** opening the transaction, then write that *current* state instead of the event payload. A failed retrieve → 500 → Stripe retries (nothing recorded).
5. In **one DB transaction**: `INSERT INTO stripe_event (id, type) ON CONFLICT DO NOTHING` (the real dedupe guard; no row → duplicate). Then upsert the subscription with these guards in `ON CONFLICT … DO UPDATE … WHERE`:
   - **Canceled is terminal:** a `canceled` row is never overwritten.
   - **Timestamp backup guard:** the row stores the source event's `created` in `last_event_created`; an event strictly older than the stored one is skipped (`{status:"stale"}`, event still recorded as seen). On a tie (same second) the write goes through, because the fetched state is current.
6. Any error rolls back the transaction (including the `stripe_event` row) and returns 500, so Stripe's retry gets a clean second attempt. Success → 200.
7. No network calls inside the transaction, which keeps the 5-connection pool free. The Stripe client is injected (`processStripeEvent(event, { fetchSubscription })`) so tests run offline.

Events handled:

| Event | Action |
| --- | --- |
| `checkout.session.completed` | link `stripe_customer_id` ↔ org (`client_reference_id`) |
| `customer.subscription.created` / `.updated` / `.deleted` | retrieve the subscription from Stripe, upsert its **current** state (status, price, period end, cancel flag) with the ordering guards; resolve org from subscription metadata, else `billing_customer`; unknown org → 500 so Stripe retries |
| `invoice.paid` | retrieve the invoice's subscription and upsert its current state (e.g. back to `active`); future: receipts/analytics |
| `invoice.payment_failed` | retrieve the subscription and upsert its current state (e.g. `past_due`); hook for the failed-payment policy (§6) |

Other event types are acknowledged with 200 `{status:"ignored"}` and not stored. Configure the Stripe endpoint to send only the six events above.

## 8. Environment variables (names only)

| Name | Where | Notes |
| --- | --- | --- |
| `BILLING_ENABLED` | Preview first, Production later | `true` to turn routes on |
| `STRIPE_SECRET_KEY` | Vercel (sensitive) | `sk_test_…` only for now |
| `STRIPE_WEBHOOK_SECRET` | Vercel (sensitive) | `whsec_…` of the endpoint (differs per environment) |
| `STRIPE_PRICE_<PLAN>` | Vercel | one per plan, test-mode `price_…` ids |
| `STRIPE_ALLOW_LIVE` | Production only, at launch | must be `true` before an `sk_live_` key is accepted |
| `BILLING_EXEMPT_ORG_IDS` | Every environment with billing on | comma-separated org ids never locked (e.g. `org_flowops_demo`); set **before** `BILLING_ENABLED=true` (§6) |

No publishable key is needed (hosted Checkout/Portal via redirect).

## 9. Test plan (test mode only)

Automated, no network:
- `npm run test:billing` — plan config parsing, live-key refusal, status/access rules, which existing subscription statuses block a second checkout, signature verification (valid accepted, tampered rejected) with a locally generated header; the access lock: every status → full/locked, no subscription, flag off, exempt list, Owner/Admin/Staff `canManageBilling`, exempt vs. guarded API paths, the 402 body.
- `DATABASE_URL=<throwaway local postgres> npm run test:billing:db` — runs `processStripeEvent` against a scratch DB after `npm run db:migrate`, with a **mocked** Stripe client: checkout links customer; the fetched state (not the payload) is written; duplicates skip without a Stripe call; two updates delivered in reverse order → the newer status wins; same-second tie → fetched state wins; canceled stays canceled even for a newer event; unknown org or a failed Stripe retrieve rolls back (event not recorded); access lock on its own test org: no row → locked, exempt → full, flag off → full, active → full, `invoice.payment_failed` → `past_due` → locked (Owner/Admin can still manage billing, Staff can't), the guard returns 402 for `/api/state` but not for `/api/billing/*`, `/api/auth/*`, data still there, `invoice.paid` → `active` → full again, `unpaid`/`canceled` → locked. The script refuses hosted DB URLs.

Manual with the Stripe CLI (test mode, after the founder provides a test key; Preview deployment or local dev):
1. `stripe login` (founder's account, test mode) → create test Products/Prices in the dashboard → set `STRIPE_PRICE_*`.
2. `stripe listen --forward-to localhost:3000/api/billing/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed` → put the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
3. As a test org owner, `POST /api/billing/checkout {"plan":"<key>"}`, pay with `4242 4242 4242 4242` → expect `billing_customer` + `subscription(status=active)`.
4. 3-D Secure: `4000 0025 0000 3155` → `incomplete` then `active`.
5. Failed renewal: card `4000 0000 0000 0341` + `stripe trigger invoice.payment_failed` / test clocks → `past_due`.
6. Cancel in the portal → `cancel_at_period_end=true`; advance a test clock → `canceled`.
7. `stripe events resend <evt_id>` → response `duplicate`, no data change.
8. Send a request with a wrong signature → 400.
9. With an active/past_due subscription, `POST /api/billing/checkout` again → **409**; a checkout URL created earlier is expired and can no longer be paid.
10. Billing lock: with a test-clock customer, set the default card to `pm_card_chargeCustomerFail`, advance the clock past the period end → `past_due`, `getBillingAccess` locked, API routes 402, `/api/billing/portal` still works; pay the open invoice with `pm_card_visa` → `active`, full access. (Verified 2026-10-26 in the US sandbox with `cus_VVxZvoGZfW5Yqy` against a local DB.)
11. Never use `org_flowops_demo` or Brian's org on production for these tests.

## 10. Founder decisions needed (Brian)

1. ~~Plans and prices~~ **decided for now: Starter $49/mo, Pro $99/mo, USD** (§3). Still open: add-ons, annual option/discount, a third tier.
2. **Free trial**: yes/no and length; card required up front?
3. **Founding/pilot pricing**: keep a pilot price for early customers (Stripe coupon or separate Price)?
4. **Self-serve vs. invite-only**: can any new org subscribe itself, or only orgs we approve?
5. **What is gated** by a paid plan (public booking page, FlowAI, SMS, team seats) and what a free/lapsed org keeps.
6. ~~Failed-payment policy~~ **decided (confirmed): immediate lock** (§6). Still open: who sends dunning emails (Stripe's or ours), which existing orgs go in `BILLING_EXEMPT_ORG_IDS`, and whether new sign-ups get a trial instead of an immediate `no_subscription` lock.
7. ~~Cancellation / plan changes~~ **decided:** cancellation at period end (Stripe default); plan changes at the next renewal, no proration (§3). Open: whether upgrades must also wait for renewal (portal limitation, §3).
8. **Taxes**: turn on Stripe Tax? (depends on where customers are).
9. **Stripe account**: confirm it is in the name of FlowOps Inc., and provide a **test-mode** secret key (`sk_test_…`) privately — never in a group chat. Live keys only at launch.
10. **Receipts/invoices**: Stripe's emails, or branded FlowOps emails via Resend.
