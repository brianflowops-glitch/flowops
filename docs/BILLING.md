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
| `src/lib/billing/addons.ts` | `setAddonQuantity()`: increases/new add-ons apply now and are **charged now, prorated** on an active subscription (`always_invoice` + `pending_if_incomplete`); during a trial they apply now **free until the trial end** (`TRIAL_ADDON_POLICY = "at_trial_end"`, 0008; the `charge_now` branch charges via `addon-charge.ts`); decreases/removals are scheduled for the renewal through a subscription schedule with no credit (§11) |
| `src/lib/billing/addon-charge.ts` | one-off charge helper for trial add-ons (the `charge_now` branch only since 0008), `trialProrationAmount()`, and `inspectProrationOutcome()` (voids a declined proration invoice so nothing is granted) |
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
| **Solo** (added 2026-10-31) | $19 | $190 | 1 seat / 1 location / 200 texts / FlowOps branding always shown; **no** branding, seat or location add-ons (text packs OK) |
| Starter | $49 | $490 | 3 seats / 1 location / 500 texts / branding not removed |
| Pro | $99 | $990 | 10 / 1 / 2,000 / branding removed |
| Business | $199 | $1,990 | 25 / 3 / 5,000 / branding removed (override: `PLAN_LIMITS_BUSINESS`) |

Add-ons: seat $10/mo ($100/yr), location $29/mo ($290/yr), branding removal $15/mo ($150/yr), **text pack** $15 for 1,000 texts, **one-time** (§11). Env: `STRIPE_PRICE_<PLAN>` (monthly) and `STRIPE_PRICE_<PLAN>_ANNUAL`; `STRIPE_ADDON_PRICE_<KEY>` and `STRIPE_ADDON_PRICE_<KEY>_ANNUAL`. Checkout takes `{plan, interval: "month"|"year"}` (default `month`); a plan with no annual price configured answers 400 for `year`. The webhook recognises monthly and annual prices of a plan alike.

