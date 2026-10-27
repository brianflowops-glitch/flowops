/**
 * Plan limits + add-ons → what an organization is entitled to (docs/BILLING.md §11).
 * Pure: no database, no Stripe, no "server-only", so it is usable from UI code and offline tests.
 *
 * Prices are never here (they live in Stripe, referenced by STRIPE_PRICE_* / STRIPE_ADDON_PRICE_*).
 * What IS here is *what a unit of each add-on gives you* and the default plan limits. Both are
 * product definitions rather than prices, and the plan limits can be overridden per plan from env.
 */
import { addonByPriceId, planByPriceId } from "./config";

type Env = Record<string, string | undefined>;

export interface PlanLimits {
  seats: number;
  locations: number;
  /** Included text messages per month. */
  monthlyTexts: number;
  /** FlowOps branding removed from the public booking page. */
  brandingRemoved: boolean;
}

/** Defaults from the pricing proposal (Brian to confirm). Override per plan with PLAN_LIMITS_<PLAN>. */
export const DEFAULT_PLAN_LIMITS: Readonly<Record<string, PlanLimits>> = {
  starter: { seats: 3, locations: 1, monthlyTexts: 500, brandingRemoved: false },
  pro: { seats: 10, locations: 1, monthlyTexts: 2000, brandingRemoved: true },
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

/** What one unit of an add-on adds. `texts_<n>` is generic (texts_1000, texts_5000 …). */
export type AddonEffect = Partial<Record<"seats" | "locations" | "monthlyTexts", number>> & { brandingRemoved?: true; maxQuantity?: number };

export function addonEffect(key: string): AddonEffect | null {
  const k = key.toLowerCase();
  if (k === "seat") return { seats: 1 };
  if (k === "location") return { locations: 1 };
  if (k === "branding") return { brandingRemoved: true, maxQuantity: 1 };
  const t = /^texts_(\d{1,7})$/.exec(k);
  if (t && Number(t[1]) > 0) return { monthlyTexts: Number(t[1]) };
  return null; // unknown add-on keys have no effect (still billed, still mirrored)
}

export interface AddonQuantity {
  key: string;
  quantity: number;
}

export interface Entitlements extends PlanLimits {
  planKey: string | null;
  /** "configured": plan limits known; "fallback": plan not recognised → smallest tier; "none": no subscription. */
  source: "configured" | "fallback" | "none";
  /** Add-ons that were counted, as given (unknown keys dropped). */
  addons: AddonQuantity[];
}

/**
 * plan + add-on quantities → totals. Quantities are clamped to integers ≥ 0; the same add-on listed
 * twice is summed; add-ons with no known effect are ignored. `branding` is OR-ed (plan includes it
 * or an add-on unlocks it); a branding add-on never counts more than once.
 */
export function computeEntitlements(planKey: string | null | undefined, addonQuantities: readonly AddonQuantity[] = [], env: Env = process.env): Entitlements {
  if (!planKey) return { ...NO_LIMITS, planKey: null, source: "none", addons: [] };
  const { source, ...limits } = planLimits(planKey, env);
  return applyAddons(limits, planKey.toLowerCase(), source, addonQuantities);
}

function applyAddons(limits: PlanLimits, planKey: string | null, source: Entitlements["source"], addonQuantities: readonly AddonQuantity[]): Entitlements {
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
    const q = Math.min(raw, fx.maxQuantity ?? raw);
    total.seats += (fx.seats ?? 0) * q;
    total.locations += (fx.locations ?? 0) * q;
    total.monthlyTexts += (fx.monthlyTexts ?? 0) * q;
    if (fx.brandingRemoved) total.brandingRemoved = true;
    counted.push({ key, quantity: raw });
  }
  return { ...total, planKey, source, addons: counted.sort((a, b) => a.key.localeCompare(b.key)) };
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
export function entitlementsFromItems(items: readonly MirroredItem[], env: Env = process.env): Entitlements {
  const c = classifyItems(items, env);
  if (!c.plan) return computeEntitlements(null, [], env);
  // A plan item whose price is not configured as a plan still has a (fallback) tier: it is a live subscription.
  if (c.plan.planKey === null) return applyAddons(FALLBACK_PLAN_LIMITS, null, "fallback", c.addons);
  return computeEntitlements(c.plan.planKey, c.addons, env);
}
