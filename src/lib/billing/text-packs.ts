import "server-only";
import type Stripe from "stripe";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/lib/db";
import { textPackByKey, textPackSize } from "./config";
import { addonMaxQuantity } from "./entitlements";
import { allocatePackTexts, PENDING_RESERVATION_MS, splitTextUsage, textPackExpiry, textPackWindow, validateTextPackRequest } from "./text-pack-rules";

type Env = Record<string, string | undefined>;

/**
 * Text packs (docs/BILLING.md §11): a ONE-TIME purchase charged in full, immediately, to the card on file with a
 * standalone invoice (never the subscription's invoice, never deferred, also during a trial). The texts are
 * granted ONLY once Stripe says the invoice is paid; any other outcome voids the invoice and grants nothing.
 *
 * Flow: validate → reserve a `pending` text_pack row (cap check under a row lock on the organization) →
 * create invoice (auto_advance false, pending items excluded) + invoice item → store the invoice id →
 * finalize → pay with the card on file → `paid` (grant) | void the invoice + `failed` (402).
 * The invoice.paid / invoice.payment_failed webhooks settle the same row idempotently (webhook.ts).
 *
 * Rollover (0004): a pack bought in text window N is usable in N and N+1 (`expires_at`), then expires. The cap
 * counts packs BOUGHT in the current window only, so up to 2× the cap can be usable at once (10 rolled over + 10 new).
 * Texts are drawn plan allowance first, then packs soonest-expiring first (`consumeTexts`).
 */
export interface PackStripe {
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> };
  customers: { retrieve(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> };
  invoices: {
    create(p: Stripe.InvoiceCreateParams, o?: Stripe.RequestOptions): Promise<Stripe.Invoice>;
    finalizeInvoice(id: string, p?: Stripe.InvoiceFinalizeInvoiceParams): Promise<Stripe.Invoice>;
    pay(id: string, p?: Stripe.InvoicePayParams): Promise<Stripe.Invoice>;
    retrieve(id: string): Promise<Stripe.Invoice>;
    voidInvoice(id: string): Promise<Stripe.Invoice>;
    del(id: string): Promise<unknown>;
  };
  invoiceItems: { create(p: Stripe.InvoiceItemCreateParams, o?: Stripe.RequestOptions): Promise<Stripe.InvoiceItem> };
}

export type PackPurchaseResult =
  | {
      ok: true;
      pack: string;
      quantity: number;
      texts: number;
      invoiceId: string;
      amountPaid: number;
      currency: string;
      /** The texts are usable until this instant: the end of the NEXT text window (one period of rollover). */
      validUntil: string;
      /** End of the text window the pack was bought in (the cap's window). */
      windowEnd: string;
      duringTrial: boolean;
    }
  | { ok: false; status: 400 | 402 | 409 | 502; error: string; code: "invalid" | "cap" | "no_subscription" | "no_payment_method" | "payment_failed" | "stripe_error"; portal?: boolean };

export interface PurchaseTextPackInput {
  stripe: PackStripe;
  db: Db;
  orgId: string;
  customerId: string;
  /** The live Stripe subscription (id + status are enough; the rest is re-read from Stripe). */
  subscription: Pick<Stripe.Subscription, "id" | "status">;
  pack: string;
  quantity: number;
  env?: Env;
  now?: Date;
}

