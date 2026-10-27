/**
 * Mid-period charges for recurring add-on INCREASES (docs/BILLING.md §11, Brian 2026-10-27, patch 0004).
 * Pure + injectable Stripe client (no "server-only"), so it runs offline in tests.
 *
 *   Active subscription → Stripe prorates: the item write uses `proration_behavior: "always_invoice"` +
 *     `payment_behavior: "pending_if_incomplete"`, so Stripe invoices the prorated rest of the period at once and
 *     only applies the new quantity if that invoice is paid (`inspectProrationOutcome`).
 *   Trialing subscription → Stripe's own proration during a trial is $0, which would leave the "add 50 seats in the
 *     trial, use them, cancel" hole open. So the add-on's rate for the REMAINING trial time is charged now on a
 *     standalone invoice (`trialProrationAmount` + `chargeOneOff`), exactly like a text pack bought in a trial,
 *     and the quantity is applied only once that invoice is paid. The first renewal (trial end) then bills the full
 *     price as usual.
 */
import type Stripe from "stripe";
import { addMonthsUTC } from "./text-pack-rules";

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.id);

/**
 * Prorated price (cents) of `delta` more units for the time left until `periodEnd`, at the add-on's normal rate:
 * unit × delta × remaining / (length of one billing interval starting now). Never more than one full interval.
 */
export function trialProrationAmount(p: { unitAmount: number; delta: number; now: number; periodEnd: number; interval: "month" | "year" }): number {
  const remaining = Math.max(0, p.periodEnd - p.now);
  if (remaining === 0 || p.delta <= 0 || p.unitAmount <= 0) return 0;
  const nowDate = new Date(p.now * 1000);
  const intervalEnd = addMonthsUTC(nowDate, p.interval === "year" ? 12 : 1).getTime() / 1000;
  const fraction = Math.min(1, remaining / (intervalEnd - p.now));
  return Math.round(p.unitAmount * p.delta * fraction);
}

/** The subset of Stripe used to charge a one-off invoice. */
export interface ChargeStripe {
  invoices: {
    create(p: Stripe.InvoiceCreateParams, o?: Stripe.RequestOptions): Promise<Stripe.Invoice>;
    finalizeInvoice(id: string, p?: Stripe.InvoiceFinalizeInvoiceParams): Promise<Stripe.Invoice>;
    pay(id: string, p?: Stripe.InvoicePayParams): Promise<Stripe.Invoice>;
    retrieve(id: string): Promise<Stripe.Invoice>;
    voidInvoice(id: string): Promise<Stripe.Invoice>;
    del(id: string): Promise<unknown>;
    /** Reconciliation: find an attempt's invoice by metadata when its id was never stored (0005). */
    list?(p: Stripe.InvoiceListParams): Promise<Stripe.ApiList<Stripe.Invoice>>;
  };
  invoiceItems: { create(p: Stripe.InvoiceItemCreateParams, o?: Stripe.RequestOptions): Promise<Stripe.InvoiceItem> };
}

export type ChargeOutcome =
  | { ok: true; invoiceId: string; amountPaid: number; currency: string }
  | { ok: false; code: "payment_failed" | "stripe_error"; invoiceId: string | null; final: string };

const isCardError = (e: unknown) => {
  const x = e as { type?: string; rawType?: string } | null;
  return x?.type === "StripeCardError" || x?.rawType === "card_error";
};

/** An unpaid invoice must never stay payable: void it (draft: delete it). Returns the final status ("paid" if it was paid after all). */
export async function abandonInvoice(stripe: Pick<ChargeStripe, "invoices">, invoiceId: string): Promise<string> {
  try {
    const inv = await stripe.invoices.retrieve(invoiceId);
    if (inv.status === "paid") return "paid";
    if (inv.status === "draft") await stripe.invoices.del(invoiceId);
    else if (inv.status === "open" || inv.status === "uncollectible") await stripe.invoices.voidInvoice(invoiceId);
    return inv.status === "draft" ? "deleted" : "void";
  } catch (err) {
    console.error("[billing] could not void an unpaid add-on invoice", invoiceId, err instanceof Error ? err.message : err);
    return "unknown";
  }
}

/**
 * Charge `amount` cents NOW on a standalone invoice (never the subscription's invoice; pending items excluded;
 * auto_advance off so Stripe never retries it behind our back). Paid → ok. Anything else → the invoice is voided.
 */
