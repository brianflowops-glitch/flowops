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
| `src/lib/billing/webhook.ts` | `processStripeEvent()` — dedupe + state changes in one transaction; mirrors the plan item and add-on items (§11) |
| `src/lib/billing/entitlements.ts` | Pure: plan limits, add-on effects, `computeEntitlements()`, price-id → plan/add-on classification (§11) |
| `src/lib/billing/org-entitlements.ts` | `getEntitlements(orgId)`: reads the mirror, applies billing flag / exemptions (§11) |
| `src/lib/billing/addons.ts` | `setAddonQuantity()`: increases/new add-ons apply now; decreases/removals are scheduled for the renewal through a subscription schedule; always `proration_behavior: "none"` (§11) |
| `src/lib/billing/checkout.ts` | `getOrCreateCustomer()`, `findLiveStripeSubscription()`, `expireOpenCheckoutSessions()` |
| `src/app/api/billing/{webhook,checkout,portal,addons}/route.ts` | Route handlers |
| `drizzle/0006_billing.sql` | Additive migration (3 new tables, no changes to existing tables) |
| `drizzle/0008_billing_addons.sql` | Additive migration (1 new table `subscription_item`; §11) |
| `scripts/billing-tests.ts`, `scripts/billing-db-tests.ts` | Offline tests and local-DB webhook tests |
| `scripts/billing-sandbox-addons.ts` | Live Stripe **sandbox** end-to-end check for add-ons (test clock; §9) |
| `tests/billing-addons-route.test.ts` | Vitest: add-on route guards (404 / 503 / 401 / 403 / 400) |

`/api/*` is already excluded from the auth proxy matcher, so Stripe can reach the webhook without a session.

## 3. Plans and prices (config, not code)

Plans are **only** env vars: `STRIPE_PRICE_<PLAN>=price_…` (e.g. `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO_ANNUAL`). The plan key is `<PLAN>` lowercased. Amount, currency, interval and trial length live on the Price in Stripe, so the founder can change pricing in the Stripe dashboard without a deploy. With no `STRIPE_PRICE_*` set, there are no plans and checkout returns "Unknown plan".

**Final pricing (Brian, 2026-10-27) — supersedes the 2026-10-26 line below for new work.**

| Plan | Monthly | Annual (10× monthly) | Included (default, Brian to confirm) |
| --- | --- | --- | --- |
| Starter | $49 | $490 | 3 seats / 1 location / 500 texts / branding not removed |
| Pro | $99 | $990 | 10 / 1 / 2,000 / branding removed |
| Business | $199 | $1,990 | 25 / 3 / 5,000 / branding removed (override: `PLAN_LIMITS_BUSINESS`) |

Add-ons: seat $10/mo ($100/yr), location $29/mo ($290/yr), branding removal $15/mo ($150/yr), **text pack** $15 for 1,000 texts, **one-time** (§11). Env: `STRIPE_PRICE_<PLAN>` (monthly) and `STRIPE_PRICE_<PLAN>_ANNUAL`; `STRIPE_ADDON_PRICE_<KEY>` and `STRIPE_ADDON_PRICE_<KEY>_ANNUAL`. Checkout takes `{plan, interval: "month"|"year"}` (default `month`); a plan with no annual price configured answers 400 for `year`. The webhook recognises monthly and annual prices of a plan alike.

**Free trial: 14 days** (`TRIAL_DAYS`, default 14, `0` disables). Checkout uses `subscription_data.trial_period_days` with `payment_method_collection: "always"` (a card is collected up front) and `trial_settings.end_behavior.missing_payment_method: "cancel"`. **One trial per business:** none is offered if the org has ever had a subscription, checked in our mirror **and** in the Stripe customer's subscription list (so cancel + resubscribe, a second checkout, or a lagging mirror never gets another; abandoned `incomplete` / `incomplete_expired` attempts don't count). `trialing` has full access (§6) and full entitlements. The checkout route returns `{url, plan, interval, trialDays}`.

