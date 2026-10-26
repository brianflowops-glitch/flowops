/**
 * Billing configuration (docs/BILLING.md). Everything comes from env so no plan
 * names or prices are hardcoded: pricing is a founder decision.
 *
 *   BILLING_ENABLED=true          feature flag (off by default → every billing route 404s)
 *   STRIPE_SECRET_KEY=sk_test_…   test-mode key; sk_live_/rk_live_ keys are refused unless STRIPE_ALLOW_LIVE=true
 *   STRIPE_WEBHOOK_SECRET=whsec_… signing secret of the webhook endpoint (or of `stripe listen`)
 *   STRIPE_PRICE_<PLAN>=price_…   one per plan, e.g. STRIPE_PRICE_STARTER; <PLAN> lowercased is the plan key
 */

export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "true";
}

export function isLiveKey(key: string): boolean {
  return /^(sk|rk)_live_/.test(key);
}

/** Returns the Stripe secret key, or null when missing / live without explicit opt-in. */
export function stripeSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (isLiveKey(key) && process.env.STRIPE_ALLOW_LIVE !== "true") return null;
  return key;
}

export function webhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

/** True when the flag is on and the keys needed to talk to Stripe are present. */
export function billingConfigured(): boolean {
  return billingEnabled() && Boolean(stripeSecretKey());
}

export interface PlanConfig {
  /** Plan key, e.g. "starter" (from STRIPE_PRICE_STARTER). */
  key: string;
  /** Stripe price id (price_…). Amount, interval and currency live in Stripe, not here. */
  priceId: string;
}

const PRICE_ENV = /^STRIPE_PRICE_([A-Z0-9_]+)$/;

/** Plans configured through STRIPE_PRICE_* env vars. Empty until the founder approves pricing. */
export function plans(env: Record<string, string | undefined> = process.env): PlanConfig[] {
  const out: PlanConfig[] = [];
  for (const [name, value] of Object.entries(env)) {
    const m = PRICE_ENV.exec(name);
    if (m && value) out.push({ key: m[1].toLowerCase(), priceId: value });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function planByKey(key: string, env?: Record<string, string | undefined>): PlanConfig | undefined {
  return plans(env).find((p) => p.key === key.toLowerCase());
}

export function planByPriceId(priceId: string | null | undefined, env?: Record<string, string | undefined>): PlanConfig | undefined {
  if (!priceId) return undefined;
  return plans(env).find((p) => p.priceId === priceId);
}