export async function chargeOneOff(
  stripe: ChargeStripe,
  p: { customer: string; paymentMethod: string; amount: number; currency: string; description: string; metadata: Record<string, string>; idempotencyKey: string; period?: { start: number; end: number }; onInvoiceCreated?: (invoiceId: string) => Promise<void> },
): Promise<ChargeOutcome> {
  let invoiceId: string | null = null;
  try {
    const invoice = await stripe.invoices.create(
      { customer: p.customer, collection_method: "charge_automatically", auto_advance: false, pending_invoice_items_behavior: "exclude", default_payment_method: p.paymentMethod, description: p.description, metadata: p.metadata },
      { idempotencyKey: `${p.idempotencyKey}-invoice` },
    );
    invoiceId = invoice.id;
    if (p.onInvoiceCreated) await p.onInvoiceCreated(invoice.id!);
    if (invoice.status === "paid") return { ok: true, invoiceId, amountPaid: invoice.amount_paid, currency: invoice.currency };
    // An idempotent replay of an earlier, abandoned attempt: never try to pay a voided invoice (callers use a key per attempt).
    if (invoice.status !== "draft" && invoice.status !== "open") return { ok: false, code: "stripe_error", invoiceId, final: invoice.status ?? "unknown" };
    if (invoice.status === "draft") {
      await stripe.invoiceItems.create(
        { customer: p.customer, invoice: invoiceId, amount: p.amount, currency: p.currency, description: p.description, ...(p.period ? { period: p.period } : {}), metadata: p.metadata },
        { idempotencyKey: `${p.idempotencyKey}-item` },
      );
      await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: false });
    }
    const paid = await stripe.invoices.pay(invoiceId, { payment_method: p.paymentMethod });
    if (paid.status !== "paid") throw Object.assign(new Error(`invoice ${paid.status}`), { type: "StripeCardError" });
    return { ok: true, invoiceId, amountPaid: paid.amount_paid, currency: paid.currency };
  } catch (err) {
    const final = invoiceId ? await abandonInvoice(stripe, invoiceId) : "none";
    if (final === "paid" && invoiceId) {
      const inv = await stripe.invoices.retrieve(invoiceId).catch(() => null);
      return { ok: true, invoiceId, amountPaid: inv?.amount_paid ?? p.amount, currency: inv?.currency ?? p.currency };
    }
    if (!isCardError(err)) console.error("[billing] add-on charge failed", err instanceof Error ? err.message : err);
    return { ok: false, code: isCardError(err) ? "payment_failed" : "stripe_error", invoiceId, final };
  }
}

/**
 * After an item write with `always_invoice` + `pending_if_incomplete`: did Stripe apply it (proration invoice paid)?
 * `before` = the subscription's latest invoice id before the write. A pending update means the invoice was not
 * paid: OUR proration invoice is voided, which also discards the pending update, so the extra quantity is never
 * granted and the invoice can't be paid later.
 *
 * Only the invoice this write created is ever voided (0005, review): it must be the subscription's new latest
 * invoice (id ≠ `before`), belong to this subscription and have `billing_reason: "subscription_update"`. If we
 * can't identify it, NOTHING is voided (never a fallback to whatever `latest_invoice` is, e.g. a renewal invoice)
 * and the caller answers 502: the update stays pending in Stripe, so nothing is granted unless that invoice is paid.
 */
export async function inspectProrationOutcome(
  stripe: { subscriptions: { retrieve(id: string, p?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription> }; invoices?: Pick<ChargeStripe["invoices"], "retrieve" | "voidInvoice" | "del"> },
  subscriptionId: string,
  before: string | null,
): Promise<{ ok: true; invoice: { id: string; amountPaid: number; currency: string; lines: { description: string | null; amount: number }[] } | null } | { ok: false; reason: "declined" | "unidentified"; invoiceId: string | null; final: string }> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
  const latest = (sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null) as Stripe.Invoice | null;
  const fresh = latest && latest.id && latest.id !== before && isOurProrationInvoice(latest, subscriptionId) ? latest : null;
  const summary = (inv: Stripe.Invoice) => ({ id: inv.id!, amountPaid: inv.amount_paid, currency: inv.currency, lines: (inv.lines?.data ?? []).map((l) => ({ description: l.description, amount: l.amount })) });
  if (sub.pending_update) {
    if (!fresh) {
      console.error("[billing] proration left a pending update but its invoice could not be identified; nothing voided, nothing granted", subscriptionId, latest?.id ?? null);
      return { ok: false, reason: "unidentified", invoiceId: null, final: "untouched" };
    }
    const final = stripe.invoices ? await abandonInvoice({ invoices: stripe.invoices } as Pick<ChargeStripe, "invoices">, fresh.id!) : "unknown";
    // Paid in the meantime (race with Stripe's own attempt): the update was applied after all.
    if (final === "paid") return { ok: true, invoice: summary(fresh) };
    return { ok: false, reason: "declined", invoiceId: fresh.id!, final };
  }
  return { ok: true, invoice: fresh ? summary(fresh) : null };
}

/** The invoice an add-on write just produced: a `subscription_update` invoice of this subscription. */
function isOurProrationInvoice(inv: Stripe.Invoice, subscriptionId: string) {
  if (inv.billing_reason !== "subscription_update") return false;
  const parentSub = (inv as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null }).parent?.subscription_details?.subscription;
  const legacySub = (inv as unknown as { subscription?: string | { id: string } | null }).subscription;
  const owner = idOf(parentSub ?? legacySub ?? null);
  return owner === null || owner === subscriptionId;
}

