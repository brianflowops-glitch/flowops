/**
 * Billing configuration (docs/BILLING.md). Everything comes from env so no plan
 * names or prices are hardcoded: pricing is a founder decision.
 *
 *   BILLING_ENABLED=true          feature flag (off by default → every billing route 404s)
 *   STRIPE_SECRET_KEY=sk_test_…   test-mode key; sk_live_/rk_live_ keys are refused unless STRIPE_ALLOW_LIVE=true
 *   STRIPE_WEBHOOK_SECRET=whsec_… signing secret of the webhook endpoint (or of `stripe listen`)
 *   STRIPE_PRICE_<PLAN>=price_…         monthly price of a plan, e.g. STRIPE_PRICE_STARTER; <PLAN> lowercased is the plan key
 *   STRIPE_PRICE_<PLAN>_ANNUAL=price_…  yearly price of the same plan (key stays <plan>, interval year)
 *   STRIPE_ADDON_PRICE_<KEY>=price_…         monthly recurring add-on: SEAT / LOCATION / BRANDING.
 *                                            For TEXTS_<n> (a text pack) it is the ONE-TIME price of the pack.
 *   STRIPE_ADDON_PRICE_<KEY>_ANNUAL=price_…  yearly recurring add-on price (used on annual subscriptions)
 *   STRIPE_ADDON_LEGACY_PRICE_TEXTS_<n>=price_…  optional: an old RECURRING text-bundle price still on some subscription
 *   TRIAL_DAYS=14                 free trial for an org's first subscription (0 disables)
 *   PLAN_LIMITS_<PLAN>=…          per-plan limits override (see entitlements.ts); defaults exist for starter, pro and business
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

export type BillingInterval = "month" | "year";
export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];
type Env = Record<string, string | undefined>;

export interface PlanConfig {
  /** Plan key, e.g. "starter" (from STRIPE_PRICE_STARTER / STRIPE_PRICE_STARTER_ANNUAL). */
  key: string;
  /** Stripe price id (price_…). Amount and currency live in Stripe, not here. */
  priceId: string;
  /** "month" for STRIPE_PRICE_<PLAN>, "year" for STRIPE_PRICE_<PLAN>_ANNUAL. */
  interval: BillingInterval;
}

const PRICE_ENV = /^STRIPE_PRICE_([A-Z0-9]+(?:_[A-Z0-9]+)*?)(_ANNUAL)?$/;

/** Plans configured through STRIPE_PRICE_* env vars (one entry per plan and interval). Empty until pricing is configured. */
export function plans(env: Env = process.env): PlanConfig[] {
  const out: PlanConfig[] = [];
  for (const [name, value] of Object.entries(env)) {
    const m = PRICE_ENV.exec(name);
    if (m && value) out.push({ key: m[1].toLowerCase(), priceId: value, interval: m[2] ? "year" : "month" });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.interval.localeCompare(b.interval));
}

/** The plan's price for an interval (default monthly). */
export function planByKey(key: string, env?: Env, interval: BillingInterval = "month"): PlanConfig | undefined {
  return plans(env).find((p) => p.key === key.toLowerCase() && p.interval === interval);
}

/** Any price (monthly or annual) of a plan → the plan (key + interval). */
export function planByPriceId(priceId: string | null | undefined, env?: Env): PlanConfig | undefined {
  if (!priceId) return undefined;
  return plans(env).find((p) => p.priceId === priceId);
}

/** Free-trial length in days for an org's first subscription: TRIAL_DAYS (default 14, 0 disables, invalid → 14, max 730). */
export function trialDays(env: Env = process.env): number {
  const raw = env.TRIAL_DAYS?.trim();
  if (raw === undefined || raw === "") return 14;
  return /^\d{1,4}$/.test(raw) && Number(raw) <= 730 ? Number(raw) : 14;
}

/** Text-pack keys: `texts_<n>` = a one-time pack of n texts (not a recurring add-on). */
export const TEXT_PACK_KEY = /^texts_(\d{1,7})$/;
export const isTextPackKey = (key: string) => {
  const m = TEXT_PACK_KEY.exec(key.toLowerCase());
  return Boolean(m && Number(m[1]) > 0);
};
export const textPackSize = (key: string): number | null => {
  const m = TEXT_PACK_KEY.exec(key.toLowerCase());
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
};

export interface AddonConfig {
  /** Add-on key, e.g. "seat", "location", "branding", "texts_1000". */
  key: string;
  /** Stripe price id (price_…). Amount lives in Stripe, not here. */
  priceId: string;
  /** Recurring interval of the price, or "one_time" for a text pack. */
  interval: BillingInterval | "one_time";
  /** True for a recurring text bundle from before text packs: still counted if a subscription has it, never sold. */
  legacy?: boolean;
}

const ADDON_PRICE_ENV = /^STRIPE_ADDON_PRICE_([A-Z0-9]+(?:_[A-Z0-9]+)*?)(_ANNUAL)?$/;
const ADDON_LEGACY_ENV = /^STRIPE_ADDON_LEGACY_PRICE_(TEXTS_[0-9]+)$/;

/**
 * Add-ons configured through STRIPE_ADDON_PRICE_* env vars (distinct prefix from STRIPE_PRICE_*, so never mistaken for a plan).
 * A key can have a monthly and an annual price; `texts_<n>` keys are one-time packs (an `_ANNUAL` variant of one is ignored).
 */
export function addons(env: Env = process.env): AddonConfig[] {
  const out: AddonConfig[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const m = ADDON_PRICE_ENV.exec(name);
    if (m) {
      const key = m[1].toLowerCase();
      if (isTextPackKey(key)) {
        if (!m[2]) out.push({ key, priceId: value, interval: "one_time" });
      } else out.push({ key, priceId: value, interval: m[2] ? "year" : "month" });
      continue;
    }
    const l = ADDON_LEGACY_ENV.exec(name);
    if (l) out.push({ key: l[1].toLowerCase(), priceId: value, interval: "month", legacy: true });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.interval.localeCompare(b.interval));
}

/** Sellable recurring add-ons (no text packs, no legacy prices). */
export const recurringAddons = (env?: Env) => addons(env).filter((a) => a.interval !== "one_time" && !a.legacy);

/** The add-on's recurring price for an interval, if configured. */
export function addonPrice(key: string, interval: BillingInterval, env?: Env): AddonConfig | undefined {
  return recurringAddons(env).find((a) => a.key === key.toLowerCase() && a.interval === interval);
}

/** True when the key is a configured recurring add-on in any interval. */
export function addonByKey(key: string, env?: Env): AddonConfig | undefined {
  const k = key.toLowerCase();
  const all = recurringAddons(env).filter((a) => a.key === k);
  return all.find((a) => a.interval === "month") ?? all[0];
}

/** The one-time price of a text pack (STRIPE_ADDON_PRICE_TEXTS_<n>). */
export function textPackByKey(key: string, env?: Env): AddonConfig | undefined {
  return addons(env).find((a) => a.key === key.toLowerCase() && a.interval === "one_time");
}

/** Any configured price (recurring in either interval, or legacy recurring) → its add-on. One-time pack prices never match: they are not subscription items. */
export function addonByPriceId(priceId: string | null | undefined, env?: Env): AddonConfig | undefined {
  if (!priceId) return undefined;
  return addons(env).find((a) => a.priceId === priceId && a.interval !== "one_time");
}
