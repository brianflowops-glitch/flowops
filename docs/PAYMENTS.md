# Payments at booking (deposits / full payment)

Optional, per service. **Ships dark:** nothing changes unless `BOOKING_PAYMENTS_ENABLED=true`. With the flag off, the public booking page, the booking API, availability and the settings page behave exactly as before (the new code paths return early, no hold table queries, the new routes 404, and the Payments card does not render).

## Model

- **Per service** (`service.payment_mode`, migration `0014_booking_payments`, additive): `none` (default) · `fixed` (deposit `deposit_cents`) · `percent` (`deposit_percent` % of `price_cents`) · `full` (`price_cents`). USD only; minimum $0.50 (Stripe), maximum $10,000 (typo guard). A deposit never exceeds the price. Rules: `src/lib/payments/rules.ts` (`paymentDue`, `servicePaymentError`).
- **Stripe Connect, direct charges.** Each business connects ONE Stripe account (Accounts v2: merchant configuration, `dashboard: "full"`, Stripe collects fees and covers losses, i.e. a Standard-style account). Customers pay the business directly: the business is the merchant of record, the money settles to its account, and refunds and disputes are handled in its own Stripe dashboard. **FlowOps takes no application fee.** Onboarding is Stripe-hosted (Account Links), from Settings → Payments at booking (Owner only; Admin can view the status). Table `stripe_connect_account` caches `charges_enabled` (card_payments capability active), refreshed from Stripe each time the settings page loads.
- If a service asks for payment but the business has no ready account, **bookings are taken without payment** (as today), and the settings card says so.

## Flow

1. Public `POST /api/public/<slug>/book`, payment due → under the org's advisory lock the request is dry-run through the same booking engine (hours, conflicts with bookings **and other holds**). If it would succeed, a `booking_hold` row (`pending`) is written in the same transaction, so no one can take the slot in between.
2. A Checkout Session (`mode: payment`, `price_data`, `customer_email`, no `payment_method_types`) is created **on the connected account** (`stripeAccount`), expiring in 31 min (Stripe minimum is 30). The hold lasts 2 min longer. Response: `{ ok: true, outcome: "payment_required", checkoutUrl, hold, payment }`; the page redirects to Stripe. Max 3 open holds per customer email per business.
3. While `pending` and unexpired, the hold blocks the slot for public availability, public bookings **and dashboard/assistant bookings** (`loadWorkingSet` / `availability`).
4. **Paid** → the Connect webhook (`checkout.session.completed` with `payment_status: paid`, or `checkout.session.async_payment_succeeded`) calls `confirmPaidHold`: the normal pipeline `create` runs (hold excluded from the conflict check; hold re-checked `FOR UPDATE` under the org lock and marked `paid` with the booking id **in the booking's own transaction**). The customer gets the normal confirmation (email/SMS/calendar). Re-deliveries are no-ops.
   The booking page also polls `GET /api/public/<slug>/holds/<id>` after returning from Checkout; that asks Stripe for the session and confirms a paid one through the same idempotent path, so a slow or missing webhook never strands a paying customer.
5. **Paid but can't be booked** (the hold lapsed and the slot was taken, or the time is now in the past) → hold `conflict` and an automatic **full refund** on the connected account (idempotency key `flowops-hold-refund-<hold>`; at most once). A failed refund is logged and noted on the hold for a manual refund.
6. **Not paid**: `checkout.session.expired` / `async_payment_failed` → hold `expired`. A customer who cancels in Checkout lands on `?payment=cancelled`, and the page calls `POST …/holds/<id>/release`, which expires the Checkout session first and only then frees the slot (never if the session is already paid).

Webhook events are accepted only if the hold's stored connected account equals `event.account`.

## Setup (Brian, dashboard; nothing is created by code until a business clicks "Set up payments")

1. Stripe → **Connect → Get started** on the platform account (live US `acct_1UUvE26Gas8TV2FU`; do the sandbox first). Platform profile: SaaS platform; the business owns the pricing; Stripe-hosted onboarding; connected accounts use the full Stripe Dashboard and Stripe handles fees and losses. Set branding (name, icon, colour) for the onboarding page.
2. **Webhook endpoint for connected accounts:** `https://<origin>/api/webhooks/stripe-connect`, "Events on Connected accounts", events `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. Its secret → `STRIPE_CONNECT_WEBHOOK_SECRET`.
3. Env: `BOOKING_PAYMENTS_ENABLED=true` (per environment; staging first), plus the existing `STRIPE_SECRET_KEY` (live keys still need `STRIPE_ALLOW_LIVE=true`).
4. Run migration `0014_booking_payments` (`npm run db:migrate`) **before** deploying this code: the service queries read the new columns even with the flag off.

## Tests

`tests/booking-payments.test.ts`: rules; flag off = unchanged (books immediately, no Stripe, no `payment` field, new routes 404); flag on with `none` or no ready account = unchanged; hold + Checkout on the connected account (amount, no `payment_method_types`, no application fee, ≥30 min expiry); held slot hidden and blocked for public and dashboard bookings; webhook confirm once; duplicate delivery; status-poll confirm without the webhook; expiry and customer release free the slot; release never frees a paid session; paid-after-conflict → one refund on the connected account; events from another account ignored; Checkout create failure frees the slot; admin payments guards (staff 403, admin read-only, owner onboarding creates the account once); service PATCH validation.

## Not covered / follow-ups

- Real Stripe (sandbox) end-to-end: onboarding a test connected account and paying with a test card. Do this before enabling.
- Account status changes are read on demand (settings page) rather than via v2 account events: if Stripe restricts an account, bookings keep requesting payment until the owner next opens Settings, and Checkout creation may then fail with a 502 (the slot is freed).
- Refunds for customer cancellations or reschedules are not automated; the business refunds in its Stripe dashboard. Rescheduling a paid booking keeps the payment.
- The deposit is not shown on the dashboard booking record (the hold row has the amount and the PaymentIntent id).
