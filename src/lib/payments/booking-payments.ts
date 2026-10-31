import "server-only";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb, schema } from "@/lib/db";
import type { BookingRequest, PipelineResult } from "@/lib/booking/types";
import { holdSlot, runPipeline, type PipelineTx } from "@/lib/server/pipeline";
import { getConnectRow, type StripeLike } from "./connect";
import { HOLD_GRACE_MINUTES, HOLD_MINUTES, bookingPaymentsEnabled, formatCents, paymentDue, type PaymentDue } from "./rules";

/**
 * Payments at booking (BOOKING_PAYMENTS_ENABLED=true): hold the slot, take the deposit/payment in Stripe Checkout on
 * the business's connected account, and only then create the booking through the normal pipeline.
 *
 *   public book → holdSlot (dry run + hold row, under the org lock) → Checkout Session (direct charge) → checkoutUrl
 *   paid (Connect webhook, or the status poll) → confirmPaidHold → runPipeline create (hold excluded, marked paid in
 *     the same transaction) → the customer gets the normal confirmation. Slot taken meanwhile → `conflict` + refund.
 *   Checkout expired / cancelled → hold `expired`, slot free again. Unexpired `pending` holds block the slot.
 */
type Org = typeof schema.organization.$inferSelect;
type Service = typeof schema.service.$inferSelect;
export type Hold = typeof schema.bookingHold.$inferSelect;

const holdId = () => `hold_${crypto.randomUUID().replace(/-/g, "")}`;
/** Max open (unpaid, unexpired) holds per customer email per business: one checkout tab per slot is plenty. */
const MAX_OPEN_HOLDS_PER_EMAIL = 3;

/** The payment due for this service at this org right now, or null → book exactly as before. */
export async function paymentForService(orgId: string, svc: Service): Promise<{ due: PaymentDue; stripeAccountId: string } | null> {
  if (!bookingPaymentsEnabled()) return null;
  const due = paymentDue(svc);
  if (!due) return null;
  const acct = await getConnectRow(orgId);
  // Not onboarded (or payments restricted): bookings keep working without payment; the settings page says why.
  if (!acct?.chargesEnabled) return null;
  return { due, stripeAccountId: acct.stripeAccountId };
}

export type StartResult =
  | { kind: "checkout"; hold: Hold; checkoutUrl: string }
  | { kind: "rejected"; result: PipelineResult }
  | { kind: "error"; status: number; error: string };

export async function startPaidBooking(
  org: Org,
  svc: Service,
  req: BookingRequest,
  pay: { due: PaymentDue; stripeAccountId: string },
  opts: { origin: string; stripe: StripeLike; now?: Date },
): Promise<StartResult> {
  const db = getDb();
  const now = opts.now ?? new Date();
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(schema.bookingHold)
    .where(
      and(
        eq(schema.bookingHold.organizationId, org.id),
        eq(schema.bookingHold.status, "pending"),
        gt(schema.bookingHold.expiresAt, now),
        sql`lower(${schema.bookingHold.request}->>'email') = ${req.email.toLowerCase()}`,
      ),
    );
  if (open >= MAX_OPEN_HOLDS_PER_EMAIL) return { kind: "error", status: 429, error: "You already have bookings waiting for payment — finish or cancel those first." };

  const sessionExpires = Math.floor(now.getTime() / 1000) + HOLD_MINUTES * 60;
  const id = holdId();
  const values = {
    id,
    organizationId: org.id,
    serviceId: svc.id,
    request: req as unknown as Record<string, unknown>,
    resource: req.resource,
    date: req.date,
    time: req.time,
    durationMin: req.durationMin,
    amountCents: pay.due.amountCents,
    currency: pay.due.currency,
    paymentMode: svc.paymentMode,
    stripeAccountId: pay.stripeAccountId,
    status: "pending" as const,
    expiresAt: new Date((sessionExpires + HOLD_GRACE_MINUTES * 60) * 1000),
  };
  const check = await holdSlot(org, req, async (tx) => {
    await tx.insert(schema.bookingHold).values(values);
  });
  if (!check.ok) return { kind: "rejected", result: check };

  const back = `${opts.origin}/book/${org.slug}`;
  const what = pay.due.kind === "full" ? svc.name : `Deposit: ${svc.name}`;
  try {
    const session = await opts.stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: pay.due.currency,
              unit_amount: pay.due.amountCents,
              product_data: { name: what.slice(0, 120), description: `${org.name} · ${req.date} ${req.time}`.slice(0, 300) },
            },
          },
        ],
        customer_email: req.email,
        client_reference_id: id,
        metadata: { flowops_hold_id: id, flowops_org_id: org.id },
        payment_intent_data: { metadata: { flowops_hold_id: id, flowops_org_id: org.id }, description: `${what} — ${req.date} ${req.time}`.slice(0, 300) },
        expires_at: sessionExpires,
        success_url: `${back}?payment=success&hold=${id}`,
        cancel_url: `${back}?payment=cancelled&hold=${id}`,
      },
      { stripeAccount: pay.stripeAccountId, idempotencyKey: `flowops-hold-checkout-${id}` },
    );
    const [hold] = await db
      .update(schema.bookingHold)
      .set({ checkoutSessionId: session.id, updatedAt: new Date() })
      .where(eq(schema.bookingHold.id, id))
      .returning();
    if (!session.url) throw new Error("Checkout session has no url");
    return { kind: "checkout", hold, checkoutUrl: session.url };
  } catch (err) {
    // Free the slot right away; nothing was charged.
    await db.update(schema.bookingHold).set({ status: "expired", note: "checkout_create_failed", updatedAt: new Date() }).where(eq(schema.bookingHold.id, id));
    console.error("[payments] Checkout create failed", { org: org.id, hold: id, err: err instanceof Error ? err.message : "unknown" });
    return { kind: "error", status: 502, error: "We couldn't start the payment — please try again, or contact the business." };
  }
}