const rid = () => `tp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.id);
const PORTAL_HINT = "Update your card in the billing portal and try again.";

const isCardError = (e: unknown) => {
  const x = e as { type?: string; rawType?: string } | null;
  return x?.type === "StripeCardError" || x?.rawType === "card_error";
};

export interface UsablePackRow {
  id: string;
  key: string;
  quantity: number;
  textsPerPack: number;
  textsUsed: number;
  /** Texts taken back after a refund or dispute (0012). */
  textsRevoked: number;
  /** Texts still in the pack (excluding revoked ones). */
  remaining: number;
  /** Start of the window the pack was bought in (the cap's unit). */
  window: string;
  expiresAt: Date;
  createdAt: Date;
}

const expiresSql = () => sql`coalesce(${schema.textPack.expiresAt}, ${schema.textPack.periodEnd})`;

/**
 * Paid packs of the org usable at `now`: bought in a window that has started and not expired yet (purchase window
 * or the one rollover window). What entitlements count, soonest-expiring first. Fully used packs are included with remaining 0.
 */
export async function activePaidPacks(db: Pick<Db, "select">, orgId: string, now: Date = new Date()): Promise<UsablePackRow[]> {
  const t = schema.textPack;
  const rows = await db
    .select({ id: t.id, key: t.packKey, quantity: t.quantity, textsPerPack: t.textsPerPack, textsUsed: t.textsUsed, textsRevoked: t.textsRevoked, periodStart: t.periodStart, periodEnd: t.periodEnd, expiresAt: t.expiresAt, createdAt: t.createdAt })
    .from(t)
    .where(and(eq(t.organizationId, orgId), eq(t.status, "paid"), sql`${t.periodStart} <= ${now.toISOString()}::timestamptz`, sql`${expiresSql()} > ${now.toISOString()}::timestamptz`))
    .orderBy(expiresSql(), t.createdAt, t.id);
  return rows.map((r) => ({
    id: r.id, key: r.key, quantity: r.quantity, textsPerPack: r.textsPerPack, textsUsed: r.textsUsed,
    textsRevoked: r.textsRevoked,
    // Revoked texts (refund / dispute, 0012) are not usable: consumeTexts allocates from `remaining` only.
    remaining: Math.max(0, r.textsPerPack * r.quantity - r.textsUsed - r.textsRevoked),
    window: r.periodStart.toISOString(), expiresAt: r.expiresAt ?? r.periodEnd, createdAt: r.createdAt,
  }));
}

export interface ConsumeTextsResult {
  /** Texts covered by the plan's monthly allowance. */
  fromPlan: number;
  /** Texts drawn from packs (pack id → texts), soonest-expiring first. */
  fromPacks: { id: string; texts: number }[];
  /** Texts nothing could cover (the caller must not send them). */
  denied: number;
}

/**
 * Account for `count` texts about to be sent in the current window: the plan allowance first (`allowance` = the
 * plan's + recurring add-ons' monthly texts, `sentBefore` = texts already sent in this window, which the caller
 * counts), then paid usable packs soonest-expiring first. Pack draws are written under a row lock on the
 * organization, so concurrent sends never overdraw a pack. Nothing is drawn when the request can't be covered in
 * full (`denied` > 0), unless `partial` is set. Not wired into the SMS sender yet (enforcement is a launch task, §11).
 */
export async function consumeTexts(db: Db, p: { orgId: string; allowance: number; sentBefore: number; count: number; now?: Date; partial?: boolean }): Promise<ConsumeTextsResult> {
  const { fromPlan, fromPacks } = splitTextUsage(p.allowance, p.sentBefore, p.count);
  if (fromPacks === 0) return { fromPlan, fromPacks: [], denied: 0 };
  return db.transaction(async (tx) => {
    await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, p.orgId)).for("update");
    const packs = await activePaidPacks(tx, p.orgId, p.now ?? new Date());
    const { draws, shortfall } = allocatePackTexts(packs, fromPacks);
    if (shortfall > 0 && !p.partial) return { fromPlan, fromPacks: [], denied: shortfall };
    for (const d of draws)
      await tx.update(schema.textPack).set({ textsUsed: sql`${schema.textPack.textsUsed} + ${d.texts}`, updatedAt: new Date() }).where(eq(schema.textPack.id, d.id));
    return { fromPlan, fromPacks: draws, denied: shortfall };
  });
}

/** Packs bought (paid) plus in-flight reservations in one window: the number the per-period cap counts. */
export async function packsInWindow(db: Pick<Db, "select">, orgId: string, packKey: string, windowStart: Date, now: Date): Promise<number> {
  const t = schema.textPack;
  const fresh = new Date(now.getTime() - PENDING_RESERVATION_MS);
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${t.quantity}), 0)::int` })
    .from(t)
    .where(
      and(
        eq(t.organizationId, orgId),
        eq(t.packKey, packKey),
        sql`${t.periodStart} = ${windowStart.toISOString()}::timestamptz`,
        or(eq(t.status, "paid"), and(eq(t.status, "pending"), gt(t.createdAt, fresh))),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Settle a pack paid (idempotent; also recovers a row we had marked failed if Stripe really collected the money). */
export async function markPackPaid(db: Pick<Db, "update">, invoiceId: string, amountPaid: number | null): Promise<number> {
  const t = schema.textPack;
  const rows = await db
    .update(t)
    .set({ status: "paid", amountPaid, paidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(t.stripeInvoiceId, invoiceId), inArray(t.status, ["pending", "failed"])))
    .returning({ id: t.id });
  return rows.length;
}

/** Settle a pack failed (idempotent; a paid pack is never downgraded). */
export async function markPackFailed(db: Pick<Db, "update">, by: { invoiceId: string } | { id: string }): Promise<number> {
  const t = schema.textPack;
  const rows = await db
    .update(t)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and("invoiceId" in by ? eq(t.stripeInvoiceId, by.invoiceId) : eq(t.id, by.id), eq(t.status, "pending")))
    .returning({ id: t.id });
  return rows.length;
}

/** Make sure an unpaid pack invoice can never be paid later: void it (draft: delete it). Returns the final Stripe status. */
async function abandonInvoice(stripe: PackStripe, invoiceId: string): Promise<string> {
  try {
    const inv = await stripe.invoices.retrieve(invoiceId);
    if (inv.status === "paid") return "paid";
    if (inv.status === "draft") await stripe.invoices.del(invoiceId);
    else if (inv.status === "open" || inv.status === "uncollectible") await stripe.invoices.voidInvoice(invoiceId);
    return inv.status === "draft" ? "deleted" : "void";
  } catch (err) {
    console.error("[billing] could not void an unpaid text-pack invoice", invoiceId, err instanceof Error ? err.message : err);
    return "unknown";
  }
}

export async function purchaseTextPack({ stripe, db, orgId, customerId, subscription, pack, quantity, env = process.env, now = new Date() }: PurchaseTextPackInput): Promise<PackPurchaseResult> {
  const v = validateTextPackRequest(pack, quantity, env);
  if (!v.ok) return { ok: false, status: v.status, error: v.error, code: "invalid" };
  const key = pack.toLowerCase();
  const cfg = textPackByKey(key, env);
  if (!cfg) return { ok: false, status: 400, error: "Unknown text pack", code: "invalid" };
  if (subscription.status !== "active" && subscription.status !== "trialing")
    return { ok: false, status: 409, error: "Text packs can only be bought on an active subscription. Fix the payment in the billing portal first.", code: "no_subscription", portal: true };

  // The card on file: the subscription's own, else the customer's default. No card → no purchase (a trial may have none: it starts without a card).
  const sub = await stripe.subscriptions.retrieve(subscription.id);
  const customer = await stripe.customers.retrieve(customerId);
  const pm = idOf(sub.default_payment_method) ?? (customer.deleted ? null : idOf(customer.invoice_settings?.default_payment_method as string | { id: string } | null | undefined));
  if (!pm) return { ok: false, status: 402, error: `There is no payment method on file. Add one in the billing portal, then buy the pack.`, code: "no_payment_method", portal: true };

  const first = sub.items.data[0];
  if (!first?.current_period_start || !first.current_period_end) return { ok: false, status: 409, error: "Could not read the subscription's billing period", code: "no_subscription" };
  const win = textPackWindow(new Date(first.current_period_start * 1000), new Date(first.current_period_end * 1000), now);
  const expiresAt = textPackExpiry(new Date(first.current_period_start * 1000), new Date(first.current_period_end * 1000), now);
  const size = textPackSize(key)!;

  // Reserve (cap check + insert) under a row lock on the organization, so two requests can't both slip under the cap.
  const id = rid();
  const reserved = await db.transaction(async (tx) => {
    await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, orgId)).for("update");
    const used = await packsInWindow(tx, orgId, key, win.start, now);
    const max = addonMaxQuantity(key, env);
    if (used + quantity > max) return { used, max } as const;
    await tx.insert(schema.textPack).values({ id, organizationId: orgId, packKey: key, textsPerPack: size, quantity, status: "pending", periodStart: win.start, periodEnd: win.end, expiresAt });
    return null;
  });
  if (reserved) {
    const left = Math.max(0, reserved.max - reserved.used);
    return { ok: false, status: 400, error: `At most ${reserved.max} "${key}" packs per billing period; ${reserved.used} already bought or in progress, so ${left === 0 ? "no more can be added" : `at most ${left} more`} until the period renews.`, code: "cap" };
  }

  let invoiceId: string | null = null;
  try {
    const invoice = await stripe.invoices.create(
      {
        customer: customerId,
        collection_method: "charge_automatically",
        auto_advance: false, // we finalize and pay it ourselves; Stripe never retries or emails it behind our back
        pending_invoice_items_behavior: "exclude", // never sweep in other pending items
        default_payment_method: pm,
        description: `FlowOps text pack: ${quantity} × ${size.toLocaleString("en-US")} texts`,
        metadata: { flowops_text_pack: id, organizationId: orgId, pack: key, quantity: String(quantity) },
      },
      { idempotencyKey: `flowops-pack-invoice-${id}` },
    );
    invoiceId = invoice.id;
    await db.update(schema.textPack).set({ stripeInvoiceId: invoiceId, updatedAt: new Date() }).where(eq(schema.textPack.id, id));
    await stripe.invoiceItems.create({ customer: customerId, invoice: invoiceId, pricing: { price: cfg.priceId }, quantity }, { idempotencyKey: `flowops-pack-item-${id}` });
    await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: false });
    const paid = await stripe.invoices.pay(invoiceId, { payment_method: pm });
    if (paid.status !== "paid") throw Object.assign(new Error(`invoice ${paid.status}`), { type: "StripeCardError" });
    await markPackPaid(db, invoiceId, paid.amount_paid);
    return {
      ok: true, pack: key, quantity, texts: size * quantity, invoiceId, amountPaid: paid.amount_paid, currency: paid.currency,
      validUntil: expiresAt.toISOString(), windowEnd: win.end.toISOString(), duringTrial: sub.status === "trialing",
    };
  } catch (err) {
    // Whatever went wrong, an unpaid invoice must not stay payable, and nothing is granted.
    const final = invoiceId ? await abandonInvoice(stripe, invoiceId) : "none";
    if (final === "paid" && invoiceId) {
      // The charge actually went through (e.g. a timeout after Stripe collected): grant, it is paid.
      const inv = await stripe.invoices.retrieve(invoiceId).catch(() => null);
      await markPackPaid(db, invoiceId, inv?.amount_paid ?? null);
      return { ok: true, pack: key, quantity, texts: size * quantity, invoiceId, amountPaid: inv?.amount_paid ?? 0, currency: inv?.currency ?? "usd", validUntil: expiresAt.toISOString(), windowEnd: win.end.toISOString(), duringTrial: sub.status === "trialing" };
    }
    await markPackFailed(db, { id });
    if (isCardError(err)) return { ok: false, status: 402, error: `Your card was declined, so nothing was charged and no texts were added. ${PORTAL_HINT}`, code: "payment_failed", portal: true };
    console.error("[billing] text pack purchase failed", err instanceof Error ? err.message : err);
    return { ok: false, status: 502, error: "The purchase could not be completed; nothing was added. Try again, or use the billing portal to check your payment method.", code: "stripe_error", portal: true };
  }
}