Sandbox price ids for the final pricing are in §11 ("Sandbox objects").

**Earlier approval (Brian, 2026-10-26):** Starter **$49/mo** and Pro **$99/mo**, USD, monthly. In the US sandbox (`Flowops Inc sandbox`, test mode) these are `price_1UUvY25iQFiJ57ypFl4SOyNb` (Starter, lookup key `test_starter_monthly`) and `price_1UUvY35iQFiJ57ypBQeXz1q5` (Pro, `test_pro_monthly`) → `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO`. Live-mode Prices with the same amounts get created at launch. Add-on support is built (§11) but **add-on prices are placeholders**; Brian has not approved them. FlowAI usage and the voice agent are not add-ons yet.

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

Migration `0008_billing_addons` (additive only: one `CREATE TABLE`, one FK on the new table, two indexes) adds `subscription_item` (§11).

Note: since Stripe API version 2025-03-31, `current_period_end` lives on subscription **items**; we read it from the plan item (all items on a subscription share one period).

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
| `STRIPE_PRICE_<PLAN>` | Vercel | one per plan (`STARTER`, `PRO`, `BUSINESS`), monthly `price_…` ids |
| `STRIPE_PRICE_<PLAN>_ANNUAL` | Vercel | the plan's yearly price (10× monthly); same plan key, interval `year`. Without it, `interval: "year"` checkout → 400 |
| `STRIPE_ADDON_PRICE_<KEY>` | Vercel | one per add-on: recurring monthly prices for `SEAT`, `LOCATION`, `BRANDING`, and the **one-time** price for `TEXTS_1000` (the text pack, §11). Distinct prefix from `STRIPE_PRICE_*`, so never read as a plan |
| `STRIPE_ADDON_PRICE_<KEY>_ANNUAL` | Vercel | yearly recurring price of `SEAT` / `LOCATION` / `BRANDING`, used for add-ons on an annual subscription; missing → add-on route 409 on annual subscriptions |
| `STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000` | Vercel (optional) | a *recurring* texts price that existing subscriptions may still hold; counted in entitlements, never sold |
| `TRIAL_DAYS` | Vercel (optional) | free-trial length, default 14, `0` disables |
| `STRIPE_ADDON_MAX_<KEY>` | Vercel (optional) | override the most one subscription may hold of an add-on (positive whole number, 1–1000), e.g. `STRIPE_ADDON_MAX_TEXTS_1000=20` (for text packs: max packs per billing period); defaults in §11 |
| `PLAN_LIMITS_<PLAN>` | Vercel (optional) | override a plan's limits, e.g. `seats=3,locations=1,texts=500,branding=false` or JSON; defaults exist for `starter`, `pro` and `business` (§11) |
| `STRIPE_ALLOW_LIVE` | Production only, at launch | must be `true` before an `sk_live_` key is accepted |
| `BILLING_EXEMPT_ORG_IDS` | Every environment with billing on | comma-separated org ids never locked (e.g. `org_flowops_demo`); set **before** `BILLING_ENABLED=true` (§6) |

No publishable key is needed (hosted Checkout/Portal via redirect).

## 9. Test plan (test mode only)

