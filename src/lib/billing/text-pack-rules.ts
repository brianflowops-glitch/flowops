/**
 * Text packs: pure rules (no database, no Stripe), usable offline and from UI code. docs/BILLING.md §11.
 * A pack is a ONE-TIME purchase (`texts_<n>` = n texts) bought in one monthly text window (see `textPackWindow`)
 * and usable in that window AND the next one, then it expires (rollover, Brian 2026-10-27; `textPackExpiry`).
 * Consumption order: the plan's monthly allowance first, then packs, soonest-expiring first (`splitTextUsage`,
 * `allocatePackTexts`).
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

/**
 * When a pack bought at `now` expires: the end of the text window AFTER its purchase window (one extra billing
 * period of rollover; on an annual plan one extra MONTH, the same window the cap uses).
 *   Monthly plan: the end of the next billing period (anchored on the period start, like Stripe's renewals).
 *   Annual plan:  the end of the next month of the year (the 12th month rolls into the first month of the next year).
 *   Trial (a period that is not a whole month): one month after the trial ends, i.e. the first paid month.
 * Fixed at purchase; a later plan or anchor change does not move it.
 */
export function textPackExpiry(periodStart: Date, periodEnd: Date, now: Date): Date {
  const win = textPackWindow(periodStart, periodEnd, now);
  let k = 0;
  while (addMonthsUTC(periodStart, k).getTime() < win.start.getTime()) k++;
  const fullMonth = addMonthsUTC(periodStart, k + 1).getTime() === win.end.getTime();
  return fullMonth ? addMonthsUTC(periodStart, k + 2) : addMonthsUTC(win.end, 1);
}

/** n new texts in a window where `usedBefore` texts were already sent: how many come from the plan allowance, how many must come from packs. */
export function splitTextUsage(allowance: number, usedBefore: number, n: number): { fromPlan: number; fromPacks: number } {
  const left = Math.max(0, allowance - Math.max(0, usedBefore));
  const fromPlan = Math.min(Math.max(0, n), left);
  return { fromPlan, fromPacks: Math.max(0, n) - fromPlan };
}

export interface UsablePack {
  id: string;
  /** Texts still in the pack. */
  remaining: number;
  expiresAt: Date;
  createdAt: Date;
}

/** Draw `n` texts from packs, soonest-expiring first (ties: oldest purchase first). `shortfall` = what no pack could cover. */
export function allocatePackTexts(packs: readonly UsablePack[], n: number): { draws: { id: string; texts: number }[]; shortfall: number } {
  const order = [...packs].filter((p) => p.remaining > 0).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  let left = Math.max(0, n);
  const draws: { id: string; texts: number }[] = [];
  for (const p of order) {
    if (left === 0) break;
    const t = Math.min(left, p.remaining);
    draws.push({ id: p.id, texts: t });
    left -= t;
  }
  return { draws, shortfall: left };
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

// ───────────────────────── clawback (0012): refunds and disputes of a pack's charge ─────────────────────────

/**
 * Where the pack charge's dispute stands. `inquiry` = a warning_* (retrieval / inquiry, no funds withdrawn) or a
 * `prevented` one: no revocation. `open` = needs_response / under_review. `won` restores, `lost` stays revoked.
 */
export type PackDisputeState = "none" | "inquiry" | "open" | "won" | "lost";

export function packDisputeState(statuses: readonly (string | null | undefined)[]): PackDisputeState {
  const s = statuses.filter(Boolean) as string[];
  if (s.includes("lost")) return "lost";
  if (s.some((x) => x === "needs_response" || x === "under_review")) return "open";
  if (s.includes("won")) return "won";
  return s.length ? "inquiry" : "none";
}

export interface PackRevocationInput {
  /** texts_per_pack × quantity. */
  total: number;
  used: number;
  revokedBefore: number;
  /** The charge's amount and CUMULATIVE amount_refunded (Stripe's current state, so re-processing is idempotent). */
  chargeAmount: number;
  amountRefunded: number;
  /** charge.refunded: fully refunded. */
  fullyRefunded: boolean;
  dispute: PackDisputeState;
  /** The pack is past its expiry: revoked texts are not restored any more. */
  expired: boolean;
}

export interface PackRevocation {
  /** New absolute texts_revoked. */
  revoked: number;
  /** What the refund/dispute asks to take back before the "already used" cap. */
  target: number;
  /** Texts that would have been revoked but were already used (logged for Brian; never charged). */
  usedOverRevocation: number;
  reason: "refund" | "partial_refund" | "dispute" | "dispute_lost" | "restored_dispute_won" | null;
}

/**
 * How many of a pack's texts are revoked, computed ABSOLUTELY from Stripe's current state (docs/BILLING.md §11):
 *   full refund, or a dispute opened / lost → every remaining text;
 *   partial refund(s)                       → floor(total × amount_refunded / amount), cumulative;
 *   never more than total − used (texts already sent are not taken back, only logged);
 *   a won dispute restores down to what the refunds alone revoke, unless the pack has expired;
 *   otherwise the result never goes below what is already revoked.
 */
export function packRevocation(p: PackRevocationInput): PackRevocation {
  const total = Math.max(0, p.total);
  const used = Math.min(total, Math.max(0, p.used));
  const fraction = p.chargeAmount > 0 ? Math.min(1, Math.max(0, p.amountRefunded) / p.chargeAmount) : p.amountRefunded > 0 ? 1 : 0;
  const refundTarget = p.fullyRefunded ? total : Math.floor(total * fraction);
  const disputeTarget = p.dispute === "open" || p.dispute === "lost" ? total : 0;
  const target = Math.max(refundTarget, disputeTarget);
  const capped = Math.min(target, total - used);
  // Revoking more is always applied. Giving texts back (a won dispute) only while the pack is still usable.
  const revoked = capped >= p.revokedBefore || p.expired ? Math.max(capped, p.revokedBefore) : capped;
  const usedOverRevocation = Math.max(0, target - (total - used));
  let reason: PackRevocation["reason"] = null; // null = keep the stored reason
  if (p.dispute === "lost") reason = "dispute_lost";
  else if (p.dispute === "open") reason = "dispute";
  else if (refundTarget > 0) reason = refundTarget >= total ? "refund" : "partial_refund";
  else if (p.revokedBefore > 0 && revoked === 0) reason = "restored_dispute_won";
  return { revoked, target, usedOverRevocation, reason };
}
