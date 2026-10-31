import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb, schema, type Db } from "@/lib/db";
import { sendAccountEmail } from "@/lib/server/integrations/notify";
import { defaultPaymentMethod, trialEndingEmail } from "./trial-rules";

export interface TrialReminderDeps {
  db?: Db;
  stripe: Pick<Stripe, "subscriptions" | "customers">;
  send?: (to: string, subject: string, text: string) => Promise<{ sent: boolean; detail?: string }>;
  appUrl?: string;
}

export type TrialReminderOutcome =
  | { status: "sent"; recipients: number }
  | { status: "skipped"; reason: "not_trialing" | "has_payment_method" | "no_org" | "demo" | "no_recipients" };

/**
 * `customer.subscription.trial_will_end` (Stripe sends it 3 days before a trial ends): when the trial has NO card
 * yet, email the org's Owner(s) and Admin(s) a reminder to add one (Resend, the same account-email path as invites).
 * The webhook route calls this only after processStripeEvent recorded the event (stripe_event dedupe), so a repeated
 * delivery never re-sends. Best effort: a failed send is logged, never retried, and never fails the webhook.
 * Reads the CURRENT subscription (payload may be stale: the card may have been added since).
 */
export async function sendTrialEndingReminder(subscriptionId: string, deps: TrialReminderDeps): Promise<TrialReminderOutcome> {
  const db = deps.db ?? getDb();
  const sub = await deps.stripe.subscriptions.retrieve(subscriptionId);
  if (sub.status !== "trialing" || !sub.trial_end) return { status: "skipped", reason: "not_trialing" };
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const customer = await deps.stripe.customers.retrieve(customerId);
  if (defaultPaymentMethod(sub, customer)) return { status: "skipped", reason: "has_payment_method" };

  const [mapped] = await db.select({ orgId: schema.billingCustomer.organizationId }).from(schema.billingCustomer).where(eq(schema.billingCustomer.stripeCustomerId, customerId)).limit(1);
  const orgId = sub.metadata?.organizationId || mapped?.orgId;
  if (!orgId) return { status: "skipped", reason: "no_org" };
  const [org] = await db.select({ name: schema.organization.name, isDemo: schema.organization.isDemo }).from(schema.organization).where(eq(schema.organization.id, orgId)).limit(1);
  if (!org) return { status: "skipped", reason: "no_org" };
  if (org.isDemo) return { status: "skipped", reason: "demo" };

  const people = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, orgId), inArray(schema.member.role, ["owner", "admin"])));
  const to = [...new Set(people.map((p) => p.email.toLowerCase()))];
  if (!to.length) return { status: "skipped", reason: "no_recipients" };

  const mail = trialEndingEmail({ orgName: org.name, trialEnd: sub.trial_end, appUrl: deps.appUrl ?? process.env.BETTER_AUTH_URL ?? "https://flowopsagent.ai" });
  const send = deps.send ?? sendAccountEmail;
  for (const addr of to) {
    const r = await send(addr, mail.subject, mail.text).catch(() => ({ sent: false }));
    if (!r.sent) console.warn(`[billing] trial reminder not sent for org ${orgId}`);
  }
  return { status: "sent", recipients: to.length };
}
