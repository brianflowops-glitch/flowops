// Creates / updates the FINAL-pricing prices in the Stripe TEST-mode sandbox (never live). Idempotent.
//   STRIPE_SECRET_KEY_TEST_US=sk_test_… npx tsx scripts/sandbox-final-prices.ts
// Reuses the existing Starter / Pro monthly and seat / location / branding monthly prices (amounts already match),
// marking them `placeholder=false, flowops_final=true`; creates the rest by lookup key. The secret key is never printed.
import Stripe from "stripe";

export const EXPECT_ACCOUNT = "acct_1UUvH95iQFiJ57yp";
export const EXISTING = {
  starter_month: "price_1UUvY25iQFiJ57ypFl4SOyNb",
  pro_month: "price_1UUvY35iQFiJ57ypBQeXz1q5",
  seat_month: "price_1UVB9h5iQFiJ57ypTZbo5ZBn",
  location_month: "price_1UVB9h5iQFiJ57ypGYTvNWjm",
  branding_month: "price_1UVB9i5iQFiJ57ypFfJkhTj1",
};
export const OLD_RECURRING_TEXTS = "price_1UVB9i5iQFiJ57yplkbyM4ky";

const FINAL = { flowops_final: "true", placeholder: "false" };
// cents. Annual = 10 × monthly (2 months free).
const PLAN = { starter: 4900, pro: 9900, business: 19900 } as const;
const ADDON = { seat: 1000, location: 2900, branding: 1500 } as const;

export type FinalPrices = Record<string, string>;

export async function ensureFinalPrices(stripe: Stripe, log: (m: string) => void = console.log): Promise<FinalPrices> {
  const acct = await stripe.accounts.retrieveCurrent();
  if (acct.id !== EXPECT_ACCOUNT) throw new Error(`Unexpected Stripe account ${acct.id}`);
  const out: FinalPrices = {};

  const byLookup = async (lookup_key: string) => (await stripe.prices.list({ lookup_keys: [lookup_key], active: true, limit: 1 })).data[0];

  /** Existing monthly price → mark final, rename its product. */
  const adopt = async (id: string, label: string, lookup: string) => {
    const p = await stripe.prices.retrieve(id);
    if (p.metadata.flowops_final !== "true" || p.metadata.placeholder !== "false")
      await stripe.prices.update(id, { metadata: { ...FINAL }, nickname: label });
    const productId = typeof p.product === "string" ? p.product : p.product.id;
    await stripe.products.update(productId, { name: label, metadata: { ...FINAL } });
    out[lookup] = id;
    log(`reuse  ${lookup} ${id} ${p.unit_amount}¢ ${p.recurring?.interval}`);
    return productId;
  };
  const make = async (lookup: string, cents: number, interval: "month" | "year" | "one_time", productId: string | null, name: string, meta: Record<string, string>) => {
    const found = await byLookup(lookup);
    if (found) {
      out[lookup] = found.id;
      log(`exists ${lookup} ${found.id}`);
      return typeof found.product === "string" ? found.product : found.product.id;
    }
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: cents,
      ...(interval === "one_time" ? {} : { recurring: { interval } }),
      lookup_key: lookup,
      nickname: name,
      metadata: { ...FINAL, ...meta },
      ...(productId ? { product: productId } : { product_data: { name, metadata: { ...FINAL, ...meta } } }),
    });
    out[lookup] = price.id;
    log(`create ${lookup} ${price.id} ${cents}¢ ${interval}`);
    return typeof price.product === "string" ? price.product : price.product.id;
  };

  // Plans
  const starterProd = await adopt(EXISTING.starter_month, "FlowOps Starter", "starter_month");
  const proProd = await adopt(EXISTING.pro_month, "FlowOps Pro", "pro_month");
  const bizProd = await make("flowops_business_monthly", PLAN.business, "month", null, "FlowOps Business", { flowops_plan: "business" });
  out.business_month = out.flowops_business_monthly;
  await make("flowops_starter_annual", PLAN.starter * 10, "year", starterProd, "FlowOps Starter (annual)", { flowops_plan: "starter" });
  await make("flowops_pro_annual", PLAN.pro * 10, "year", proProd, "FlowOps Pro (annual)", { flowops_plan: "pro" });
  await make("flowops_business_annual", PLAN.business * 10, "year", bizProd, "FlowOps Business (annual)", { flowops_plan: "business" });
  // Add-ons
  for (const k of ["seat", "location", "branding"] as const) {
    const prod = await adopt(EXISTING[`${k}_month` as const], `FlowOps extra ${k === "branding" ? "branding removal" : k}`, `${k}_month`);
    await make(`flowops_addon_${k}_annual`, ADDON[k] * 10, "year", prod, `FlowOps extra ${k} (annual)`, { flowops_addon: k });
  }
  // One-time text pack
  await make("flowops_texts_1000_pack", 1500, "one_time", null, "FlowOps text pack: 1,000 texts (one-time)", { flowops_addon: "texts_1000", one_time: "true" });

  // Old recurring texts price: archive only if no live subscription uses it.
  const old = await stripe.prices.retrieve(OLD_RECURRING_TEXTS);
  if (old.active) {
    const subs = await stripe.subscriptions.list({ price: OLD_RECURRING_TEXTS, status: "all", limit: 100 });
    const inUse = subs.data.filter((s) => !["canceled", "incomplete_expired"].includes(s.status));
    if (inUse.length === 0) {
      // A product's default price can't be archived directly: archive its (placeholder-only) product first.
      await stripe.products.update(typeof old.product === "string" ? old.product : old.product.id, { active: false });
      await stripe.prices.update(OLD_RECURRING_TEXTS, { active: false });
      log(`archived old recurring texts price ${OLD_RECURRING_TEXTS} (no live subscription uses it)`);
    } else log(`KEPT old recurring texts price ${OLD_RECURRING_TEXTS}: ${inUse.length} subscription(s) use it`);
  }
  return out;
}

if (process.argv[1]?.endsWith("sandbox-final-prices.ts")) {
  const key = process.env.STRIPE_SECRET_KEY_TEST_US;
  if (!key?.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY_TEST_US (a sk_test_ key) is required");
  ensureFinalPrices(new Stripe(key, { appInfo: { name: "FlowOps final prices (sandbox)" } })).then((p) => console.log(JSON.stringify(p, null, 2)));
}