export async function getHold(id: string): Promise<Hold | null> {
  const [h] = await getDb().select().from(schema.bookingHold).where(eq(schema.bookingHold.id, id)).limit(1);
  return h ?? null;
}

class HoldSettled extends Error {}

export type ConfirmOutcome =
  | { status: "booked"; bookingId: string }
  | { status: "already"; hold: Hold }
  | { status: "conflict"; refunded: boolean }
  | { status: "ignored"; reason: string };

/**
 * A paid Checkout session → the booking. Idempotent and safe to call concurrently (webhook retries, the customer's
 * status poll): the hold is re-checked under the org lock and marked `paid` in the booking's own transaction.
 * If the slot can no longer be booked (taken, or now in the past) the payment is refunded once on the connected
 * account (idempotency key per hold) and the hold becomes `conflict`.
 */
export async function confirmPaidHold(
  hold: Hold,
  session: Pick<Stripe.Checkout.Session, "id" | "payment_status" | "payment_intent">,
  deps: { stripe: StripeLike },
): Promise<ConfirmOutcome> {
  if (session.payment_status !== "paid") return { status: "ignored", reason: "not_paid" };
  if (hold.checkoutSessionId && hold.checkoutSessionId !== session.id) return { status: "ignored", reason: "session_mismatch" };
  if (hold.status === "paid" || hold.status === "conflict") return { status: "already", hold };
  const [org] = await getDb().select().from(schema.organization).where(eq(schema.organization.id, hold.organizationId)).limit(1);
  if (!org) return { status: "ignored", reason: "no_org" };
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  const req = hold.request as unknown as BookingRequest;

  let result: PipelineResult;
  try {
    result = await runPipeline(
      org,
      { action: "create", req },
      {
        actor: `public:${String(req.email).toLowerCase()}`,
        source: "public",
        hold: {
          id: hold.id,
          before: async (tx: PipelineTx) => {
            const [cur] = await tx.select({ status: schema.bookingHold.status }).from(schema.bookingHold).where(eq(schema.bookingHold.id, hold.id)).for("update");
            if (!cur || cur.status === "paid" || cur.status === "conflict") throw new HoldSettled();
          },
          after: async (tx, booking) => {
            await tx
              .update(schema.bookingHold)
              .set({ status: "paid", bookingId: booking.id, paymentIntentId, checkoutSessionId: session.id, updatedAt: new Date() })
              .where(eq(schema.bookingHold.id, hold.id));
          },
        },
      },
    );
  } catch (err) {
    if (err instanceof HoldSettled) return { status: "already", hold: (await getHold(hold.id)) ?? hold };
    throw err;
  }
  if (result.ok && result.booking) return { status: "booked", bookingId: result.booking.id };

  // Paid but can't be booked: refund (once), free nothing (the slot belongs to whoever has it).
  const [claimed] = await getDb()
    .update(schema.bookingHold)
    .set({ status: "conflict", paymentIntentId, note: (result.error ?? result.outcome).slice(0, 300), updatedAt: new Date() })
    .where(and(eq(schema.bookingHold.id, hold.id), inArray(schema.bookingHold.status, ["pending", "expired"])))
    .returning();
  if (!claimed || !paymentIntentId) return { status: "conflict", refunded: false };
  try {
    await deps.stripe.refunds.create(
      { payment_intent: paymentIntentId, reason: "requested_by_customer", metadata: { flowops_hold_id: hold.id, flowops_reason: "slot_unavailable" } },
      { stripeAccount: hold.stripeAccountId, idempotencyKey: `flowops-hold-refund-${hold.id}` },
    );
    return { status: "conflict", refunded: true };
  } catch (err) {
    await getDb().update(schema.bookingHold).set({ note: "refund_failed: refund manually in Stripe" }).where(eq(schema.bookingHold.id, hold.id));
    console.error("[payments] refund after conflict FAILED — refund manually", { hold: hold.id, account: hold.stripeAccountId, err: err instanceof Error ? err.message : "unknown" });
    return { status: "conflict", refunded: false };
  }
}

