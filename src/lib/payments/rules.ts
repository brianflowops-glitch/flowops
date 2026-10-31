/**
 * Payments at booking: pure rules (no I/O), shared by the API, the admin UI and tests.
 *
 * Off unless BOOKING_PAYMENTS_ENABLED=true (ships dark). Per service, `paymentMode`:
 *   none    → the booking flow is exactly as before (default for every service)
 *   fixed   → a fixed deposit (`depositCents`) is paid in Checkout before the booking is confirmed
 *   percent → `depositPercent`% of `priceCents`
 *   full    → the full `priceCents`
 * The money is a direct charge on the business's Stripe Connect account; FlowOps takes no fee. USD only for now.
 */
import type { PaymentMode } from "@/lib/db/schema";

export const PAYMENT_CURRENCY = "usd";
/** Stripe's minimum charge in USD. */
export const MIN_CHARGE_CENTS = 50;
export const MAX_CHARGE_CENTS = 1_000_000; // $10,000 — a typo guard, not a Stripe limit
/** How long a slot is held while the customer pays. Stripe Checkout sessions can't expire sooner than 30 min. */
export const HOLD_MINUTES = 31;
/** Extra minutes the slot stays blocked after the Checkout session expires (late webhooks). */
export const HOLD_GRACE_MINUTES = 2;

export function bookingPaymentsEnabled() {
  return process.env.BOOKING_PAYMENTS_ENABLED === "true";
}

export interface ServicePaymentFields {
  paymentMode?: PaymentMode | null;
  priceCents?: number | null;
  depositCents?: number | null;
  depositPercent?: number | null;
}

export interface PaymentDue {
  amountCents: number;
  kind: "deposit" | "full";
  currency: typeof PAYMENT_CURRENCY;
}

/** What a customer pays at booking for this service, or null (nothing; book as usual). Never throws. */
export function paymentDue(s: ServicePaymentFields): PaymentDue | null {
  const mode = s.paymentMode ?? "none";
  let amount: number | null = null;
  let kind: PaymentDue["kind"] = "deposit";
  if (mode === "fixed") amount = s.depositCents ?? null;
  else if (mode === "percent") amount = s.priceCents != null && s.depositPercent != null ? Math.round((s.priceCents * s.depositPercent) / 100) : null;
  else if (mode === "full") {
    amount = s.priceCents ?? null;
    kind = "full";
  }
  if (amount == null || !Number.isInteger(amount) || amount < MIN_CHARGE_CENTS || amount > MAX_CHARGE_CENTS) return null;
  // A deposit can never be more than the price, when a price is set.
  if (kind === "deposit" && s.priceCents != null && amount > s.priceCents) amount = s.priceCents;
  if (mode === "percent" && s.depositPercent === 100) kind = "full";
  return { amountCents: amount, kind, currency: PAYMENT_CURRENCY };
}

/** Validation for the admin service form/API. Returns an error message, or null when the combination is valid. */
export function servicePaymentError(s: ServicePaymentFields): string | null {
  const mode = s.paymentMode ?? "none";
  const cents = (v: number | null | undefined) => v == null || (Number.isInteger(v) && v >= 0 && v <= MAX_CHARGE_CENTS);
  if (!cents(s.priceCents)) return "Price must be between $0 and $10,000";
  if (!cents(s.depositCents)) return "Deposit must be between $0 and $10,000";
  if (s.depositPercent != null && (!Number.isInteger(s.depositPercent) || s.depositPercent < 1 || s.depositPercent > 100)) return "Deposit percent must be 1–100";
  if (mode === "none") return null;
  if (mode === "fixed") {
    if (s.depositCents == null || s.depositCents < MIN_CHARGE_CENTS) return "A fixed deposit must be at least $0.50";
    if (s.priceCents != null && s.depositCents > s.priceCents) return "The deposit can't be more than the price";
    return null;
  }
  if (mode === "percent") {
    if (s.depositPercent == null) return "Enter the deposit percent (1–100)";
    if (s.priceCents == null) return "Set the service price to take a percent deposit";
    if (Math.round((s.priceCents * s.depositPercent) / 100) < MIN_CHARGE_CENTS) return "The deposit works out under $0.50; raise the percent or price";
    return null;
  }
  if (mode === "full") {
    if (s.priceCents == null || s.priceCents < MIN_CHARGE_CENTS) return "Set a price of at least $0.50 to take full payment";
    return null;
  }
  return "Unknown payment mode";
}

export function formatCents(cents: number, currency = PAYMENT_CURRENCY) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

/** Customer-facing line, e.g. "$25.00 deposit due at booking" / "$80.00 paid at booking". */
export function paymentLabel(p: PaymentDue) {
  return p.kind === "full" ? `${formatCents(p.amountCents)} paid at booking` : `${formatCents(p.amountCents)} deposit due at booking`;
}

export type HoldStatusView = "pending" | "paid" | "expired" | "conflict";
