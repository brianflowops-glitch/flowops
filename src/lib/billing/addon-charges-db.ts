import "server-only";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { connectSession, isPoolTimeout, schema, sessionDbProblem, type Db, type SessionClient } from "@/lib/db";
import type { AddonChargeLedger, AddonChargeRecord } from "./addon-charge";
import { reconcileAddonCharges, type AddonStripe } from "./addons";

/**
 * The `addon_charge` table (migration 0011) as an `AddonChargeLedger` for one organization (docs/BILLING.md §11).
 * Every write autocommits on `db` (0006: the add-on lock's own session connection, see `withAddonChangeLock`), so a
 * row survives anything that fails later (the money may already be collected). The caller holds the org's add-on lock.
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

/** Advisory-lock key space for add-on changes (two int4 keys: never overlaps the single-bigint org locks in pipeline.ts). */
const LOCK_NS = "flowops:addon-change";
export const ADDON_LOCK_WAIT_MS = 20_000;

/** Another add-on change of the same org kept the lock longer than the wait (→ 409, try again). */
export class AddonChangeBusy extends Error {
  constructor() {
    super("Another add-on change for this organization is still in progress");
  }
}
/** No session connection / no direct database URL (→ 503). */
export class AddonLockUnavailable extends Error {}

export type AddonLockOptions = {
  /** How long to wait for the org's lock (default ADDON_LOCK_WAIT_MS). 0 = try once (the sweep skips busy orgs). */
  waitMs?: number;
  /** Session connection source (tests); default `connectSession` (dedicated direct pool, see db/index.ts). */
  connect?: () => Promise<SessionClient>;
};

/**
 * One add-on change per org at a time, on ONE database connection (0006).
 *
 * Takes a session-level `pg_try_advisory_lock(ns, hashtext(orgId))` on a single connection from the dedicated session
 * pool, runs `fn` with an `addon_charge` ledger on that SAME connection (every write autocommits, so a charge row
 * survives anything that happens later), and always unlocks in `finally`, also when `fn` throws. If the unlock can't be
 * confirmed the connection is destroyed, which drops the lock with the session. If the process dies, the connection
 * closes and Postgres drops the lock; a frozen function is cut off by `idle_session_timeout`.
 *
 * Why not the 0005 shape (a transaction holding `SELECT … FOR NO KEY UPDATE` on the org row, with ledger writes on a
 * second pooled connection): every request held TWO connections from a pool of 5, so five concurrent requests could
 * each hold one and wait forever for a second (instance hang). Here a request never needs a second connection while
 * it holds one, and a request waiting for the lock holds none, so there is no cycle: requests either get the lock,
 * wait for it (bounded: 409), or fail to get a connection (bounded by connectionTimeoutMillis: 503).
 *
 * Why session-level and not `pg_advisory_xact_lock`: the charge rows must be committed while the lock is held (a
 * transaction-scoped lock would force them into the lock's transaction, and a rollback or crash would erase the record
 * of money already collected). Session locks need a real session, hence the direct (unpooled) connection.
 */