/** Checkout expired / cancelled / async payment failed → free the slot (only a still-pending hold). */
export async function expireHold(id: string, note: string) {
  const [h] = await getDb()
    .update(schema.bookingHold)
    .set({ status: "expired", note, updatedAt: new Date() })
    .where(and(eq(schema.bookingHold.id, id), eq(schema.bookingHold.status, "pending")))
    .returning();
  return h ?? null;
}

/**
 * The customer came back via the cancel link: expire the Checkout session on Stripe first (so it can't be paid
 * later), then free the slot. If Stripe says the session is already complete, leave the hold for confirmation.
 */
export async function releaseHold(hold: Hold, stripe: StripeLike): Promise<Hold> {
  if (hold.status !== "pending") return hold;
  if (hold.checkoutSessionId) {
    try {
      await stripe.checkout.sessions.expire(hold.checkoutSessionId, {}, { stripeAccount: hold.stripeAccountId });
    } catch {
      const s = await stripe.checkout.sessions.retrieve(hold.checkoutSessionId, {}, { stripeAccount: hold.stripeAccountId }).catch(() => null);
      if (!s || s.status === "complete") return hold; // paid (or unknown): don't free a slot that may be paid for
    }
  }
  return (await expireHold(hold.id, "released_by_customer")) ?? ((await getHold(hold.id)) ?? hold);
}

/**
 * Status poll from the booking page after Checkout. A pending hold is checked against Stripe so a slow or missing
 * webhook never strands a paid customer: a paid session is confirmed right here (same idempotent path).
 */
export async function pollHold(hold: Hold, stripe: StripeLike): Promise<Hold> {
  if (hold.status !== "pending" || !hold.checkoutSessionId) return hold;
  const s = await stripe.checkout.sessions.retrieve(hold.checkoutSessionId, {}, { stripeAccount: hold.stripeAccountId }).catch(() => null);
  if (!s) return hold;
  if (s.status === "complete" && s.payment_status === "paid") await confirmPaidHold(hold, s, { stripe });
  else if (s.status === "expired") await expireHold(hold.id, "checkout_expired");
  return (await getHold(hold.id)) ?? hold;
}

/** Public view of a hold (no other customers' data; the hold id itself is the unguessable capability). */
export async function holdView(hold: Hold) {
  let booking: { id: string; service: string; date: string; time: string; durationMin: number } | null = null;
  if (hold.bookingId) {
    const [b] = await getDb().select().from(schema.booking).where(eq(schema.booking.id, hold.bookingId)).limit(1);
    if (b) booking = { id: b.id, service: b.service, date: b.date, time: b.time, durationMin: b.durationMin };
  }
  const req = hold.request as unknown as BookingRequest;
  return {
    id: hold.id,
    status: hold.status,
    service: req.service,
    date: hold.date,
    time: hold.time,
    amount: formatCents(hold.amountCents, hold.currency),
    expiresAt: hold.expiresAt.toISOString(),
    booking,
  };
}
