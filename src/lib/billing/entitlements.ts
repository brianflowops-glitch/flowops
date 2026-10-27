/**
 * Plan limits + add-ons → what an organization is entitled to (docs/BILLING.md §11).
 * Pure: no database, no Stripe, no "server-only", so it is usable from UI code and offline tests.
 *
 * Prices are never here (they live in Stripe, referenced by STRIPE_PRICE_* / STRIPE_ADDON_PRICE_*).
 * What IS here is *what a unit of each add-on gives you* and the default plan limits. Both are
 * product definitions rather than prices, and the plan limits can be overridden per plan from env.
 */
import { addonByPriceId, planByPriceId, textPackSize } from "./config";

type Env = Record<string, string | undefined>;

export interface PlanLimits {
  seats: number;
  locations: number;
  /** Included text messages per month. */
  monthlyTexts: number;
  /** FlowOps branding removed from the public booking page. */
  brandingRemoved: boolean;
}

/** Brian's final pricing (2026-10-27). Override per plan with PLAN_LIMITS_<PLAN>. */
export const DEFAULT_PLAN_LIMITS: Readonly<Record<string, PlanLimits>> = {
  starter: { seats: 3, locations: 1, monthlyTexts: 500, brandingRemoved: false },
  pro: { seats: 10, locations: 1, monthlyTexts: 2000, brandingRemoved: true },
  business: { seats: 25, locations: 3, monthlyTexts: 5000, brandingRemoved: true },
};

/** What a plan item with no limits configured (new plan, unknown price) falls back to: the smallest known tier. */
export const FALLBACK_PLAN_LIMITS: PlanLimits = DEFAULT_PLAN_LIMITS.starter;

/** Nothing: used for orgs with no live subscription (they are locked anyway when billing is on). */
export const NO_LIMITS: PlanLimits = { seats: 0, locations: 0, monthlyTexts: 0, brandingRemoved: false };

const KEY_ALIASES: Record<string, keyof PlanLimits> = {
  seats: "seats",
  seat: "seats",
  locations: "locations",
  location: "locations",
  texts: "monthlyTexts",
  text: "monthlyTexts",
  sms: "monthlyTexts",
  monthlytexts: "monthlyTexts",
  branding: "brandingRemoved",
  brandingremoved: "brandingRemoved",
};

const int = (v: unknown): number | null => {
  const n = typeof v === "string" ? (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
};
const bool = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1"].includes(s)) return true;
    if (["false", "no", "0"].includes(s)) return false;
  }
  return null;
};

/**
 * Parses PLAN_LIMITS_<PLAN>: either `seats=3,locations=1,texts=500,branding=true` or JSON
 * (`{"seats":3,"locations":1,"texts":500,"branding":true}`). Missing fields keep `base`;
 * malformed values are ignored (never throws, never widens a limit by accident).
 */
export function parsePlanLimits(raw: string | undefined, base: PlanLimits): PlanLimits {
  const out: PlanLimits = { ...base };
  if (!raw?.trim()) return out;
  let pairs: [string, unknown][] = [];
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j)) pairs = Object.entries(j);
    } catch {
      return out;
    }
  } else {
    pairs = text
      .split(",")
      .map((p) => p.split("=").map((x) => x.trim()) as [string, string])
      .filter((p) => p.length === 2 && p[0]) as [string, unknown][];
  }
  for (const [k, v] of pairs) {
    const field = KEY_ALIASES[k.toLowerCase().replace(/[^a-z]/g, "")];
    if (!field) continue;
    if (field === "brandingRemoved") {
      const b = bool(v);
      if (b !== null) out.brandingRemoved = b;
    } else {
      const n = int(v);
      if (n !== null) out[field] = n;
    }
  }
  return out;
}

export interface ResolvedPlanLimits extends PlanLimits {
  /** "configured": PLAN_LIMITS_<PLAN> and/or a built-in default; "fallback": plan unknown → smallest tier. */
  source: "configured" | "fallback";
}

/** Limits for a plan key: built-in default (starter, pro) overlaid with PLAN_LIMITS_<PLAN>. Unknown plans → fallback tier. */
export function planLimits(planKey: string | null | undefined, env: Env = process.env): ResolvedPlanLimits {
  const key = planKey?.toLowerCase() ?? "";
  const override = key ? env[`PLAN_LIMITS_${key.toUpperCase()}`] : undefined;
  const base = DEFAULT_PLAN_LIMITS[key];
  if (!base && !override?.trim()) return { ...FALLBACK_PLAN_LIMITS, source: "fallback" };
  return { ...parsePlanLimits(override, base ?? FALLBACK_PLAN_LIMITS), source: "configured" };
}

/** What one unit of a RECURRING add-on adds. `texts_<n>` only matters for a legacy recurring text bundle still on a subscription (new text packs are one-time, see text-packs.ts). */
export type AddonEffect = Partial<Record<"seats" | "locations" | "monthlyTexts", number>> & { brandingRemoved?: true };

