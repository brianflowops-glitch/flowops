/**
 * No-card free trial (Brian, 2026-10-31): pure rules for the "add a card before your trial ends" prompts.
 * No Stripe client, no database, so they are unit-tested offline (tests/billing-trial-no-card.test.ts).
 */
import type Stripe from "stripe";
import { BILLING_SUPPORT_EMAIL } from "./support";

const DAY_MS = 86_400_000;

export interface TrialBanner {
  /** ISO time the trial ends (Stripe `trial_end`). */
  trialEnd: string;
  /** Whole days left, rounded up (ends in 3h → 1). 0 once it has ended. */
  daysLeft: number;
  /** A card (or other default payment method) is on the subscription or the customer. */
  hasPaymentMethod: boolean;
  /** "add_card" = no card yet (prominent prompt); "info" = card on file (quiet note). */
  tone: "add_card" | "info";
  message: string;
}

export const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.id);

/** The payment method Stripe will charge when the trial ends: the subscription's own, else the customer's default. */
export function defaultPaymentMethod(
  sub: Pick<Stripe.Subscription, "default_payment_method" | "default_source">,
  customer: Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  const own = idOf(sub.default_payment_method as string | { id: string } | null) ?? idOf(sub.default_source as string | { id: string } | null);
  if (own) return own;
  if (!customer || customer.deleted) return null;
  return idOf(customer.invoice_settings?.default_payment_method as string | { id: string } | null | undefined) ?? idOf(customer.default_source as string | { id: string } | null | undefined);
}

export function daysLeft(trialEnd: Date, now: Date = new Date()): number {
  const ms = trialEnd.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Banner shown in the dashboard while the org is trialing. null when not trialing or the trial end is unknown. */
export function trialBanner(input: { status: string; trialEnd: number | null | undefined; hasPaymentMethod: boolean; now?: Date }): TrialBanner | null {
  if (input.status !== "trialing" || !input.trialEnd) return null;
  const end = new Date(input.trialEnd * 1000);
  const left = daysLeft(end, input.now);
  const when = left === 0 ? "today" : left === 1 ? "in 1 day" : `in ${left} days`;
  if (input.hasPaymentMethod)
    return { trialEnd: end.toISOString(), daysLeft: left, hasPaymentMethod: true, tone: "info", message: `Free trial ends ${when} (${fmtDay(end)}). Your card on file is charged then; nothing before.` };
  return {
    trialEnd: end.toISOString(),
    daysLeft: left,
    hasPaymentMethod: false,
    tone: "add_card",
    message: `Free trial: ${left} ${left === 1 ? "day" : "days"} left. Add a card before ${fmtDay(end)} to keep FlowOps running. Nothing is charged until the trial ends, and without a card the plan simply ends (your data is kept).`,
  };
}

/** Email sent on Stripe's `customer.subscription.trial_will_end` (3 days before the end) when there is no card yet. */
export function trialEndingEmail(input: { orgName: string; trialEnd: number; appUrl: string }) {
  const end = new Date(input.trialEnd * 1000);
  return {
    subject: `Your FlowOps trial ends ${fmtDay(end)}: add a card to keep going`,
    text:
      `Hi,\n\nThe free trial for ${input.orgName} on FlowOps ends on ${fmtDay(end)}.\n\n` +
      `There's no card on file yet. To keep your booking page, reminders and team running, add one here (Administration → Billing → Card & invoices):\n${input.appUrl.replace(/\/$/, "")}/admin#billing\n\n` +
      `Nothing is charged before the trial ends. If you don't add a card, the plan ends on that date and nothing is charged; your bookings and settings are kept.\n\n` +
      `Questions: ${BILLING_SUPPORT_EMAIL}\n\n— FlowOps`,
  };
}