// ───────────────────── trial add-on charges: per-attempt ledger + reconciliation (0005) ─────────────────────

export type AddonChargeStatus = "pending" | "paid" | "applied" | "failed" | "refunded";
/**
 * One attempt to charge a trial add-on increase (table `addon_charge`, migration 0011). Written `pending` BEFORE any
 * Stripe call, so a crash at any point leaves a row that `reconcileAddonCharges` can settle:
 *   pending  → charge in flight (or the process died during it)
 *   paid     → money collected, add-on not yet confirmed applied
 *   applied  → done (terminal)       failed → nothing collected (terminal)       refunded → credit note issued (terminal)
 */
export interface AddonChargeRecord {
  id: string;
  orgId: string;
  subscriptionId: string;
  customerId: string;
  addon: string;
  priceId: string;
  fromQuantity: number;
  toQuantity: number;
  amount: number;
  currency: string;
  paymentMethod: string;
  status: AddonChargeStatus;
  invoiceId: string | null;
  creditNoteId: string | null;
  createdAt: Date;
}
export type NewAddonCharge = Omit<AddonChargeRecord, "orgId" | "status" | "invoiceId" | "creditNoteId" | "createdAt">;
export interface AddonChargeLedger {
  readonly orgId: string;
  insert(r: NewAddonCharge): Promise<void>;
  update(id: string, patch: { status?: AddonChargeStatus; invoiceId?: string | null; creditNoteId?: string | null; note?: string | null }): Promise<void>;
  /** Rows still `pending` or `paid` (optionally only those created before `createdBefore`). */
  unresolved(createdBefore?: Date): Promise<AddonChargeRecord[]>;
}

/** In-memory ledger (offline tests and the sandbox script). */
export function memoryAddonChargeLedger(orgId: string, clock: () => Date = () => new Date()): AddonChargeLedger & { rows: Map<string, AddonChargeRecord & { note?: string | null }> } {
  const rows = new Map<string, AddonChargeRecord & { note?: string | null }>();
  return {
    orgId,
    rows,
    async insert(r) {
      if (rows.has(r.id)) throw new Error(`duplicate addon_charge ${r.id}`);
      rows.set(r.id, { ...r, orgId, status: "pending", invoiceId: null, creditNoteId: null, createdAt: clock() });
    },
    async update(id, patch) {
      const r = rows.get(id);
      if (!r) throw new Error(`no addon_charge ${id}`);
      if (patch.invoiceId && [...rows.values()].some((x) => x.id !== id && x.invoiceId === patch.invoiceId)) throw new Error("duplicate invoice id");
      rows.set(id, { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as AddonChargeRecord);
    },
    async unresolved(createdBefore) {
      return [...rows.values()].filter((r) => (r.status === "pending" || r.status === "paid") && (!createdBefore || r.createdAt < createdBefore)).map((r) => ({ ...r }));
    },
  };
}

/** Stripe calls a refund needs. */
export interface RefundStripe {
  creditNotes?: {
    create(p: Stripe.CreditNoteCreateParams, o?: Stripe.RequestOptions): Promise<Stripe.CreditNote>;
    list(p: Stripe.CreditNoteListParams): Promise<Stripe.ApiList<Stripe.CreditNote>>;
  };
}

/**
 * Refund a trial add-on charge exactly once: a credit note on its invoice with a refund to the card, tagged
 * `flowops_addon_charge_id`. Before creating one, existing credit notes on the invoice are checked for that tag
 * (covers a refund whose DB update was lost), and the create uses an idempotency key per attempt, so two runs
 * can never refund twice. Returns the credit note id, or null if Stripe could not be reached (retry later).
 */
export async function refundAddonCharge(stripe: RefundStripe, rec: Pick<AddonChargeRecord, "id" | "invoiceId" | "amount">, amountPaid: number, why: string): Promise<string | null> {
  if (!stripe.creditNotes || !rec.invoiceId) return null;
  try {
    const existing = (await stripe.creditNotes.list({ invoice: rec.invoiceId, limit: 100 })).data.find((cn) => cn.metadata?.flowops_addon_charge_id === rec.id && cn.status !== "void");
    if (existing) return existing.id;
    const cn = await stripe.creditNotes.create(
      { invoice: rec.invoiceId, amount: amountPaid, refund_amount: amountPaid, memo: `Refund: ${why}`, metadata: { flowops_addon_charge_id: rec.id } },
      { idempotencyKey: `flowops-addon-refund-${rec.id}` },
    );
    return cn.id;
  } catch (err) {
    console.error("[billing] could not refund an add-on charge yet (the sweep retries)", rec.id, rec.invoiceId, err instanceof Error ? err.message : err);
    return null;
  }
}