export function addonEffect(key: string): AddonEffect | null {
  const k = key.toLowerCase();
  if (k === "seat") return { seats: 1 };
  if (k === "location") return { locations: 1 };
  if (k === "branding") return { brandingRemoved: true };
  const t = /^texts_(\d{1,7})$/.exec(k);
  if (t && Number(t[1]) > 0) return { monthlyTexts: Number(t[1]) };
  return null; // unknown add-on keys have no effect (still billed, still mirrored)
}

/**
 * Maximum quantity of each add-on one subscription may hold (abuse guard: an Owner could otherwise set
 * `texts_1000` to 1,000, i.e. a million texts we pay Twilio for; for text packs the cap is per billing month). Product limits, overridable per add-on with
 * `STRIPE_ADDON_MAX_<KEY>` (e.g. `STRIPE_ADDON_MAX_TEXTS_1000=20`).
 */
export const DEFAULT_ADDON_MAX: Readonly<Record<string, number>> = { seat: 50, location: 10, texts_1000: 10, branding: 1 };
/** Any other add-on key (texts_5000, a new add-on …) gets this unless overridden. */
export const FALLBACK_ADDON_MAX = 10;
/** Hard ceiling for an override: the same bound `POST /api/billing/addons` has always had. */
export const ADDON_MAX_CEILING = 1000;

const warnedMax = new Set<string>();
/** Test hook: forget which invalid overrides were already warned about. */
export const resetAddonMaxWarnings = () => warnedMax.clear();

/**
 * The cap for one add-on key: `STRIPE_ADDON_MAX_<KEY>` when it is a positive whole number up to 1000,
 * else the built-in default. An invalid override (0, negative, fraction, text, > 1000) never raises or removes
 * the cap: it falls back to the default and warns once per distinct bad value.
 */
export function addonMaxQuantity(key: string, env: Env = process.env): number {
  const k = key.toLowerCase();
  const fallback = DEFAULT_ADDON_MAX[k] ?? FALLBACK_ADDON_MAX;
  const name = `STRIPE_ADDON_MAX_${k.toUpperCase()}`;
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  const n = /^\d{1,7}$/.test(text) ? Number(text) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= ADDON_MAX_CEILING) return n;
  const id = `${name}=${text}`;
  if (!warnedMax.has(id)) {
    warnedMax.add(id);
    console.warn(`[billing] ignoring ${name}="${text}": must be a whole number from 1 to ${ADDON_MAX_CEILING}; using the default ${fallback}`);
  }
  return fallback;
}

export interface AddonQuantity {
  key: string;
  quantity: number;
}

/** A paid one-time pack (or several of one key) as counted by entitlements. */
export interface PackQuantity extends AddonQuantity {
  /** The window the pack was bought in; the per-period cap applies per window (rollover makes two windows usable). Omitted = one shared window. */
  window?: string;
  /** Texts still unused; omitted = the full pack (texts × quantity). */
  remaining?: number;
}

export interface Entitlements extends PlanLimits {
  planKey: string | null;
  /** "configured": plan limits known; "fallback": plan not recognised → smallest tier; "none": no subscription. */
  source: "configured" | "fallback" | "none";
  /** Recurring add-ons that were counted (unknown keys dropped), quantity = what was counted after the cap. */
  addons: AddonQuantity[];
  /** One-time text packs (`texts_<n>`) usable now (bought this window or rolled over from the last one), quantity after the cap. */
  packs: AddonQuantity[];
  /** The monthly allowance from the plan + recurring add-ons (used FIRST each window). */
  includedTexts: number;
  /** Unused texts left in usable packs (used after the allowance, soonest-expiring first). monthlyTexts = includedTexts + packTexts. */
  packTexts: number;
}

/**
 * plan + add-on quantities → totals. Quantities are clamped to integers ≥ 0; the same add-on listed
 * twice is summed; add-ons with no known effect are ignored. `branding` is OR-ed (plan includes it
 * or an add-on unlocks it). Each add-on's summed quantity is capped at `addonMaxQuantity` (so a quantity
 * set directly in Stripe never grants more than the cap); `addons` reports the quantity actually counted.
 */
export function computeEntitlements(planKey: string | null | undefined, addonQuantities: readonly AddonQuantity[] = [], env: Env = process.env, packQuantities: readonly PackQuantity[] = []): Entitlements {
  if (!planKey) return { ...NO_LIMITS, planKey: null, source: "none", addons: [], packs: [], includedTexts: 0, packTexts: 0 };
  const { source, ...limits } = planLimits(planKey, env);
  return applyAddons(limits, planKey.toLowerCase(), source, addonQuantities, env, packQuantities);
}