Automated, no network:
- `npm run test:billing` — plan config parsing, live-key refusal, status/access rules, which existing subscription statuses block a second checkout, signature verification (valid accepted, tampered rejected) with a locally generated header; the access lock: every status → full/locked, no subscription, flag off, exempt list, Owner/Admin/Staff `canManageBilling`, exempt vs. guarded API paths, the 402 body.
- `DATABASE_URL=<throwaway local postgres> npm run test:billing:db` — runs `processStripeEvent` against a scratch DB after `npm run db:migrate`, with a **mocked** Stripe client: checkout links customer; the fetched state (not the payload) is written; duplicates skip without a Stripe call; two updates delivered in reverse order → the newer status wins; same-second tie → fetched state wins; canceled stays canceled even for a newer event; unknown org or a failed Stripe retrieve rolls back (event not recorded); access lock on its own test org: no row → locked, exempt → full, flag off → full, active → full, `invoice.payment_failed` → `past_due` → locked (Owner/Admin can still manage billing, Staff can't), the guard returns 402 for `/api/state` but not for `/api/billing/*`, `/api/auth/*`, data still there, `invoice.paid` → `active` → full again, `unpaid`/`canceled` → locked. The script refuses hosted DB URLs.

Add-on tests (§11): `test:billing` also covers add-on env parsing, plan-limit parsing (defaults, key=value, JSON, malformed values), `computeEntitlements`, price-id classification, and `setAddonQuantity` against a fake Stripe client with a stateful fake subscription schedule (create / increase use `proration_behavior: "none"`; decrease and removal only write a schedule whose next phase holds the lower quantity and never touch the item; a repeated decrease is a no-op; a different decrease replaces the pending one; an increase replaces a pending decrease and releases the schedule; asking for the current quantity cancels a pending decrease; a portal-made plan-downgrade schedule is edited, kept and never released; schedules with discounts or several future phases are refused; `scheduledChanges()` diff; rejects unknown add-on, bad quantity, non-active subscription, branding on a plan that includes it, unconfigured plan). `test:billing:db` also covers: plan identified by price id when an add-on is `items[0]`, item mirroring, quantity changes, pruning removed add-ons, entitlements unchanged while a decrease is scheduled and dropping when the renewal event arrives, duplicate events, stale (older) events not rewriting items, same-second ties, truncated item lists (`has_more`) not pruning, plan swap keeping add-ons, `past_due` → zero entitlements, canceled terminal, org-delete cascade, `getEntitlements` for billing off / exempt / no subscription. `npm test` includes `tests/billing-addons-route.test.ts` (404 when off, 503 unconfigured, 401, **403 for staff**, 400 on bad bodies, GET works for a locked Owner/Admin).

Final-pricing tests: `test:billing` (offline) also covers annual plan/add-on env parsing and price classification, `TRIAL_DAYS`, the Checkout session params (`checkoutSessionParams`), Business defaults, pack clamping and the pure text-pack rules (`text-pack-rules.ts`). `test:billing:db` covers the `text_pack` lifecycle on a scratch Postgres (paid, declined → voided + failed, cap, concurrency, no payment method, trialing, non-active statuses, reconcile after an error, `invoice.paid` / `invoice.payment_failed` settlement with dedupe, legacy recurring texts, annual mapping) and trial eligibility (mirror and Stripe list). `tests/billing-addons-route.test.ts` covers the text-packs and checkout routes. `test:billing:ui` covers the Monthly / Yearly toggle.

Live sandbox check (test mode, **US sandbox `acct_1UUvH95iQFiJ57yp` only**): `STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres> npm run test:billing:sandbox` (`scripts/billing-sandbox-final.ts`). It first runs `scripts/sandbox-final-prices.ts` (idempotent: finds or creates the final TEST prices by lookup key, metadata `flowops_final=true`, `placeholder=false`) and then, on Stripe test clocks, runs the **real** Stripe events through `processStripeEvent`:
1. Checkout Session params accepted by Stripe (trial; annual price; no trial).
2. **Trial lifecycle** (Starter monthly): trialing for 14 days with a $0 invoice; a text pack bought **during the trial** is charged in full immediately (standalone paid invoice, not deferred to trial end); packs capped at 10; day 14 → active, first invoice $49 without packs, packs expire with the trial; cancel + resubscribe gets **no second trial**, even with an empty mirror.
3. **Declined card** (Pro monthly): 402 `payment_failed` with the portal link, the pack invoice is **voided**, nothing granted, row `failed`, the real `invoice.payment_failed` webhook does not flag the subscription; with a good card the full cap still works; no card on file → 402 `no_payment_method` with no Stripe invoice.
4. **Annual Pro** with annual add-ons: $990 invoice; 409 with no annual add-on price; annual seat/location prices; no mid-cycle charge; pack window per month; seat decrease scheduled to the period end (a year away); renewal invoice $990 + $100 + $290 = $1,380.
5. **Business monthly**: $199, 25/3/5,000 entitlements; seats added immediately (no proration), removed at period end; renewal invoice $209.
The test clocks, customers and test org are deleted at the end. Webhook *delivery* (signature, HTTP) is covered by the steps below. Not driven end to end: the hosted Checkout page itself (it can't be completed headlessly); the script verifies Stripe accepts the exact session params and then creates equivalent subscriptions through the API (`trial_period_days: 14`, card on file). The Customer Portal plan-downgrade scenario of the earlier sandbox script is not re-run here.

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

1. ~~Plans and prices~~ **decided for now: Starter $49/mo, Pro $99/mo, USD** (§3). Add-on mechanics are built (§11) with placeholder prices; still open: final add-on prices, annual option/discount, a third tier.
2. **Free trial**: yes/no and length; card required up front?
3. **Founding/pilot pricing**: keep a pilot price for early customers (Stripe coupon or separate Price)?
4. **Self-serve vs. invite-only**: can any new org subscribe itself, or only orgs we approve?
5. **What is gated** by a paid plan (public booking page, FlowAI, SMS, team seats) and what a free/lapsed org keeps.
6. ~~Failed-payment policy~~ **decided (confirmed): immediate lock** (§6). Still open: who sends dunning emails (Stripe's or ours), which existing orgs go in `BILLING_EXEMPT_ORG_IDS`, and whether new sign-ups get a trial instead of an immediate `no_subscription` lock.
7. ~~Cancellation / plan changes~~ **decided:** cancellation at period end (Stripe default); plan changes at the next renewal, no proration (§3). Open: whether upgrades must also wait for renewal (portal limitation, §3).
8. **Taxes**: turn on Stripe Tax? (depends on where customers are).
9. **Stripe account**: confirm it is in the name of FlowOps Inc., and provide a **test-mode** secret key (`sk_test_…`) privately — never in a group chat. Live keys only at launch.
10. **Receipts/invoices**: Stripe's emails, or branded FlowOps emails via Resend.
11. **Add-ons** (§11): **decided 2026-10-27** (prices, annual = 10×, Business $199, 14-day trial, text packs one-time). Still open: confirm the included plan limits, and the live-mode Price creation.


## 11. Add-ons and entitlements (Able)

Status: built, **dormant**: nothing reads entitlements to block anything yet, and everything is behind `BILLING_ENABLED` (off by default → every billing route 404s, `getEntitlements` returns `enforced: false`). Prices are **not** in code.

### Configuration (env only)

- **Add-on prices:** `STRIPE_ADDON_PRICE_<KEY>=price_…` (key = `<KEY>` lowercased): `SEAT`, `LOCATION`, `BRANDING` (recurring) and `TEXTS_1000` (**one-time** text pack, see below). Annual subscriptions use `STRIPE_ADDON_PRICE_<KEY>_ANNUAL`. The prefix differs from `STRIPE_PRICE_*`, so an add-on can never be taken for a plan. Amount/interval/currency live on the Stripe Price.
- **What one unit gives** is product logic in `entitlements.ts` (`addonEffect`): `seat` +1 seat, `location` +1 location, `texts_<n>` +n texts per month (so `TEXTS_5000` works with no code change), `branding` removes branding (on/off, max quantity 1). Unknown keys are still billed and mirrored but add nothing.
- **Maximum quantity per add-on (abuse guard):** one subscription may hold at most `seat` **50**, `location` **10**, `texts_1000` **10**, `branding` **1**; any other add-on key (e.g. `texts_5000`) **10**. Override one with `STRIPE_ADDON_MAX_<KEY>` (e.g. `STRIPE_ADDON_MAX_TEXTS_1000=20`). A valid override is a positive whole number from 1 to 1000; anything else (`0`, negative, fraction, text, above 1000) is ignored: the default applies and a one-time `console.warn` names the variable. Without a cap an Owner could set `texts_1000` to 1,000 (a million texts that we pay Twilio for). The cap is enforced twice: `POST /api/billing/addons` refuses a larger quantity with 400 before any Stripe call, and `computeEntitlements` never counts more than the cap, so a quantity set directly in Stripe (or mirrored before a cap was lowered) cannot grant more. The mirror (`subscription_item`) still stores what Stripe holds; only the entitlement is clamped, and `entitlements.addons[].quantity` reports the quantity counted. This changes no billing timing.
- **Plan limits:** defaults from the pricing proposal, **Brian to confirm**: Starter 3 seats / 1 location / 500 texts / branding not removed; Pro 10 / 1 / 2,000 / branding removed. Override or define any plan (e.g. Business) with `PLAN_LIMITS_<PLAN>`, either `seats=30,locations=5,texts=10000,branding=true` or JSON `{"seats":30,"locations":5,"texts":10000,"branding":true}`. Unspecified fields keep the default; malformed values are ignored (never widen a limit). A plan with neither a default nor an override gets the **smallest tier** (fallback, flagged `source: "fallback"`) rather than unlimited.
- Add-ons share the plan's billing interval (Stripe requires one interval per subscription). The add-on route reads the subscription's interval and uses the matching price (`STRIPE_ADDON_PRICE_<KEY>` for monthly, `…_ANNUAL` for yearly: seat $100, location $290, branding $150 per year); if that price isn't configured it answers **409** and changes nothing.
- **Business** defaults (override `PLAN_LIMITS_BUSINESS`): 25 seats, 3 locations, 5,000 texts, branding removed.

### Text packs (one-time, final pricing 2026-10-27)

A text pack is **$15 for 1,000 texts, charged in full at purchase** (`STRIPE_ADDON_PRICE_TEXTS_1000` is a *one-time* price). It is not a subscription item and never rides on the renewal invoice.

- `POST /api/billing/text-packs {quantity}` (Owner/Admin; same guards as the other billing routes) reserves the pack under an org row lock, creates a **standalone invoice** (`auto_advance: false`, no pending items, metadata `flowops_text_pack`), adds the item, finalizes it and **pays it immediately with the card on file**. Texts are granted only after the invoice is `paid` (row `paid`).
- **Failed charge grants nothing.** If payment fails the invoice is **voided** (or deleted if still a draft) so it can never be paid later, the row is marked `failed`, and the route returns **402** `{error:"payment_failed", portal:"/api/billing/portal"}`. A failed attempt doesn't use up the cap. If an error happens after Stripe actually collected, the row is reconciled to `paid` instead.
- **During a trial** the pack is charged in full immediately like any other time: never free, never deferred to the trial end. **No payment method → 402** `no_payment_method` (portal link) and no invoice is created. No subscription (or not `active`/`trialing`) → 409.
- **Validity and cap:** a pack is valid for the current billing period (for an annual plan, the current **month** of the year), so packs bought now expire at the period end (a trial's packs expire with the trial). At most **10 packs per period** (`STRIPE_ADDON_MAX_TEXTS_1000`); an 11th → 400 before any Stripe call. `monthlyTexts = plan texts + paid packs in the current period × 1,000` (clamped to the cap).
- **Webhook:** `invoice.paid` / `invoice.payment_failed` carrying `metadata.flowops_text_pack` settle the `text_pack` row (deduped by `stripe_event`) and return early: they never touch the subscription mirror (a failed pack payment doesn't mark the org `past_due`).
- `texts_1000` is **removed from the recurring add-on path**: `POST /api/billing/addons` answers 400 for it and points to `/api/billing/text-packs`. A *legacy recurring* texts item an existing subscription still holds is mirrored and counted in entitlements but never sold (`STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000`). `GET /api/billing/addons` adds `textPacks: [{key, priceId, texts, max}]`.

### Seats, locations, branding (final)

Added = **immediate**, `proration_behavior: "none"`, billed at the next renewal. Removed or decreased = stays until the period end (subscription schedule), **no refund or credit**. Same on monthly and annual subscriptions.

### Data model (`0008_billing_addons`, additive)

`subscription_item`: `id`, `subscription_id` → `subscription.id` (cascade), `stripe_item_id` (unique), `price_id`, `quantity`, `created_at`, `updated_at`. The migration touches only the new `subscription_item` table (no existing table, including `notification`, is altered). **Renumbering:** another open PR (email reminders) also uses `0008`. Whichever merges second renumbers to `0009`: after rebasing, delete `drizzle/0008_billing_addons.sql`, `drizzle/meta/0008_snapshot.json` and its `_journal.json` entry, then run `DATABASE_URL=postgres://x npx drizzle-kit generate --name billing_addons` (regenerates it as the next number on top of the other PR's snapshot). Nothing else in the code refers to the migration number. Plan vs. add-on is **derived at read time** from price id ↔ env (like `subscription.price_id` ↔ plan), so changing env needs no data migration.

### Data model (`0009_text_pack`, additive)

New table `text_pack`: `id`, `organization_id` → organization (cascade), `pack_key`, `texts_per_pack`, `quantity`, `stripe_invoice_id` (unique), `status` (`pending` / `paid` / `failed`), `period_start`, `period_end`, `amount_paid`, `paid_at`, timestamps. Nothing existing is altered. A pending reservation counts against the cap for a short window (`PENDING_RESERVATION_MS`, 15 minutes) so concurrent purchases can't exceed it.

### Webhook behaviour

- `subscription.price_id` is now the price of the item that matches a configured plan (`plans()`), **not** `items[0]`. If no item matches a configured plan it falls back to the first item that is not a known add-on (the old behaviour when no plans are configured).
- Items are rewritten from the **fetched** subscription inside the same transaction and only when the subscription write itself passes its guards: stale (older) events, ties, canceled-is-terminal and duplicate event ids all behave exactly as for the subscription row, and items can never be updated by an event the subscription row rejected. Removed items are pruned; if Stripe's embedded item list is truncated (`has_more`) nothing is pruned, and the webhook route's fetcher (`retrieveSubscriptionComplete`) pages through all items first.

### Entitlements

`computeEntitlements(planKey, [{key, quantity}], env?)` (pure) → `{ planKey, seats, locations, monthlyTexts, brandingRemoved, source, addons }`. `getEntitlements(orgId)` (server) reads the mirror and returns:

| Case | Result |
| --- | --- |
| `BILLING_ENABLED` off | `{ enforced: false, reason: "billing_disabled" }` (no DB query) |
| org in `BILLING_EXEMPT_ORG_IDS` | `{ enforced: false, reason: "exempt" }` |
| active / trialing | `{ enforced: true, reason: "ok", entitlements }` |
| other status | `reason: "not_active"`, all limits zero (the org is locked by §6 anyway) |
| no subscription row | `reason: "no_subscription"`, all zero |

**Where enforcement would hook in (not wired yet):** seats → `src/app/api/admin/invites/route.ts` / `src/lib/tenancy/invites.ts` (members + pending invites vs. `seats`); texts → `src/lib/server/integrations/notify.ts` (this month's sent SMS vs. `monthlyTexts`; decide soft vs. hard cap); branding → the public booking page; locations → no multi-location model exists yet. Each should call `getEntitlements` and skip when `enforced` is false.

### API

`/api/billing/addons` (same guards as the other billing routes: 404 unless `BILLING_ENABLED=true`, 503 if Stripe is not configured, 401 without a session, **403 for staff**; open to a locked Owner/Admin because `/api/billing/*` is exempt from the lock).

- `GET` → `{ addons: [{key, priceId, known, max}], entitlements, scheduled, scheduledUnavailable? }`. `entitlements` is what applies **now** (the mirrored items). `scheduled` is what Stripe already has queued for the next renewal, read live from the subscription's schedule: `{ effectiveAt (ISO), addons: [{key, from, to}], plan: {from, to} | null (a portal-scheduled downgrade), entitlementsAtRenewal }`, or `null` when nothing is pending. If Stripe can't be reached `scheduled` is `null` and `scheduledUnavailable: true` (the rest still answers).
- `POST {"addon":"seat","quantity":3}` sets the **absolute** quantity (0 removes). It finds the customer's live subscription in Stripe and returns `{ action, addon, quantity, currentQuantity, effectiveAt, proration: "none", billing }` where `action` is `created` / `updated` (applied now), `scheduled` (a decrease or removal waiting for `effectiveAt`), `schedule_cleared` (a pending decrease was cancelled) or `unchanged`. Errors: 400 unknown/unconfigured add-on, a negative or non-whole quantity, a quantity above the add-on's maximum (`max` in `GET`; the message names the add-on and the maximum, e.g. `Quantity 1000 is above the maximum of 10 for the "texts_1000" add-on. Choose 10 or fewer.`), or Stripe rejecting the request; 409 no subscription, subscription not `active`/`trialing`, plan not configured, the plan already includes branding removal, or a schedule we can't safely rewrite (discounts, trial, extra invoice items, or several future phases: use the billing portal). Our tables are updated only by the resulting `customer.subscription.updated` webhook (single writer).

**Billing policy (team decision 2026-10-27: no mid-cycle prorated charges):** every Stripe write uses `proration_behavior: "none"`, so there are no proration lines, mid-cycle invoices or credits.

| Request | What happens | Entitlement | Billed |
| --- | --- | --- | --- |
| new add-on / higher quantity | item created / updated now | immediately (when the webhook mirrors it) | first at the **next renewal** (free until then) |
| lower quantity / 0 | **nothing changes now.** A subscription schedule's next phase holds the lower quantity (or omits the item) | unchanged until the period ends | at the renewal the lower quantity (or nothing) is billed; no credit for the unused time |
| increase while a decrease is pending | applied now **and** the next phase is raised to the same quantity, so the pending decrease for that add-on is replaced | immediately | next renewal |
| quantity = current while a decrease is pending | pending decrease cancelled; our schedule is released when both phases end up identical | unchanged | unchanged |

How it works, from the Stripe docs and verified in the sandbox: a decrease calls `subscriptionSchedules.create({from_subscription})` (phase 1 = the live items up to `current_period_end`) and then `update` with two phases: phase 1 unchanged, phase 2 = the same items with the lower quantity for one billing period (`duration` taken from the plan price), `end_behavior: "release"`, `proration_behavior: "none"`. At the phase change Stripe swaps the items, bills the renewal invoice for the new phase and emits `customer.subscription.updated`, which the webhook mirrors (pruning the dropped item), so entitlements drop exactly at renewal. The schedule stays attached through that phase and is released by Stripe afterwards; a later decrease while the schedule is on its last phase just appends a phase.

**Interaction with the Customer Portal.** The portal's "schedule at period end" downgrades (`bpc_1UUvd05iQFiJ57yp2r2sV9Rv`) are also subscription schedules (Stripe: the portal "creates and attaches a subscription schedule"), and a subscription can have one. So `setAddonQuantity` never creates a second schedule: if one exists it edits the **next phase** (keeping the downgraded plan) and, because Stripe warns that direct subscription edits "might be overwritten" when the next phase starts, **every change while a next phase exists is written to both phases in one schedule update** (an increase is also applied to the current phase, immediately). A schedule with discounts, a trial or extra invoice items, or more than one future phase is refused (409) rather than rewritten. Not covered: what the portal does when it later wants to edit a schedule *we* created (portal downgrades are limited to prices of the same product, and add-ons are separate products, so the portal does not edit add-ons). Re-test that in the sandbox portal before launch.

**Decision for Brian:** under this policy an add-on added mid-cycle is **free until the first renewal** (nothing is charged now and the first charge is at renewal), and anything removed before renewal is never billed. Adding is immediate and removal waits for the period end, so the only "free" window is the time between adding and the next renewal. If that is not acceptable the alternatives are a prorated charge at add time (rejected by the team for now) or granting new add-ons only from the next renewal.

- Nothing in the app creates an add-on price: prices are made in Stripe and put in env.

### Sandbox objects (test mode, US sandbox `acct_1UUvH95iQFiJ57yp`)

**Final-pricing TEST prices** (metadata `flowops_final=true`, `placeholder=false`; created/verified by `scripts/sandbox-final-prices.ts`):

| Env var | Price id | Amount |
| --- | --- | --- |
| `STRIPE_PRICE_STARTER` | `price_1UUvY25iQFiJ57ypFl4SOyNb` | $49/mo |
| `STRIPE_PRICE_PRO` | `price_1UUvY35iQFiJ57ypBQeXz1q5` | $99/mo |
| `STRIPE_PRICE_BUSINESS` | `price_1UVE2V5iQFiJ57ypczrNOMo4` | $199/mo |
| `STRIPE_PRICE_STARTER_ANNUAL` | `price_1UVE2V5iQFiJ57ypHQRCGEOX` | $490/yr |
| `STRIPE_PRICE_PRO_ANNUAL` | `price_1UVE2V5iQFiJ57ypRdwYbSQp` | $990/yr |
| `STRIPE_PRICE_BUSINESS_ANNUAL` | `price_1UVE2W5iQFiJ57ypEoQcSUy7` | $1,990/yr |
| `STRIPE_ADDON_PRICE_SEAT` | `price_1UVB9h5iQFiJ57ypTZbo5ZBn` | $10/mo |
| `STRIPE_ADDON_PRICE_LOCATION` | `price_1UVB9h5iQFiJ57ypGYTvNWjm` | $29/mo |
| `STRIPE_ADDON_PRICE_BRANDING` | `price_1UVB9i5iQFiJ57ypFfJkhTj1` | $15/mo |
| `STRIPE_ADDON_PRICE_SEAT_ANNUAL` | `price_1UVE2W5iQFiJ57ypv2kubP9f` | $100/yr |
| `STRIPE_ADDON_PRICE_LOCATION_ANNUAL` | `price_1UVE2X5iQFiJ57ypVp72DG7L` | $290/yr |
| `STRIPE_ADDON_PRICE_BRANDING_ANNUAL` | `price_1UVE2Y5iQFiJ57ypXa4T0Nuh` | $150/yr |
| `STRIPE_ADDON_PRICE_TEXTS_1000` | `price_1UVE2Y5iQFiJ57ypZKKDswAr` | $15 one-time (1,000 texts) |

The old recurring placeholder `price_1UVB9i5iQFiJ57yplkbyM4ky` (texts_1000 $15/mo) was archived (no subscription used it). Live-mode prices with the same amounts must be created at launch.

Earlier placeholder add-on prices (now superseded for texts; the seat/location/branding monthly ones are reused above) (lookup key `test_addon_<key>_monthly`, metadata `flowops_addon=<key>`, `placeholder=true`): seat $10/mo `price_1UVB9h5iQFiJ57ypTZbo5ZBn`, location $29/mo `price_1UVB9h5iQFiJ57ypGYTvNWjm`, texts_1000 $15/mo `price_1UVB9i5iQFiJ57yplkbyM4ky`, branding $15/mo `price_1UVB9i5iQFiJ57ypFfJkhTj1`. Set them as `STRIPE_ADDON_PRICE_SEAT` etc. Live-mode prices are created at launch once Brian approves amounts.
