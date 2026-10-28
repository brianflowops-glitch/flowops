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
 * Subscription Checkout. The card is always collected (also for a trial: it pays the first invoice when the trial
 * ends and is the card on file for text packs); if it is somehow missing when the trial ends the subscription is
 * cancelled rather than left running unpaid.
 */
export function checkoutSessionParams({ orgId, customer, priceId, origin, trialDays = 0 }: CheckoutParamsInput): Stripe.Checkout.SessionCreateParams {
  const trial = trialDays > 0;
  return {
    mode: "subscription",
    customer,
    client_reference_id: orgId,
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_collection: "always",
    subscription_data: {
      metadata: { organizationId: orgId },
      ...(trial ? { trial_period_days: trialDays, trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } } } : {}),
    },
    metadata: { organizationId: orgId },
    success_url: `${origin}/admin?billing=success`,
    cancel_url: `${origin}/admin?billing=cancelled`,
  };
}
