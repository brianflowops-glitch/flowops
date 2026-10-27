/**
 * Text packs: pure rules (no database, no Stripe), usable offline and from UI code. docs/BILLING.md §11.
 * A pack is a ONE-TIME purchase (`texts_<n>` = n texts) valid for one monthly text window; see `textPackWindow`.
 */
import { addonMaxQuantity } from "./entitlements";
import { isTextPackKey, textPackSize } from "./config";

type Env = Record<string, string | undefined>;

/** `d` plus `n` calendar months in UTC, keeping the day of month where it exists (31st → last day of a short month). */
export function addMonthsUTC(d: Date, n: number): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return out;
}

/**
 * The text window a pack bought at `now` is valid for, inside the subscription's current period.
 * Monthly plan (and a trial): the whole current period. Annual plan: the current MONTH of the year
 * (anchored on the period start), so "per billing period" means per month there too and the cap does
 * not become 10 packs for a whole year.
 */
export function textPackWindow(periodStart: Date, periodEnd: Date, now: Date): { start: Date; end: Date } {
  let k = 0;
  while (addMonthsUTC(periodStart, k + 1) <= now && addMonthsUTC(periodStart, k + 1) < periodEnd) k++;
  const start = addMonthsUTC(periodStart, k);
  const next = addMonthsUTC(periodStart, k + 1);
  return { start, end: next < periodEnd ? next : periodEnd };
}

export type TextPackValidation = { ok: true; texts: number; max: number } | { ok: false; status: 400; error: string };

/** Request checks that need no Stripe or database: pack key, whole quantity ≥ 1, at most the per-period cap. */
export function validateTextPackRequest(pack: string, quantity: number, env: Env = process.env): TextPackValidation {
  const key = pack.toLowerCase();
  const texts = isTextPackKey(key) ? textPackSize(key) : null;
  if (!texts) return { ok: false, status: 400, error: "Unknown text pack" };
  const max = addonMaxQuantity(key, env);
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, status: 400, error: `Quantity must be a whole number from 1 to ${max}` };
  if (quantity > max) return { ok: false, status: 400, error: `Quantity ${quantity} is above the maximum of ${max} "${key}" packs per billing period. Choose ${max} or fewer.` };
  return { ok: true, texts, max };
}

/** A `pending` reservation older than this no longer counts toward the cap (the purchase crashed before it was settled). */
export const PENDING_RESERVATION_MS = 15 * 60 * 1000;