function applyAddons(limits: PlanLimits, planKey: string | null, source: Entitlements["source"], addonQuantities: readonly AddonQuantity[], env: Env, packQuantities: readonly PackQuantity[] = []): Entitlements {
  const merged = new Map<string, number>();
  for (const a of addonQuantities) {
    const q = Number.isFinite(a.quantity) ? Math.max(0, Math.floor(a.quantity)) : 0;
    if (q > 0) merged.set(a.key.toLowerCase(), (merged.get(a.key.toLowerCase()) ?? 0) + q);
  }
  const total: PlanLimits = { ...limits };
  const counted: AddonQuantity[] = [];
  for (const [key, raw] of merged) {
    const fx = addonEffect(key);
    if (!fx) continue;
    const q = Math.min(raw, addonMaxQuantity(key, env));
    total.seats += (fx.seats ?? 0) * q;
    total.locations += (fx.locations ?? 0) * q;
    total.monthlyTexts += (fx.monthlyTexts ?? 0) * q;
    if (fx.brandingRemoved) total.brandingRemoved = true;
    counted.push({ key, quantity: q });
  }
  // One-time text packs (paid, usable now): the cap applies per purchase window (rollover → up to two windows usable).
  // Each pack adds its UNUSED texts on top of the allowance.
  const includedTexts = total.monthlyTexts;
  const groups = new Map<string, { key: string; quantity: number; texts: number }>();
  for (const p of packQuantities) {
    const q = Number.isFinite(p.quantity) ? Math.max(0, Math.floor(p.quantity)) : 0;
    const size = textPackSize(p.key);
    if (!(q > 0 && size)) continue;
    const key = p.key.toLowerCase();
    const full = size * q;
    const texts = p.remaining === undefined || !Number.isFinite(p.remaining) ? full : Math.min(full, Math.max(0, Math.floor(p.remaining)));
    const g = groups.get(`${key}|${p.window ?? ""}`) ?? { key, quantity: 0, texts: 0 };
    g.quantity += q;
    g.texts += texts;
    groups.set(`${key}|${p.window ?? ""}`, g);
  }
  const perKey = new Map<string, number>();
  let packTexts = 0;
  for (const g of groups.values()) {
    const max = addonMaxQuantity(g.key, env);
    const q = Math.min(g.quantity, max);
    // Above the cap (a row written outside our code): count at most the cap's worth of texts for that window.
    const texts = Math.min(g.texts, textPackSize(g.key)! * q);
    packTexts += texts;
    perKey.set(g.key, (perKey.get(g.key) ?? 0) + q);
  }
  total.monthlyTexts += packTexts;
  const packs: AddonQuantity[] = [...perKey].map(([key, quantity]) => ({ key, quantity }));
  return { ...total, planKey, source, addons: counted.sort((a, b) => a.key.localeCompare(b.key)), packs: packs.sort((a, b) => a.key.localeCompare(b.key)), includedTexts, packTexts };
}

export interface MirroredItem {
  priceId: string | null;
  quantity: number;
}

export interface ClassifiedItems {
  /** The plan item: the one whose price id matches plans(); else the first item that is not a known add-on. */
  plan: { priceId: string | null; planKey: string | null; item: MirroredItem } | null;
  addons: AddonQuantity[];
  /** Items that are neither a known plan nor a known add-on (e.g. a price removed from env). */
  unknown: MirroredItem[];
}

/** Sorts a subscription's items into plan / add-ons by matching price ids against env config. */
export function classifyItems<T extends MirroredItem>(items: readonly T[], env: Env = process.env): ClassifiedItems {
  let plan: ClassifiedItems["plan"] = null;
  const addonList: AddonQuantity[] = [];
  const unknown: MirroredItem[] = [];
  const rest: T[] = [];
  for (const it of items) {
    const p = planByPriceId(it.priceId, env);
    if (p && !plan) plan = { priceId: it.priceId, planKey: p.key, item: it };
    else if (addonByPriceId(it.priceId, env)) addonList.push({ key: addonByPriceId(it.priceId, env)!.key, quantity: it.quantity });
    else rest.push(it);
  }
  if (!plan && rest.length) {
    plan = { priceId: rest[0].priceId, planKey: null, item: rest[0] };
    rest.shift();
  }
  unknown.push(...rest);
  return { plan, addons: addonList, unknown };
}

/** items (as mirrored) → entitlements. */
export function entitlementsFromItems(items: readonly MirroredItem[], env: Env = process.env, packQuantities: readonly PackQuantity[] = []): Entitlements {
  const c = classifyItems(items, env);
  if (!c.plan) return computeEntitlements(null, [], env);
  // A plan item whose price is not configured as a plan still has a (fallback) tier: it is a live subscription.
  if (c.plan.planKey === null) return applyAddons(FALLBACK_PLAN_LIMITS, null, "fallback", c.addons, env, packQuantities);
  return computeEntitlements(c.plan.planKey, c.addons, env, packQuantities);
}
