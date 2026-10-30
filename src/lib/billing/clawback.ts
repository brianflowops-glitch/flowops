import "server-only";
import type Stripe from "stripe";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/lib/db";
import { packDisputeState, packRevocation, type PackRevocation } from "./text-pack-rules";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Text-pack clawback (docs/BILLING.md §11, 0012): charge.refunded / charge.dispute.created / charge.dispute.closed
 * on the charge that paid a text-pack invoice revoke (or, for a won dispute, restore) the pack's texts.
 * The event is only a signal: Stripe's CURRENT state of the charge (amount_refunded, refunded, its disputes) is
 * fetched before the DB transaction (no network inside it) and the revocation is computed absolutely from it, so
 * repeated or out-of-order deliveries converge on the same result. The plan allowance is never touched and nothing
 * is ever charged.
 */
export const CLAWBACK_EVENTS = ["charge.refunded", "charge.dispute.created", "charge.dispute.closed"] as const;

/** What the webhook needs to know about a charge, read from Stripe before the transaction. */
export interface ChargeContext {
  chargeId: string;
  amount: number;
  amountRefunded: number;
  refunded: boolean;
  /** Invoices the charge paid (on this API version via InvoicePayments; Charge has no `invoice` field). */
  invoiceIds: string[];
  /** Statuses of all disputes of the charge. */
  disputeStatuses: string[];
}

export type ChargeContextFetcher = (chargeId: string) => Promise<ChargeContext>;

export interface ClawbackStripe {
  charges: { retrieve(id: string): Promise<Stripe.Charge> };
  invoicePayments: { list(p: Stripe.InvoicePaymentListParams): Promise<Stripe.ApiList<Stripe.InvoicePayment>> };
  disputes: { list(p: Stripe.DisputeListParams): Promise<Stripe.ApiList<Stripe.Dispute>> };
}

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.id);

/** The charge id a clawback event is about. */
export function chargeIdForEvent(event: Stripe.Event): string | null {
  if (event.type === "charge.refunded") return event.data.object.id;
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") return idOf(event.data.object.charge as string | { id: string });
  return null;
}

/** Real fetcher: the charge, the invoice(s) its PaymentIntent paid, and its disputes. */
export function stripeChargeContextFetcher(stripe: ClawbackStripe): ChargeContextFetcher {
  return async (chargeId) => {
    const charge = await stripe.charges.retrieve(chargeId);
    const pi = idOf(charge.payment_intent as string | { id: string } | null);
    const invoiceIds: string[] = [];
    if (pi) {
      const payments = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 10 });
      for (const p of payments.data) {
        const inv = idOf(p.invoice as string | { id: string } | null);
        if (inv && p.status === "paid" && !invoiceIds.includes(inv)) invoiceIds.push(inv);
      }
    }
    const disputes = charge.disputed ? (await stripe.disputes.list({ charge: chargeId, limit: 10 })).data : [];
    return { chargeId, amount: charge.amount, amountRefunded: charge.amount_refunded ?? 0, refunded: Boolean(charge.refunded), invoiceIds, disputeStatuses: disputes.map((d) => d.status) };
  };
}

export type ClawbackOutcome =
  | { status: "ignored"; reason: "not_a_text_pack" }
  | { status: "processed"; packId: string; organizationId: string; textsRevoked: number; textsRevokedBefore: number; textsUsedOverRevocation: number; reason: PackRevocation["reason"] };

/**
 * Apply a charge's current refund/dispute state to the text pack its invoice paid. Runs inside the webhook's
 * transaction (after the stripe_event dedupe insert). Locks the organization row first, like consumeTexts, so a
 * concurrent send can't draw texts that are being revoked. Charges that did not pay a text-pack invoice are ignored.
 */
export async function applyChargeClawback(tx: Tx, event: { id: string; type: string }, ctx: ChargeContext, now: Date = new Date()): Promise<ClawbackOutcome> {
  if (!ctx.invoiceIds.length) return { status: "ignored", reason: "not_a_text_pack" };
  const t = schema.textPack;
  const [found] = await tx.select({ id: t.id, organizationId: t.organizationId }).from(t).where(and(inArray(t.stripeInvoiceId, ctx.invoiceIds), eq(t.status, "paid"))).limit(1);
  if (!found) return { status: "ignored", reason: "not_a_text_pack" };
  await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, found.organizationId)).for("update");
  const [pack] = await tx.select().from(t).where(eq(t.id, found.id)).for("update");
  const total = pack.textsPerPack * pack.quantity;
  const expiresAt = pack.expiresAt ?? pack.periodEnd;
  const dispute = packDisputeState(ctx.disputeStatuses);
  const r = packRevocation({
    total,
    used: pack.textsUsed,
    revokedBefore: pack.textsRevoked,
    chargeAmount: ctx.amount,
    amountRefunded: ctx.amountRefunded,
    fullyRefunded: ctx.refunded,
    dispute,
    expired: expiresAt.getTime() <= now.getTime(),
  });
  const latestDispute = ctx.disputeStatuses.length ? ctx.disputeStatuses[0] : null;
  await tx
    .update(t)
    .set({
      textsRevoked: r.revoked,
      revokedAt: r.revoked > 0 ? (pack.revokedAt ?? now) : null,
      ...(r.reason ? { revokedReason: r.reason } : {}),
      stripeChargeId: ctx.chargeId,
      amountRefunded: ctx.amountRefunded,
      disputeStatus: latestDispute ?? pack.disputeStatus,
      updatedAt: now,
    })
    .where(eq(t.id, pack.id));
  await tx
    .insert(schema.textPackRevocation)
    .values({
      id: `tpr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      textPackId: pack.id,
      organizationId: pack.organizationId,
      stripeEventId: event.id,
      eventType: event.type,
      stripeChargeId: ctx.chargeId,
      reason: r.reason ?? pack.revokedReason,
      textsTotal: total,
      textsUsed: pack.textsUsed,
      textsRevokedBefore: pack.textsRevoked,
      textsRevokedAfter: r.revoked,
      textsUsedOverRevocation: r.usedOverRevocation,
      amountRefunded: ctx.amountRefunded,
      disputeStatus: latestDispute,
    })
    .onConflictDoNothing();
  // Structured log for Brian: texts already sent from a pack that is now refunded/disputed (not taken back, not charged).
  const line = { pack: pack.id, org: pack.organizationId, event: event.id, type: event.type, charge: ctx.chargeId, reason: r.reason ?? pack.revokedReason, total, used: pack.textsUsed, revokedBefore: pack.textsRevoked, revoked: r.revoked, usedOverRevocation: r.usedOverRevocation, amountRefunded: ctx.amountRefunded, chargeAmount: ctx.amount, dispute };
  if (r.usedOverRevocation > 0) console.warn("[billing] text pack clawback: texts already used", JSON.stringify(line));
  else if (r.revoked !== pack.textsRevoked) console.info("[billing] text pack clawback", JSON.stringify(line));
  return { status: "processed", packId: pack.id, organizationId: pack.organizationId, textsRevoked: r.revoked, textsRevokedBefore: pack.textsRevoked, textsUsedOverRevocation: r.usedOverRevocation, reason: r.reason ?? (pack.revokedReason as PackRevocation["reason"]) };
}

/** Revocation log rows of a pack, oldest first (support / Brian). */
export async function packRevocationLog(db: Pick<Db, "select">, packId: string) {
  return db.select().from(schema.textPackRevocation).where(eq(schema.textPackRevocation.textPackId, packId)).orderBy(schema.textPackRevocation.createdAt, sql`${schema.textPackRevocation.id}`);
}
