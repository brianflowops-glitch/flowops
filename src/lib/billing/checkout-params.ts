/** Checkout Session parameters (pure: no Stripe client, no database), unit-tested offline. */
import type Stripe from "stripe";

export interface CheckoutParamsInput {
  orgId: string;
  customer: string;
  priceId: string;
  origin: string;
  /** Free-trial days for this org's first subscription; 0 / undefined = no trial. */
  trialDays?: number;
}

/**
 * Subscription Checkout.
 * - Free trial (Brian, 2026-10-31): NO card required. Checkout only asks for a payment method when one is needed
 *   (`payment_method_collection: "if_required"`), so a trial starts without one. The app then asks the Owner/Admin to
 *   add a card before the trial ends (dashboard banner + trial_will_end email). If there is still no card when the
 *   trial ends, Stripe CANCELS the subscription (`missing_payment_method: "cancel"`): nobody is ever charged without a
 *   card, and the org lands on the "Your plan has ended, choose a plan" lock screen (data untouched).
 * - No trial (an org that already had one): the card is always collected, as before.
 */
export function checkoutSessionParams({ orgId, customer, priceId, origin, trialDays = 0 }: CheckoutParamsInput): Stripe.Checkout.SessionCreateParams {
  const trial = trialDays > 0;
  return {
    mode: "subscription",
    customer,
    client_reference_id: orgId,
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_collection: trial ? "if_required" : "always",
    subscription_data: {
      metadata: { organizationId: orgId },
      ...(trial ? { trial_period_days: trialDays, trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } } } : {}),
    },
    metadata: { organizationId: orgId },
    success_url: `${origin}/admin?billing=success`,
    cancel_url: `${origin}/admin?billing=cancelled`,
  };
}
