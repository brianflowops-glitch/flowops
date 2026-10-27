import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/lib/db";
import { billingEnabled } from "./config";
import { billingExemptOrgIds, effectiveSubscription, FULL_ACCESS_STATUSES } from "./access-rules";
import { entitlementsFromItems, type Entitlements } from "./entitlements";
import { activePaidPacks } from "./text-packs";

export type OrgEntitlements =
  /** No limits apply: billing is off, or the org is exempt (docs/BILLING.md §6). */
  | { enforced: false; reason: "billing_disabled" | "exempt" }
  /** Limits apply. `reason` "ok" = live paid subscription; anything else = no live subscription (limits are all zero; the org is locked anyway). */
  | { enforced: true; reason: "ok" | "no_subscription" | "not_active"; entitlements: Entitlements };

/**
 * What an org may use: plan limits plus add-ons from the mirrored subscription. Read-only.
 * Enforcement points (not wired yet, see docs/BILLING.md §11) should call this and compare:
 *   seats      → src/app/api/admin/invites/route.ts + src/lib/tenancy/invites.ts (count members + pending invites)
 *   texts      → src/lib/server/integrations/notify.ts: call consumeTexts (text-packs.ts) with allowance =
 *                entitlements.includedTexts and sentBefore = this window's sent SMS rows (plan first, then packs)
 *   branding   → public booking page (src/app/book/…)
 *   locations  → no multi-location model exists yet
 */
export async function getEntitlements(organizationId: string, opts: { db?: Db; env?: Record<string, string | undefined>; now?: Date } = {}): Promise<OrgEntitlements> {
  const env = opts.env ?? process.env;
  const enabled = opts.env ? env.BILLING_ENABLED === "true" : billingEnabled();
  if (!enabled) return { enforced: false, reason: "billing_disabled" };
  if (billingExemptOrgIds(env).has(organizationId)) return { enforced: false, reason: "exempt" };
  const db = opts.db ?? getDb();
  const rows = await db
    .select({ id: schema.subscription.id, status: schema.subscription.status, updatedAt: schema.subscription.updatedAt })
    .from(schema.subscription)
    .where(eq(schema.subscription.organizationId, organizationId));
  const sub = effectiveSubscription(rows);
  if (!sub) return { enforced: true, reason: "no_subscription", entitlements: entitlementsFromItems([], env) };
  if (!(FULL_ACCESS_STATUSES as readonly string[]).includes(sub.status)) return { enforced: true, reason: "not_active", entitlements: entitlementsFromItems([], env) };
  const items = await db
    .select({ priceId: schema.subscriptionItem.priceId, quantity: schema.subscriptionItem.quantity })
    .from(schema.subscriptionItem)
    .where(eq(schema.subscriptionItem.subscriptionId, sub.id));
  // Monthly texts = plan texts + UNUSED texts of paid packs usable now (bought this window or rolled over from the last one;
  // a pending or failed pack grants nothing).
  const packs = await activePaidPacks(db, organizationId, opts.now);
  return { enforced: true, reason: "ok", entitlements: entitlementsFromItems(items, env, packs.map((p) => ({ key: p.key, quantity: p.quantity, window: p.window, remaining: p.remaining }))) };
}