**Free trial: 14 days** (`TRIAL_DAYS`, default 14, `0` disables). Checkout uses `subscription_data.trial_period_days` with **`payment_method_collection: "if_required"` (no card required for the trial; Brian, 2026-10-31)** and `trial_settings.end_behavior.missing_payment_method: "cancel"`: if there is still no card when the trial ends, Stripe cancels the subscription, nothing is charged, and the org sees the "Your plan has ended, choose a plan" lock screen (data untouched; a new Checkout then collects a card, since the trial is used). Checkout without a trial still uses `"always"`. **Add-a-card prompts:** a dashboard banner for Owner/Admin (`GET /api/billing/trial`, `TrialBanner`: days left; "Add a card" opens the portal's `payment_method_update` flow via `POST /api/billing/portal {"flow":"payment_method_update"}`), and an email to the org's Owner(s)/Admin(s) on Stripe's `customer.subscription.trial_will_end` (3 days before the end) when no card is on file (`trial-reminder.ts`, Resend account email; sent once per event thanks to the `stripe_event` dedupe; best effort). **Dashboard step:** add `customer.subscription.trial_will_end` to the webhook endpoint's events. Optional: Stripe's own trial-ending reminder email (Settings → Billing → Subscriptions and emails). During a no-card trial, add-ons still apply free until the trial end (0008), and text packs return 402 `no_payment_method` until a card is added. **One trial per business:** none is offered if the org has ever had a subscription, checked in our mirror **and** in the Stripe customer's subscription list (so cancel + resubscribe, a second checkout, or a lagging mirror never gets another; abandoned `incomplete` / `incomplete_expired` attempts don't count). `trialing` has full access (§6) and full entitlements. The checkout route returns `{url, plan, interval, trialDays}`.

Sandbox price ids for the final pricing are in §11 ("Sandbox objects").

**Solo (Brian, 2026-10-31):** `STRIPE_PRICE_SOLO` (monthly, $19) and `STRIPE_PRICE_SOLO_ANNUAL` ($190). `STRIPE_PRICE_SOLO_MONTHLY` is accepted as an alias of the monthly name (the unsuffixed name wins if both are set). **Until those are set, Solo simply isn't offered:** no button on the plan picker (lock screen) or in the billing card, `GET /api/billing/plan` doesn't list it, and a checkout or plan switch for `solo` is a 400 with no Stripe call; every other plan works as before. Monthly set but not annual → Solo is monthly only. Solo is the lowest tier (`PLAN_TIERS` in `entitlements.ts`: solo < starter < pro < business), so a move to Solo is a downgrade (at the renewal) and Solo → anything is an upgrade. Limits chosen to match how Starter is defined: 1 seat, 1 location, **200 texts/month** (Starter's per-seat share, 500 / 3 ≈ 167, rounded up), branding not removed. The branding-removal add-on, extra seats and extra locations are **not available on Solo** (`PLAN_BLOCKED_ADDONS`): `POST /api/billing/addons` answers 409 "… not available on the Solo plan. Upgrade to Starter …" before any Stripe call (setting quantity 0 is still allowed), `GET /api/billing/addons` marks them `available: false`, switching to Solo is refused (409, nothing written) while one of them would still be on the subscription at the time Solo starts, and entitlements ignore one added in Stripe directly. An unrecognised plan price still falls back to **Starter** limits (not Solo). Live: create a "FlowOps Solo" product with the two prices (see the patch report); nothing in code creates live objects.

**Earlier approval (Brian, 2026-10-26):** Starter **$49/mo** and Pro **$99/mo**, USD, monthly. In the US sandbox (`Flowops Inc sandbox`, test mode) these are `price_1UUvY25iQFiJ57ypFl4SOyNb` (Starter, lookup key `test_starter_monthly`) and `price_1UUvY35iQFiJ57ypBQeXz1q5` (Pro, `test_pro_monthly`) → `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO`. Live-mode Prices with the same amounts get created at launch. Add-on support is built (§11) but **add-on prices are placeholders**; Brian has not approved them. FlowAI usage and the voice agent are not add-ons yet.

### Plan changes and cancellation (Brian, 2026-10-26)

> **Superseded (2026-10-30):** plan changes are now in-app (§13): upgrades are charged now with proration (`UPGRADE_POLICY = "prorate_now"`), downgrades and annual → monthly wait for the renewal. The Customer Portal keeps plan switching **off**. The text below is the 2026-10-26 history.

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
| no subscription row | org never subscribed | locked (`no_subscription`), unless in `BILLING_EXEMPT_ORG_IDS` or `organization.is_demo = true` |

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
| `getBillingAccess(orgIdOrRow, role?)` → `{ access: "full" \| "locked", reason, status, canManageBilling }` | `reason`: `"ok"`, `"billing_disabled"`, `"exempt"`, `"demo"`, `"no_subscription"`, or the locked status (`"past_due"`, `"unpaid"`, `"incomplete"`, `"incomplete_expired"`, `"canceled"`, `"paused"`). `status` is the stored subscription status or `null`. `canManageBilling` = Owner or Admin. One indexed read of `subscription` (plus one of `organization.is_demo` when only an id is passed; pass the org row, as `requireApi` and the dashboard layout do, to skip it); none when billing is off. |
| `requireBillingAccess(req, ctx)` | Called from the shared API guard `requireApi()` (`src/lib/server/context.ts`), after the auth and role checks, so every route that uses `requireApi` inherits it. Returns `null` (go ahead) or **402** `{ "error": "billing_locked", "reason", "status", "canManageBilling" }`. Paths under `/api/billing/`, `/api/auth/`, `/api/invites/` are exempt. |
| `canManageBilling(role)`, `isBillingExemptPath(path)`, `resolveBillingAccess(...)`, `billingExemptOrgIds(env)`, `effectiveSubscription(rows)` | Pure helpers (in `access-rules.ts`, unit-tested offline). |

If an org has several subscription rows (e.g. an old canceled one and a new active one), any `active`/`trialing` row wins; otherwise the most recently updated row decides. The dashboard lock screen (Bot) calls `getBillingAccess(ctx.org, ctx.role)` in the dashboard layout, or react to the 402 from `/api/state`.

### Orgs without a subscription, and exemptions (founder decision)

When billing is turned on, an org that has never subscribed is **locked** (`no_subscription`) and is sent to Checkout. Existing orgs that predate billing, such as `org_flowops_demo` (Brian's own workspace) and pilot customers, must be listed in `BILLING_EXEMPT_ORG_IDS` (comma-separated org ids) **before** `BILLING_ENABLED=true` goes on, or they get locked too. Exempt orgs always get full access, even with a failed or canceled subscription. **Brian to confirm:** which orgs are exempt, and whether new sign-ups should get a free trial instead of an immediate lock (a Stripe trial gives `trialing` → full).

**Demo orgs (`organization.is_demo = true`) always have access** (`reason: "demo"`), with or without a subscription row and whatever its status, the same orgs the add-on sweep cron skips (§11). `org_flowops_demo` is seeded with `is_demo = true` by `scripts/db-migrate.ts`, so it can't be locked out even if `BILLING_EXEMPT_ORG_IDS` is empty or mistyped. Access is decided from the database only: a demo org is never sent to Stripe Checkout automatically (an Owner/Admin can still choose to subscribe). Every other org (`is_demo = false`) with no subscription row is locked as `no_subscription`, and `past_due` / `unpaid` / `canceled` / … still lock it (§6). Order: billing off → `billing_disabled`; `active`/`trialing` → `ok`; exempt → `exempt`; demo → `demo`; else locked. `getEntitlements` (§11) does not yet treat demo orgs as unlimited; add that when enforcement is wired.

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
| `STRIPE_PRICE_<PLAN>` | Vercel | one per plan (`SOLO`, `STARTER`, `PRO`, `BUSINESS`), monthly `price_…` ids (`STRIPE_PRICE_<PLAN>_MONTHLY` also accepted). A plan without one isn't offered |
| `STRIPE_PRICE_<PLAN>_ANNUAL` | Vercel | the plan's yearly price (10× monthly); same plan key, interval `year`. Without it, `interval: "year"` checkout → 400 |
| `STRIPE_ADDON_PRICE_<KEY>` | Vercel | one per add-on: recurring monthly prices for `SEAT`, `LOCATION`, `BRANDING`, and the **one-time** price for `TEXTS_1000` (the text pack, §11). Distinct prefix from `STRIPE_PRICE_*`, so never read as a plan |
| `STRIPE_ADDON_PRICE_<KEY>_ANNUAL` | Vercel | yearly recurring price of `SEAT` / `LOCATION` / `BRANDING`, used for add-ons on an annual subscription; missing → add-on route 409 on annual subscriptions |
| `STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000` | Vercel (optional) | a *recurring* texts price that existing subscriptions may still hold; counted in entitlements, never sold |
| `TRIAL_DAYS` | Vercel (optional) | free-trial length, default 14, `0` disables |
| `STRIPE_ADDON_MAX_<KEY>` | Vercel (optional) | override the most one subscription may hold of an add-on (positive whole number, 1–1000), e.g. `STRIPE_ADDON_MAX_TEXTS_1000=20` (for text packs: max packs per billing period); defaults in §11 |
| `PLAN_LIMITS_<PLAN>` | Vercel (optional) | override a plan's limits, e.g. `seats=3,locations=1,texts=500,branding=false` or JSON; defaults exist for `solo`, `starter`, `pro` and `business` (§11) |
| `STRIPE_ALLOW_LIVE` | Production only, at launch | must be `true` before an `sk_live_` key is accepted |
| `BILLING_EXEMPT_ORG_IDS` | Every environment with billing on | comma-separated org ids never locked (e.g. `org_flowops_demo`); set **before** `BILLING_ENABLED=true` (§6) |
| `CRON_SECRET` | Vercel (sensitive), every environment with crons | shared with `/api/cron/notifications`; Vercel Cron sends it as `Authorization: Bearer …`. Unset → the add-on sweep cron returns 503 (§11) |
| `DATABASE_URL_UNPOOLED` | Vercel (set by the Neon integration) | Neon's **direct** (non-pooler) URL, used only by the small add-on lock pool (session advisory locks don't work through PgBouncer transaction mode). Without it, and with a `-pooler` `DATABASE_URL`, add-on changes and the sweep cron return 503 (§11) |

No publishable key is needed (hosted Checkout/Portal via redirect).

## 9. Test plan (test mode only)

Automated, no network:
- `npm run test:billing` — plan config parsing, live-key refusal, status/access rules, which existing subscription statuses block a second checkout, signature verification (valid accepted, tampered rejected) with a locally generated header; the access lock: every status → full/locked, no subscription, flag off, exempt list, Owner/Admin/Staff `canManageBilling`, exempt vs. guarded API paths, the 402 body.
- `DATABASE_URL=<throwaway local postgres> npm run test:billing:db` — runs `processStripeEvent` against a scratch DB after `npm run db:migrate`, with a **mocked** Stripe client: checkout links customer; the fetched state (not the payload) is written; duplicates skip without a Stripe call; two updates delivered in reverse order → the newer status wins; same-second tie → fetched state wins; canceled stays canceled even for a newer event; unknown org or a failed Stripe retrieve rolls back (event not recorded); access lock on its own test org: no row → locked, exempt → full, flag off → full, active → full, `invoice.payment_failed` → `past_due` → locked (Owner/Admin can still manage billing, Staff can't), the guard returns 402 for `/api/state` but not for `/api/billing/*`, `/api/auth/*`, data still there, `invoice.paid` → `active` → full again, `unpaid`/`canceled` → locked. The script refuses hosted DB URLs.

Add-on tests (§11): `test:billing` also covers add-on env parsing, plan-limit parsing (defaults, key=value, JSON, malformed values), `computeEntitlements`, price-id classification, and `setAddonQuantity` against a fake Stripe client with a stateful fake subscription schedule (create / increase on an active subscription use `proration_behavior: "always_invoice"` + `payment_behavior: "pending_if_incomplete"` and return the paid proration invoice; a declined proration voids the invoice and grants nothing, also with a pending decrease (schedule untouched); trial increases are charged on a standalone invoice first, 402 with no card or a decline; `trialProrationAmount` math; rollover expiry (monthly, 31st anchor, annual mid-year / last month, trial), `splitTextUsage`, pack consumption order and the per-window cap; decrease and removal only write a schedule whose next phase holds the lower quantity and never touch the item; a repeated decrease is a no-op; a different decrease replaces the pending one; an increase replaces a pending decrease and releases the schedule; asking for the current quantity cancels a pending decrease; a portal-made plan-downgrade schedule is edited, kept and never released; schedules with discounts or several future phases are refused; `scheduledChanges()` diff; rejects unknown add-on, bad quantity, non-active subscription, branding on a plan that includes it, unconfigured plan). `test:billing:db` also covers: plan identified by price id when an add-on is `items[0]`, item mirroring, quantity changes, pruning removed add-ons, entitlements unchanged while a decrease is scheduled and dropping when the renewal event arrives, duplicate events, stale (older) events not rewriting items, same-second ties, truncated item lists (`has_more`) not pruning, plan swap keeping add-ons, `past_due` → zero entitlements, canceled terminal, org-delete cascade, `getEntitlements` for billing off / exempt / no subscription. `npm test` includes `tests/billing-addons-route.test.ts` (404 when off, 503 unconfigured, 401, **403 for staff**, 400 on bad bodies, GET works for a locked Owner/Admin).

Final-pricing tests: `test:billing` (offline) also covers annual plan/add-on env parsing and price classification, `TRIAL_DAYS`, the Checkout session params (`checkoutSessionParams`), Business defaults, pack clamping and the pure text-pack rules (`text-pack-rules.ts`). `test:billing:db` covers the `text_pack` lifecycle on a scratch Postgres (paid, declined → voided + failed, cap, concurrency, no payment method, trialing, non-active statuses, reconcile after an error, `invoice.paid` / `invoice.payment_failed` settlement with dedupe, legacy recurring texts, annual mapping) and trial eligibility (mirror and Stripe list). `tests/billing-addons-route.test.ts` covers the text-packs and checkout routes. `test:billing:ui` covers the Monthly / Yearly toggle.

Live sandbox check (test mode, **US sandbox `acct_1UUvH95iQFiJ57yp` only**): `STRIPE_SECRET_KEY_TEST_US=sk_test_… DATABASE_URL=<throwaway local postgres> npm run test:billing:sandbox` (`scripts/billing-sandbox-final.ts`). It first runs `scripts/sandbox-final-prices.ts` (idempotent: finds or creates the final TEST prices by lookup key, metadata `flowops_final=true`, `placeholder=false`) and then, on Stripe test clocks, runs the **real** Stripe events through `processStripeEvent`:
1. Checkout Session params accepted by Stripe (trial; annual price; no trial).
2. **Trial lifecycle** (Starter monthly): trialing for 14 days with a $0 invoice; a text pack bought **during the trial** is charged in full immediately (standalone paid invoice, not deferred to trial end); packs capped at 10; day 14 → active, first invoice $49 without packs, the trial packs roll over into the first paid month (0004) and the cap resets; cancel + resubscribe gets **no second trial**, even with an empty mirror.
3. **Declined card** (Pro monthly): 402 `payment_failed` with the portal link, the pack invoice is **voided**, nothing granted, row `failed`, the real `invoice.payment_failed` webhook does not flag the subscription; with a good card the full cap still works; no card on file → 402 `no_payment_method` with no Stripe invoice.
4. **Annual Pro** with annual add-ons: $990 invoice; 409 with no annual add-on price; annual seat/location prices, each add charged now prorated (≈ the full annual price at the start of the year); pack window per month, rollover to the next month; seat decrease scheduled to the period end (a year away); renewal invoice $990 + $100 + $290 = $1,380.
5. **Business monthly**: $199, 25/3/5,000 entitlements; seats added immediately and charged now prorated, removed at period end with no credit; renewal invoice $209.
**Patch 0004** (`scripts/billing-sandbox-0004.ts`, same env): Pro monthly active on a test clock, advanced half a period → +2 seats gives an immediate paid `subscription_update` invoice of 1,000¢ (proration line "Remaining time on 2 × FlowOps extra seat"); with `pm_card_chargeCustomerFail` as default, +2 more → 402, invoice voided, no `pending_update`, quantity unchanged; a decrease is scheduled with no invoice / credit, then an increase over it is charged 500¢ and supersedes the decrease; renewal $129; a trial +1 seat 7 days in was charged 233¢ on a standalone invoice, and with no card → 402 (19 checks, run 2026-10-27). **Since 0008** section D expects `at_trial_end`: the trial +1 seat → `created`, `proration: "none"`, `charge: null`, `freeUntil` = trial end, no Stripe charge (only Stripe's own $0 "Free trial for 1 × …" `subscription_update` invoice), still trialing; with no card → still applied free (no 402). 20 checks, run 2026-10-28.

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

**Patch 0005** (`scripts/billing-sandbox-0005.ts`, same env): a trial +2 seats with `pm_card_chargeCustomerFail` → 402, its invoice void, attempt `failed`; switch to Visa and retry → a new invoice, paid (467¢), seats 2, attempt `applied`; removing the seats during the trial → scheduled, `trial_end` and `status: trialing` unchanged, phase 1 keeps `trial_end`, first post-trial invoice $99 only; a simulated crash after the trial charge (item write and first refund fail) leaves the row `paid`, the sweep refunds it with one credit note, a second sweep adds none. Since 0006 it also checks fix 3: with a pending removal scheduled, +3 seats is charged (710¢) and written, then a simulated failure re-reading the schedule surfaces, but the row is already `applied` and the sweep adds no credit note. Last run 2026-10-27 (17/17). **Since 0008** sections A, C, D pin the `charge_now` branch (`setAddonQuantityUnderPolicy`), and section E checks the default `at_trial_end` end to end: 5 days into a Pro trial, +2 seats and +1 location → no charge (no Stripe charge, no `addon_charge` row; only Stripe's two $0 "Free trial for …" invoices); the upcoming-invoice preview is 14,800¢; at the trial end the first invoice (`subscription_cycle`) is paid 14,800¢ = Pro 9,900 + 2 × 1,000 + 2,900, the only non-zero invoice and the only charge; entitlements 12 seats. Run 2026-10-28 (24/24).

## 10. Founder decisions needed (Brian)

1. ~~Plans and prices~~ **decided for now: Starter $49/mo, Pro $99/mo, USD** (§3). Add-on mechanics are built (§11) with placeholder prices; still open: final add-on prices, annual option/discount, a third tier.
2. **Free trial**: yes/no and length; card required up front? **Decided:** 14 days, no card required (2026-10-31).
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
- **Plan limits:** defaults from the pricing proposal, **Brian to confirm**: Solo 1 seat / 1 location / 200 texts / branding not removed (no branding, seat or location add-ons, §3); Starter 3 seats / 1 location / 500 texts / branding not removed; Pro 10 / 1 / 2,000 / branding removed. Override or define any plan (e.g. Business) with `PLAN_LIMITS_<PLAN>`, either `seats=30,locations=5,texts=10000,branding=true` or JSON `{"seats":30,"locations":5,"texts":10000,"branding":true}`. Unspecified fields keep the default; malformed values are ignored (never widen a limit). A plan with neither a default nor an override gets **Starter's limits** (fallback, flagged `source: "fallback"`) rather than unlimited.
- Add-ons share the plan's billing interval (Stripe requires one interval per subscription). The add-on route reads the subscription's interval and uses the matching price (`STRIPE_ADDON_PRICE_<KEY>` for monthly, `…_ANNUAL` for yearly: seat $100, location $290, branding $150 per year); if that price isn't configured it answers **409** and changes nothing.
- **Business** defaults (override `PLAN_LIMITS_BUSINESS`): 25 seats, 3 locations, 5,000 texts, branding removed.

### Text packs (one-time, final pricing 2026-10-27)

A text pack is **$15 for 1,000 texts, charged in full at purchase** (`STRIPE_ADDON_PRICE_TEXTS_1000` is a *one-time* price). It is not a subscription item and never rides on the renewal invoice.

- `POST /api/billing/text-packs {quantity}` (Owner/Admin; same guards as the other billing routes) reserves the pack under an org row lock, creates a **standalone invoice** (`auto_advance: false`, no pending items, metadata `flowops_text_pack`), adds the item, finalizes it and **pays it immediately with the card on file**. Texts are granted only after the invoice is `paid` (row `paid`).
- **Failed charge grants nothing.** If payment fails the invoice is **voided** (or deleted if still a draft) so it can never be paid later, the row is marked `failed`, and the route returns **402** `{error:"payment_failed", portal:"/api/billing/portal"}`. A failed attempt doesn't use up the cap. If an error happens after Stripe actually collected, the row is reconciled to `paid` instead.
- **During a trial** the pack is charged in full immediately like any other time: never free, never deferred to the trial end. **No payment method → 402** `no_payment_method` (portal link) and no invoice is created. No subscription (or not `active`/`trialing`) → 409.
- **Validity: rollover for ONE extra period (Brian, 2026-10-27, patch 0004).** A pack is bought in a *window*: the current billing period (for an annual plan, the current **month** of the year; for a trial, the trial). Unused texts stay usable through the **next** window and then expire: `expires_at` = end of the window after the purchase window (monthly: period start + 2 months; annual: the month after this month of the year; trial: trial end + 1 month), fixed at purchase (`textPackExpiry()` in `text-pack-rules.ts`). Rows from before `0010` have `expires_at` null and expire at their own `period_end`.
- **Consumption order:** the plan's monthly allowance first, then packs **soonest-expiring first** (ties: oldest purchase, then id). `consumeTexts(db, {orgId, allowance, sentBefore, count})` in `text-packs.ts` does that under the org row lock and records the draw in `text_pack.texts_used`; if the packs can't cover the overflow it denies the remainder without drawing (or, with `partial: true`, draws what is left). **Not wired into the SMS sender yet** (same as the other enforcement hooks below).
- **Cap:** at most **10 packs bought per window** (`STRIPE_ADDON_MAX_TEXTS_1000`); packs rolled over from the previous window do **not** count toward this window's cap (so up to 10 + 10 can be usable at once). An 11th in the window → 400 before any Stripe call. Entitlements: `includedTexts` (plan), `packTexts` (unused texts of usable packs, cap applied per purchase window) and `monthlyTexts = includedTexts + packTexts`. The purchase response has `windowEnd` (end of the purchase window) and `validUntil` (= `expires_at`).
- **Webhook:** `invoice.paid` / `invoice.payment_failed` carrying `metadata.flowops_text_pack` settle the `text_pack` row (deduped by `stripe_event`) and return early: they never touch the subscription mirror (a failed pack payment doesn't mark the org `past_due`).
- `texts_1000` is **removed from the recurring add-on path**: `POST /api/billing/addons` answers 400 for it and points to `/api/billing/text-packs`. A *legacy recurring* texts item an existing subscription still holds is mirrored and counted in entitlements but never sold (`STRIPE_ADDON_LEGACY_PRICE_TEXTS_1000`). `GET /api/billing/addons` adds `textPacks: [{key, priceId, texts, max}]`.

### Seats, locations, branding (final)

Added = **immediate and charged now, prorated for the rest of the current period** (monthly or annual), then the full price from the next renewal (Brian, 2026-10-27, patch 0004). Removed or decreased = stays until the period end (subscription schedule), **no refund or credit** (unchanged). Branding behaves like seats. Same on monthly and annual subscriptions. Details under *API* below.

### Data model (`0008_billing_addons`, additive)

`subscription_item`: `id`, `subscription_id` → `subscription.id` (cascade), `stripe_item_id` (unique), `price_id`, `quantity`, `created_at`, `updated_at`. The migration touches only the new `subscription_item` table (no existing table, including `notification`, is altered). **Renumbering:** another open PR (email reminders) also uses `0008`. Whichever merges second renumbers to `0009`: after rebasing, delete `drizzle/0008_billing_addons.sql`, `drizzle/meta/0008_snapshot.json` and its `_journal.json` entry, then run `DATABASE_URL=postgres://x npx drizzle-kit generate --name billing_addons` (regenerates it as the next number on top of the other PR's snapshot). Nothing else in the code refers to the migration number. Plan vs. add-on is **derived at read time** from price id ↔ env (like `subscription.price_id` ↔ plan), so changing env needs no data migration.

### Data model (`0010_text_pack_rollover`, additive)

`text_pack` gains `expires_at` (timestamptz, nullable: older rows fall back to `period_end`), `texts_used` (integer, not null, default 0: texts drawn from the pack by `consumeTexts`) and index `text_pack_org_expires_idx (organization_id, expires_at)`. No column is dropped or changed.

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
- `POST {"addon":"seat","quantity":3}` sets the **absolute** quantity (0 removes). It finds the customer's live subscription in Stripe and returns `{ action, addon, quantity, currentQuantity, effectiveAt, proration: "always_invoice" | "none", charge, freeUntil, billing }` (`charge` = `{kind: "proration" | "trial_proration", invoiceId, amountPaid, currency, lines?}` or `null`; `freeUntil` = the trial end (ISO) for a trial increase applied free under `at_trial_end`, else `null`, and `billing` then says "Active now, free for the rest of the trial. Billed in full from the first invoice when the trial ends (…); nothing is charged now.") where `action` is `created` / `updated` (applied now), `scheduled` (a decrease or removal waiting for `effectiveAt`), `schedule_cleared` (a pending decrease was cancelled) or `unchanged`. Errors: 400 unknown/unconfigured add-on, a negative or non-whole quantity, a quantity above the add-on's maximum (`max` in `GET`; the message names the add-on and the maximum, e.g. `Quantity 1000 is above the maximum of 10 for the "texts_1000" add-on. Choose 10 or fewer.`), or Stripe rejecting the request; 409 no subscription, subscription not `active`/`trialing`, plan not configured, the plan already includes branding removal, or a schedule we can't safely rewrite (discounts, extra invoice items, or several future phases: use the billing portal; a phase's `trial_end` is carried over since 0005). 402 `{error, code: "payment_failed" | "no_payment_method", portal: "/api/billing/portal"}` when the prorated charge is declined or (in a trial, `charge_now` branch only) there is no card; 502 `code: "stripe_error"` when Stripe fails mid-charge, or when an active-subscription increase is left pending and we can't identify the invoice it created (nothing voided, nothing granted; the pending update expires on its own after ~23 h unless that invoice is paid). The route serialises add-on changes per org with a session advisory lock (`withAddonChangeLock`, see *Concurrency and connections* below) so two tabs can't double-charge; 409 `code: "change_in_progress"` if another change for the org holds it for more than 20 s, 503 `code: "db_unavailable"` (`Retry-After: 5`) if no database connection is free within the pool's timeout. Nothing is charged in either case. Our tables are updated only by the resulting `customer.subscription.updated` webhook (single writer).

**Billing policy (Brian, 2026-10-27, patch 0004; replaces the earlier "no mid-cycle prorated charges" policy):** increases are charged now, prorated; decreases wait for the renewal with no credit. **Trials (Brian, 2026-10-28, patch 0008):** an increase during a free trial waits for the trial end: it is applied now with no charge and billed in full on the first invoice when the trial ends (`TRIAL_ADDON_POLICY = "at_trial_end"`). Trade-off accepted: a trial user can add up to the caps (e.g. 50 seats, 10 locations) free for the rest of the trial and cancel before it ends; charges start at the trial end.

| Request | What happens | Entitlement | Billed |
| --- | --- | --- | --- |
| new add-on / higher quantity, `active` | item created / updated with `proration_behavior: "always_invoice"`, `payment_behavior: "pending_if_incomplete"`: Stripe invoices the prorated difference **now** (`billing_reason: subscription_update`) and charges the card | immediately, only once paid | prorated now (e.g. 2 seats half-way through a month ≈ $10), full price from the next renewal |
| … and the payment fails | Stripe keeps the change as `pending_update` (nothing applied); we **void** the invoice this write created, which discards the pending update, and return **402** `payment_failed`. Only that invoice is ever voided (0005): the subscription's new latest invoice, id ≠ the one before the write, `billing_reason: subscription_update`, same subscription. Otherwise nothing is voided and we return **502** | unchanged | nothing (the voided invoice can't be collected later) |
| new add-on / higher quantity, `trialing` (**default, `at_trial_end`, 0008**) | item created / updated with `proration_behavior: "none"`; **no charge, no invoice of ours, no `addon_charge` row, no card needed now** (no 402). Stripe itself issues a **$0** `subscription_update` invoice ("Free trial for 2 × FlowOps extra seat") for the item change, as it does for any trial change; nothing is collected. With no card at the trial end Stripe cancels the subscription (`missing_payment_method: "cancel"`) | immediately | nothing now; billed in full on the first invoice at the trial end (sandbox: Pro $99 + 2 seats + 1 location = $148.00 on that one invoice) |
| new add-on / higher quantity, `trialing`, **`charge_now` branch** (not the default since 0008; kept and tested) | we charge our own standalone invoice first (`auto_advance: false`, metadata `flowops_addon_charge=trial_proration`): unit price × added quantity × remaining trial time ÷ one interval (a month or a year from now), paid immediately with the card on file; only then the item is added with `proration: none`. No card → **402** `no_payment_method`, nothing created. Each attempt is an `addon_charge` row written **before** any Stripe call, with its own idempotency key (`flowops-trial-addon-<attempt id>-<payment method>`), so a retry after a decline gets a fresh invoice. If adding the item fails or the process dies after the charge, the attempt is settled from Stripe's state (below): added after all → kept; not added → refunded once with a credit note | immediately, only once paid | the trial portion now, full price from the first post-trial invoice |
| lower quantity / 0 | **nothing changes now.** A subscription schedule's next phase holds the lower quantity (or omits the item) | unchanged until the period ends | at the renewal the lower quantity (or nothing) is billed; no credit for the unused time |
| increase while a decrease is pending | the item is written first (charged as above, or free in a trial under `at_trial_end`; a declined charge leaves the schedule untouched), then both schedule phases are set to the new quantity with `proration: none` (the schedule is released when the phases match), so the pending decrease for that add-on is replaced | immediately | prorated now for the increase over the current quantity |
| quantity = current while a decrease is pending | pending decrease cancelled; our schedule is released when both phases end up identical | unchanged | unchanged |

Webhook: the proration invoice belongs to the subscription and the subscription stays `active`, so the existing handlers just mirror the new items; the trial standalone invoice has no subscription and no pack metadata, so `invoice.*` events for it are recorded and ignored. A declined proration does not mark the org `past_due`. Stripe's $0.50 minimum (not verified in the sandbox): an invoice below it is not charged on the card; Stripe marks it paid and carries the amount to the customer balance, collected on the next invoice. That applies to both the proration invoice and the `charge_now` trial charge (e.g. one seat added in the last hour of a trial).

How it works, from the Stripe docs and verified in the sandbox: a decrease calls `subscriptionSchedules.create({from_subscription})` (phase 1 = the live items up to `current_period_end`, or up to `trial_end` with that `trial_end`, during a trial) and then `update` with two phases: phase 1 unchanged, phase 2 = the same items with the lower quantity for one billing period (`duration` taken from the plan price), `end_behavior: "release"`, `proration_behavior: "none"`. At the phase change Stripe swaps the items, bills the renewal invoice for the new phase and emits `customer.subscription.updated`, which the webhook mirrors (pruning the dropped item), so entitlements drop exactly at renewal. The schedule stays attached through that phase and is released by Stripe afterwards; a later decrease while the schedule is on its last phase just appends a phase.

**Interaction with the Customer Portal.** The portal's "schedule at period end" downgrades (`bpc_1UUvd05iQFiJ57yp2r2sV9Rv`) are also subscription schedules (Stripe: the portal "creates and attaches a subscription schedule"), and a subscription can have one. So `setAddonQuantity` never creates a second schedule: if one exists it edits the **next phase** (keeping the downgraded plan) and, because Stripe warns that direct subscription edits "might be overwritten" when the next phase starts, **every change while a next phase exists is written to both phases in one schedule update** (an increase is also applied to the current phase, immediately). A schedule with discounts or extra invoice items, or more than one future phase, is refused (409) rather than rewritten. Phase `trial_end` is carried over by `phaseParam` (0005), so removing an add-on during a trial leaves the trial end unchanged (sandbox-verified). Not covered: what the portal does when it later wants to edit a schedule *we* created (portal downgrades are limited to prices of the same product, and add-ons are separate products, so the portal does not edit add-ons). Re-test that in the sandbox portal before launch.

**Trial add-on policy switch (0005; flipped to `at_trial_end` in 0008).** Whether a trial increase is charged now (`"charge_now"`, the default until 0008) or applied free and billed in full at the trial end (`"at_trial_end"`, **the default since 0008**, Brian 2026-10-28) is ONE code constant, `TRIAL_ADDON_POLICY` in `src/lib/billing/addons.ts` (pure mapping `trialIncreaseHandling()`). It is deliberately not an env var or a runtime setting. Flipping it is a reviewed code change that must also update the guard test in `scripts/billing-tests.ts` and this section. Both branches stay tested: the default path through `setAddonQuantity`, and the `charge_now` branch through `setAddonQuantityUnderPolicy("charge_now", …)` (tests and sandbox scripts only). Active subscriptions are not affected by it. **Unused code under `at_trial_end`:** the trial charge (`chargeTrialIncrease`, `addon-charge.ts` one-off charge, per-attempt idempotency keys), the `addon_charge` attempt rows, and the sweep/cron below are no longer reached by new requests. They are left in place because they ARE the `charge_now` branch (flipping back is a one-line change), and because reconciliation still settles any attempt row written before the flip (at the start of the org's next change and in the daily sweep). Lint does not flag any of it (it is all exported/used). The cron in `vercel.json` is unchanged; with no rows it finds nothing to do.

**Crash safety for trial charges (0005, table `addon_charge`, migration `0011_addon_charge`, additive; applies to the `charge_now` branch only since 0008).** Statuses: `pending` (row written, charge in flight) → `paid` (money collected) → `applied` | `refunded`; `pending` → `failed` (nothing collected). Rows are written in autocommit on the request's lock connection (no surrounding transaction), so nothing a later error does can roll them back. `reconcileAddonCharges` (caller holds the org lock) settles leftovers: `pending` → find the invoice (stored id, else the customer's invoices by metadata `flowops_addon_charge_id`): paid → treat as `paid`; open/draft → void → `failed`; none → `failed`. `paid` → the add-on counts as applied if the subscription item for that price has at least `to_quantity` → `applied`; otherwise a credit note refunds the invoice → `refunded`. Refunds can't happen twice: existing credit notes on the invoice tagged with the attempt id are reused, the create has idempotency key `flowops-addon-refund-<attempt id>`, and only `pending`/`paid` rows are looked at. Reconciliation never writes a subscription item (never grants). It runs (1) inline after a failed apply, (2) at the start of the org's next add-on change, and (3) in `sweepAddonCharges(db, stripe)` (every org, its own org lock, rows older than 10 min, one failing org/attempt doesn't stop the rest). Since 0006 the sweep runs daily from `GET /api/cron/addon-charges` (below). **Applied as soon as Stripe confirms (0006):** the attempt row is marked `applied` the moment the subscription-item create/update returns, before any later step (schedule re-read/rewrite), so a failure after that point never refunds an add-on that was granted, and a later portal or schedule decrease can no longer turn it into a refund. That closes the 0005 edge case except for a tiny window: if the process dies (or the `applied` write itself fails) between Stripe's confirmation and that one row update, the row stays `paid`; the sweep then finds the item and marks it applied, and only if the quantity was also lowered below `to_quantity` before the sweep runs is it refunded (customer-favouring, as before).

### Concurrency and connections (0006)

Each add-on POST uses **one** database connection. 0005 held two (the lock transaction plus the global pool for the attempt rows), so five concurrent requests on the max-5 pool, which had no connection timeout, could hang the instance.

- **Lock:** `pg_try_advisory_lock(hashtext('flowops:addon-change'), hashtext(org_id))`, a session-level lock in its own two-int4 key space (never collides with the single-bigint org locks in `pipeline.ts`). The `addon_charge` writes autocommit on that same client. The unlock is in `finally`; if it can't be confirmed the connection is destroyed (the server then drops the lock).
- **Waiting:** a request that finds the lock busy releases its connection, sleeps with backoff and retries for up to 20 s (then 409). Waiters hold no connection, so one busy org can't starve the others.
- **Pools:** session work runs on a small dedicated pool (`getSessionPool`, max 3, `connectionTimeoutMillis` 5 s, `idle_session_timeout = 120s` set per connection so a lock held by a frozen or killed function is released by the server). The main pool now has `connectionTimeoutMillis` 10 s. A timeout on either → 503 `db_unavailable`, never a hang. The route's `maxDuration` is 60 s, below the idle timeout.
- **Neon:** the pooled URL (`-pooler.` host, PgBouncer in transaction mode) does not keep session state between transactions, so a session advisory lock there could be taken on one server connection and "released" on another. The session pool therefore uses `DATABASE_URL_UNPOOLED` (Neon's direct URL, set by the Vercel integration), falls back to `DATABASE_URL` only when that is not a `-pooler` host, and otherwise refuses (503, nothing charged). `pg_advisory_xact_lock` would work through PgBouncer but would force the attempt rows into the lock's transaction, and a rollback would lose the record of money already collected, so it was not used.
- **Not serialised against text packs:** text-pack purchases still lock the org row (`FOR UPDATE`); add-on changes no longer do. They touch disjoint state (a one-time invoice vs. subscription items), so this is intended.

### Sweep cron (0006)

`GET /api/cron/addon-charges`, registered in `vercel.json` as `0 9 * * *`: once a day, which the Vercel Hobby plan allows. Hobby fires it at some point within that hour, roughly 09:00–09:59 UTC (5–6 AM New York in summer time). Auth is the same as `/api/cron/notifications`: `Authorization: Bearer $CRON_SECRET`, constant-time compare, 503 if `CRON_SECRET` is unset, 401 on mismatch. With `BILLING_ENABLED` off, or Stripe not configured, it returns 200 `{skipped}` and touches nothing. It never touches `org_flowops_demo`, `BILLING_EXEMPT_ORG_IDS`, or any org with `organization.is_demo` set (0007). If the lock pool can't work (a Neon `-pooler` `DATABASE_URL` without `DATABASE_URL_UNPOOLED`) or gets no connection, the run fails with **503** `{error: "session_db_unavailable", message}` before touching anything, so Vercel's cron log shows a failed run instead of a quiet 200 (0007). Each org is settled under its add-on lock with no waiting: a busy org is skipped (a live request settles it anyway) and retried the next day. After 45 s of the 60 s `maxDuration` the remaining orgs are deferred to the next run. Response: `{orgs, settled, counts}`. It is idempotent, so it can safely be called by hand.

~~**Decision for Brian:** add-ons free until the first renewal~~ **decided 2026-10-27 (patch 0004):** prorated charge at add time, above.

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

## 12. Text-pack clawback on refund / dispute (migration `0012_text_pack_clawback`)

The webhook also handles `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed`. For each one it fetches the charge **before** the transaction (`stripeChargeContextFetcher`: `charges.retrieve`, `invoicePayments.list` by the charge's payment intent → paid invoice ids, `disputes.list({charge})`), then inside the transaction (event-id dedupe as for every event) finds the paid `text_pack` whose `stripe_invoice_id` is one of those invoices. A charge that isn't for a pack (subscription invoices, anything else) → `ignored`.

The pack's revocation is computed **absolutely** from Stripe's current state of the charge (`packRevocation` in `text-pack-rules.ts`), so repeated and out-of-order deliveries give the same answer:

| Charge state | Texts revoked |
| --- | --- |
| fully refunded | everything not yet used |
| partially refunded | `floor(total × amount_refunded / amount)`, cumulative across refunds |
| dispute open (`needs_response`, `under_review`) | everything not yet used |
| dispute **lost** | stays revoked |
| dispute **won** | restored (back to the refund-only figure), **unless the pack has expired** (then nothing changes) |
| inquiry (`warning_*`) / `prevented` | nothing (no funds withdrawn) — decision for Brian |

- Texts already used are never taken back and never charged; a revocation is capped at `total − used`. When the refunded/disputed share exceeds what was left, the excess (`texts_used_over_revocation`) is logged (`console.warn "[billing] text pack clawback: texts already used"` + a row in `text_pack_revocation`).
- The plan's monthly allowance is never touched; nothing is auto-charged. `consumeTexts` / `activePaidPacks` treat `remaining = total − used − revoked`.
- Locking: the org row, then the pack row (`FOR UPDATE`), same order as `consumeTexts`, so a send and a refund can't race.
- A revoked pack still counts toward the per-window pack cap (decision for Brian).
- A Stripe 404 (`resource_missing`) while looking up the charge or its invoice payments is logged (`console.warn`) and the event is acknowledged as `ignored` (200), so Stripe doesn't retry a lookup that can never succeed. Any other Stripe/network error still returns 500 (Stripe retries).

**Migration `0012_text_pack_clawback` (add-only):** `text_pack` gains `texts_revoked int not null default 0`, `revoked_at`, `revoked_reason`, `stripe_charge_id`, `amount_refunded int not null default 0`, `dispute_status`. New table `text_pack_revocation` (one row per Stripe event that changed a pack; unique on `stripe_event_id`). Nothing is altered or dropped; existing packs read as "nothing revoked".

**Go-live (Ryan, after Brian's sign-off):** add `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` to the **live** webhook endpoint. Until then live refunds/disputes simply aren't delivered (no harm; nothing is revoked).

## 13. In-app plan changes and cancel (`/api/billing/plan`, `/api/billing/cancel`)

Owner/Admin only (staff 403), demo orgs (`is_demo`) 403 `demo_org`, 404 unless `BILLING_ENABLED=true`. Plans: Starter / Pro / Business, monthly and annual. UI: the billing card on the Administration page (`src/components/billing/billing-card.tsx`).

- **`UPGRADE_POLICY = "prorate_now"` (Brian, 2026-10-30):** an upgrade (higher tier, or same tier monthly → annual) is applied now with `proration_behavior: "always_invoice"` + `payment_behavior: "pending_if_incomplete"`, same as seats/locations. A failed charge → 402, the proration invoice is voided and **nothing changes**. `"at_renewal"` is kept and tested (schedules upgrades like downgrades) but is not the default.
- **Downgrades** (lower tier) and **annual → monthly** are written as the next phase of a subscription schedule starting at the renewal; no charge, no credit.
- **Add-ons switch interval with the plan** (seat/location/branding monthly ↔ annual price). If an add-on has no price for the target interval, the change is refused (409, contact support).
- **Trials:** never charged; the trial continues (`trial_end` kept, proration none). Upgrades apply immediately (free); downgrades take effect at the trial end.
- Pending add-on decreases already in the schedule are carried over (mapped to the new plan/interval). Choosing the current plan again cancels a pending plan change and keeps pending add-on changes.
- **Read paths never create customers:** `GET /api/billing/plan` (loaded by the billing card on every Administration page view) returns `subscription: null` for `is_demo` orgs without any Stripe call or DB write, and otherwise only *looks up* an existing `billing_customer` row (`findCustomerId`); no row → `subscription: null`, no Stripe call. `POST /api/billing/plan` and `/api/billing/cancel` look up the same way (no row → 409). The card shows the portal button ("Card & invoices") only when there is a subscription and the org is not a demo org.
- **Locking:** the same per-org advisory lock as add-ons (`withAddonChangeLock`); a concurrent billing change → **409 `change_in_progress`**.
- **Refused → support** (`BILLING_SUPPORT_EMAIL` = `billing@flowopsagent.ai`, defined once in `src/lib/billing/support.ts` and imported by the billing card and the plan / cancel routes; separate from the general site contact address): schedules with more than one future phase, discounts / extra invoice items in a phase, unmappable items. A pending cancellation → 409 `cancel_pending` (resume first).
- **Cancel (`POST /api/billing/cancel {cancel}`)** is schedule-safe: without a schedule it sets `cancel_at_period_end`; with one it trims the schedule to the current phase with `end_behavior: "cancel"` and saves the next phase in schedule metadata, so **resume** restores the pending change.

**Customer Portal:** stays as is with **plan switching OFF** (payment method, invoices). It can be re-enabled only for plan-only subscriptions (no add-on items, no schedule) — the portal can't switch add-on intervals or keep a schedule.

**Support stopgap:** whatever the endpoint refuses (above) is handled by support by email.

