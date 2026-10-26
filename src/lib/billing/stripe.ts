import "server-only";
import Stripe from "stripe";
import { stripeSecretKey } from "./config";

let _stripe: Stripe | null = null;

/** Lazily-created Stripe client (so `next build` never needs a key). Throws when billing keys are not configured. */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = stripeSecretKey();
  if (!key) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing, or a live key without STRIPE_ALLOW_LIVE=true)");
  _stripe = new Stripe(key, { appInfo: { name: "FlowOps" } });
  return _stripe;
}
