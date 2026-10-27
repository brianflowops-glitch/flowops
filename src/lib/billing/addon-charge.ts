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

/** Stripe's smallest chargeable USD amount; below it an invoice is not charged on the card (Stripe carries it to the customer balance). */
export const MIN_CHARGE_CENTS = 50;

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
  p: { customer: string; paymentMethod: string; amount: number; currency: string; description: string; metadata: Record<string, string>; idempotencyKey: string; period?: { start: number; end: number } },
): Promise<ChargeOutcome> {
  let invoiceId: string | null = null;
  try {
    const invoice = await stripe.invoices.create(
      { customer: p.customer, collection_method: "charge_automatically", auto_advance: false, pending_invoice_items_behavior: "exclude", default_payment_method: p.paymentMethod, description: p.description, metadata: p.metadata },
      { idempotencyKey: `${p.idempotencyKey}-invoice` },
    );
    invoiceId = invoice.id;
    if (invoice.status === "paid") return { ok: true, invoiceId, amountPaid: invoice.amount_paid, currency: invoice.currency };
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
 * paid: the invoice is voided, which also discards the pending update, so the extra quantity is never granted and
 * the invoice can't be paid later.
 */
export async function inspectProrationOutcome(
  stripe: { subscriptions: { retrieve(id: string, p?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription> }; invoices?: Pick<ChargeStripe["invoices"], "retrieve" | "voidInvoice" | "del"> },
  subscriptionId: string,
  before: string | null,
): Promise<{ ok: true; invoice: { id: string; amountPaid: number; currency: string; lines: { description: string | null; amount: number }[] } | null } | { ok: false; invoiceId: string | null; final: string }> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
  const latest = (sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null) as Stripe.Invoice | null;
  const fresh = latest && latest.id !== before ? latest : null;
  if (sub.pending_update) {
    const invoiceId = fresh?.id ?? idOf(sub.latest_invoice as string | { id: string } | null);
    const final = invoiceId && stripe.invoices ? await abandonInvoice({ invoices: stripe.invoices } as Pick<ChargeStripe, "invoices">, invoiceId) : "unknown";
    // Paid in the meantime (race with Stripe's own attempt): the update was applied after all.
    if (final === "paid") return { ok: true, invoice: fresh ? { id: fresh.id!, amountPaid: fresh.amount_paid, currency: fresh.currency, lines: (fresh.lines?.data ?? []).map((l) => ({ description: l.description, amount: l.amount })) } : null };
    return { ok: false, invoiceId, final };
  }
  return { ok: true, invoice: fresh ? { id: fresh.id!, amountPaid: fresh.amount_paid, currency: fresh.currency, lines: (fresh.lines?.data ?? []).map((l) => ({ description: l.description, amount: l.amount })) } : null };
}
