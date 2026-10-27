import "server-only";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { schema, type Db } from "@/lib/db";
import type { AddonChargeLedger, AddonChargeRecord } from "./addon-charge";
import { reconcileAddonCharges, type AddonStripe } from "./addons";

/**
 * The `addon_charge` table (migration 0011) as an `AddonChargeLedger` for one organization (docs/BILLING.md §11).
 * Writes go through `db` directly, NOT the caller's lock transaction, so a row survives that transaction being
 * rolled back (the money may already be collected). The caller holds the org row lock while it uses the ledger.
 */
export function dbAddonChargeLedger(db: Db, orgId: string): AddonChargeLedger {
  const t = schema.addonCharge;
  const toRecord = (r: typeof t.$inferSelect): AddonChargeRecord => ({
    id: r.id,
    orgId: r.organizationId,
    subscriptionId: r.stripeSubscriptionId,
    customerId: r.stripeCustomerId,
    addon: r.addonKey,
    priceId: r.priceId,
    fromQuantity: r.fromQuantity,
    toQuantity: r.toQuantity,
    amount: r.amount,
    currency: r.currency,
    paymentMethod: r.paymentMethod,
    status: r.status,
    invoiceId: r.stripeInvoiceId,
    creditNoteId: r.stripeCreditNoteId,
    createdAt: r.createdAt,
  });
  return {
    orgId,
    async insert(r) {
      await db.insert(t).values({
        id: r.id,
        organizationId: orgId,
        stripeSubscriptionId: r.subscriptionId,
        stripeCustomerId: r.customerId,
        addonKey: r.addon,
        priceId: r.priceId,
        fromQuantity: r.fromQuantity,
        toQuantity: r.toQuantity,
        amount: r.amount,
        currency: r.currency,
        paymentMethod: r.paymentMethod,
        status: "pending",
      });
    },
    async update(id, patch) {
      await db
        .update(t)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.invoiceId !== undefined ? { stripeInvoiceId: patch.invoiceId } : {}),
          ...(patch.creditNoteId !== undefined ? { stripeCreditNoteId: patch.creditNoteId } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(t.id, id), eq(t.organizationId, orgId)));
    },
    async unresolved(createdBefore) {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.organizationId, orgId), inArray(t.status, ["pending", "paid"]), ...(createdBefore ? [lt(t.createdAt, createdBefore)] : [])))
        .orderBy(asc(t.createdAt));
      return rows.map(toRecord);
    },
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The per-org add-on lock, taken by the add-on route and the sweep inside their transaction. FOR NO KEY UPDATE (not
 * FOR UPDATE): it conflicts with itself and with the FOR UPDATE org locks elsewhere (text packs), so changes stay
 * serialised, but it lets the ledger's `addon_charge` insert, which runs on another connection outside the
 * transaction, take the foreign key's KEY SHARE lock on the org row. With FOR UPDATE that insert would wait for the
 * transaction that is waiting for it (self-deadlock; caught by the DB tests).
 */
export async function lockOrgForAddonChange(tx: Tx, orgId: string) {
  await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, orgId)).for("no key update");
}

/**
 * Sweep (0005): settle trial add-on charge attempts left `pending` / `paid` by a crash, for every org, under each
 * org's row lock (so it never races a live request). Only attempts older than `olderThanMs` (default 10 min) are
 * touched. Idempotent: safe to run as often as wanted. NOT scheduled yet (launch task, docs/BILLING.md §11); the
 * same reconciliation also runs inline at the start of the org's next add-on change.
 */
export async function sweepAddonCharges(db: Db, stripe: AddonStripe, opts: { olderThanMs?: number; now?: Date } = {}) {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.olderThanMs ?? 10 * 60_000));
  const t = schema.addonCharge;
  const orgs = await db
    .selectDistinct({ orgId: t.organizationId })
    .from(t)
    .where(and(inArray(t.status, ["pending", "paid"]), lt(t.createdAt, cutoff)));
  const results: { orgId: string; id: string; status: string }[] = [];
  for (const { orgId } of orgs) {
    try {
      await db.transaction(async (tx) => {
        await lockOrgForAddonChange(tx, orgId);
        const ledger = dbAddonChargeLedger(db, orgId);
        for (const r of await reconcileAddonCharges(stripe, ledger, await ledger.unresolved(cutoff))) results.push({ orgId, ...r });
      });
    } catch (err) {
      console.error("[billing] add-on charge sweep failed for an org (continuing)", orgId, err instanceof Error ? err.message : err);
      results.push({ orgId, id: "*", status: "error" });
    }
  }
  return results;
}