export async function withAddonChangeLock<T>(orgId: string, fn: (ledger: AddonChargeLedger, session: SessionClient) => Promise<T>, opts: AddonLockOptions = {}): Promise<T> {
  const connect = async () => {
    try {
      return await (opts.connect ?? connectSession)();
    } catch (err) {
      throw new AddonLockUnavailable(isPoolTimeout(err) ? "No database connection available for add-on changes (timed out)" : `Add-on lock connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const deadline = Date.now() + (opts.waitMs ?? ADDON_LOCK_WAIT_MS);
  let session: SessionClient;
  // Try the lock; if another request of this org holds it, give the connection BACK while waiting (a waiter never
  // occupies a connection, so a burst on one org can't starve other orgs of connections), then retry.
  for (let i = 0; ; i++) {
    session = await connect();
    let ok = false;
    try {
      ok = Boolean((await session.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1), hashtext($2)) as ok", [LOCK_NS, orgId])).rows[0]?.ok);
    } catch (err) {
      session.release(true);
      throw err;
    }
    if (ok) break;
    session.release();
    if (Date.now() >= deadline) throw new AddonChangeBusy();
    await new Promise((r) => setTimeout(r, Math.min(250, 25 * 2 ** Math.min(i, 4)) + Math.floor(Math.random() * 25)));
  }
  try {
    return await fn(dbAddonChargeLedger(session.db, orgId), session);
  } finally {
    let destroy = false;
    try {
      const { rows } = await session.query<{ ok: boolean }>("select pg_advisory_unlock(hashtext($1), hashtext($2)) as ok", [LOCK_NS, orgId]);
      destroy = !rows[0]?.ok;
    } catch {
      destroy = true;
    }
    if (destroy) console.error("[billing] add-on lock unlock not confirmed; dropping the connection (releases the lock)", orgId);
    session.release(destroy);
  }
}

/**
 * HTTP answer for a lock/connection failure, or null if `err` is something else (rethrow it).
 * 503 = no connection (pool timeout / no direct URL), 409 = the org's lock stayed busy.
 */
export function addonLockFailureResponse(err: unknown): Response | null {
  if (err instanceof AddonLockUnavailable || isPoolTimeout(err)) {
    console.error("[billing] add-on change: database unavailable", err instanceof Error ? err.message : err);
    return Response.json({ error: "Billing is busy right now. Nothing was charged or changed; please try again in a moment.", code: "db_unavailable" }, { status: 503, headers: { "Retry-After": "5" } });
  }
  if (err instanceof AddonChangeBusy)
    return Response.json({ error: "Another add-on change for this business is still being processed. Nothing was charged by this request; try again in a moment.", code: "change_in_progress" }, { status: 409, headers: { "Retry-After": "5" } });
  return null;
}

/**
 * Sweep (0005, scheduled by the daily cron in 0006: GET /api/cron/addon-charges): settle trial add-on charge attempts
 * left `pending` / `paid` by a crash, for every org, under that org's add-on lock (`withAddonChangeLock`, so it never
 * races a live request). An org whose lock is busy is skipped (status "busy": a live request is settling it anyway,
 * and the next run retries). Only attempts older than `olderThanMs` (default 10 min) are touched. Orgs in
 * `skipOrgIds` (demo / exempt) and, with `skipDemoOrgs`, orgs with `is_demo` set are skipped; a missing session connection (misconfigured URL, pool timeout) throws `AddonLockUnavailable` instead of being counted per org; past `deadline` (epoch ms) the remaining orgs are left for the next run. Idempotent: safe to run as often as wanted. Uses one session connection
 * at a time.
 */
export async function sweepAddonCharges(db: Db, stripe: AddonStripe, opts: { olderThanMs?: number; now?: Date; skipOrgIds?: ReadonlySet<string>; skipDemoOrgs?: boolean; deadline?: number; connect?: () => Promise<SessionClient>; waitMs?: number } = {}) {
  // 0007: a misconfigured lock pool (a Neon -pooler DATABASE_URL without DATABASE_URL_UNPOOLED) fails the whole run
  // up front, even with nothing to settle, so the cron answers non-200 instead of a quiet 200.
  const problem = opts.connect ? null : sessionDbProblem();
  if (problem) throw new AddonLockUnavailable(problem);
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.olderThanMs ?? 10 * 60_000));
  const t = schema.addonCharge;
  const orgs = await db
    .selectDistinct({ orgId: t.organizationId, isDemo: schema.organization.isDemo })
    .from(t)
    .innerJoin(schema.organization, eq(schema.organization.id, t.organizationId))
    .where(and(inArray(t.status, ["pending", "paid"]), lt(t.createdAt, cutoff)));
  const results: { orgId: string; id: string; status: string }[] = [];
  for (const { orgId, isDemo } of orgs) {
    if (opts.deadline && Date.now() > opts.deadline) {
      results.push({ orgId, id: "*", status: "deferred" }); // out of time: next run
      continue;
    }
    if (opts.skipOrgIds?.has(orgId)) {
      results.push({ orgId, id: "*", status: "skipped_exempt" });
      continue;
    }
    if (opts.skipDemoOrgs && isDemo) {
      results.push({ orgId, id: "*", status: "skipped_demo" }); // organization.is_demo (0007)
      continue;
    }
    try {
      await withAddonChangeLock(
        orgId,
        async (ledger) => {
          for (const r of await reconcileAddonCharges(stripe, ledger, await ledger.unresolved(cutoff))) results.push({ orgId, ...r });
        },
        { waitMs: opts.waitMs ?? 0, connect: opts.connect },
      );
    } catch (err) {
      if (err instanceof AddonChangeBusy) {
        results.push({ orgId, id: "*", status: "busy" });
        continue;
      }
      // No session connection (pool timeout / misconfigured URL) affects every org: stop and surface it (0007).
      if (err instanceof AddonLockUnavailable) throw err;
      console.error("[billing] add-on charge sweep failed for an org (continuing)", orgId, err instanceof Error ? err.message : err);
      results.push({ orgId, id: "*", status: "error" });
    }
  }
  return results;
}
