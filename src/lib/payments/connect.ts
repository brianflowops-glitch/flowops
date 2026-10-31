import "server-only";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb, schema } from "@/lib/db";

/**
 * Stripe Connect for payments at booking (behind BOOKING_PAYMENTS_ENABLED).
 *
 * Each business gets ONE connected account (Accounts v2) with the merchant configuration, its own full Stripe
 * Dashboard, and Stripe as fees + losses collector: the business is the merchant of record, customers' deposits are
 * direct charges on its account, refunds/disputes are its own, and FlowOps takes no application fee. Onboarding is
 * Stripe-hosted (Account Links). Requires Connect to be enabled on the platform account (dashboard step, Brian).
 */
export type ConnectRow = typeof schema.stripeConnectAccount.$inferSelect;
export type StripeLike = Pick<Stripe, "v2" | "checkout" | "refunds">;

export interface ConnectStatus {
  connected: boolean;
  accountId: string | null;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
}

export async function getConnectRow(orgId: string): Promise<ConnectRow | null> {
  const [row] = await getDb().select().from(schema.stripeConnectAccount).where(eq(schema.stripeConnectAccount.organizationId, orgId)).limit(1);
  return row ?? null;
}

export function statusOf(row: ConnectRow | null): ConnectStatus {
  return { connected: !!row, accountId: row?.stripeAccountId ?? null, chargesEnabled: !!row?.chargesEnabled, detailsSubmitted: !!row?.detailsSubmitted };
}

/** card_payments active → can take payments; no currently/past-due requirements → onboarding details are in. */
export function accountFlags(acct: Stripe.V2.Core.Account) {
  const chargesEnabled = acct.configuration?.merchant?.capabilities?.card_payments?.status === "active";
  const due = acct.requirements?.summary?.minimum_deadline?.status;
  const detailsSubmitted = due !== "currently_due" && due !== "past_due";
  return { chargesEnabled, detailsSubmitted };
}

/** Re-read the account from Stripe and cache its flags. */
export async function refreshConnectRow(row: ConnectRow, stripe: StripeLike): Promise<ConnectRow> {
  const acct = await stripe.v2.core.accounts.retrieve(row.stripeAccountId, { include: ["configuration.merchant", "requirements"] });
  const flags = accountFlags(acct);
  const [updated] = await getDb()
    .update(schema.stripeConnectAccount)
    .set({ ...flags, updatedAt: new Date() })
    .where(eq(schema.stripeConnectAccount.organizationId, row.organizationId))
    .returning();
  return updated ?? { ...row, ...flags };
}

/** The org's connected account, creating it on first use (idempotent per org). */
export async function ensureConnectAccount(org: { id: string; name: string }, contactEmail: string, stripe: StripeLike): Promise<ConnectRow> {
  const existing = await getConnectRow(org.id);
  if (existing) return existing;
  const acct = await stripe.v2.core.accounts.create(
    {
      display_name: org.name.slice(0, 80),
      contact_email: contactEmail,
      dashboard: "full",
      identity: { country: "us" },
      defaults: { currency: "usd", responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      metadata: { flowops_org_id: org.id },
      include: ["configuration.merchant", "requirements"],
    },
    { idempotencyKey: `flowops-connect-account-${org.id}` },
  );
  const flags = accountFlags(acct);
  await getDb()
    .insert(schema.stripeConnectAccount)
    .values({ organizationId: org.id, stripeAccountId: acct.id, ...flags })
    .onConflictDoNothing();
  return (await getConnectRow(org.id))!;
}

/** A Stripe-hosted onboarding (or update) link; single use, expires in minutes, so create it on click. */
export async function onboardingLink(row: ConnectRow, origin: string, stripe: StripeLike): Promise<string> {
  const back = `${origin}/admin?payments=return#payments`;
  const link = await stripe.v2.core.accountLinks.create({
    account: row.stripeAccountId,
    use_case: {
      type: row.detailsSubmitted && row.chargesEnabled ? "account_update" : "account_onboarding",
      ...(row.detailsSubmitted && row.chargesEnabled
        ? { account_update: { refresh_url: `${origin}/admin?payments=refresh#payments`, return_url: back } }
        : { account_onboarding: { refresh_url: `${origin}/admin?payments=refresh#payments`, return_url: back, collection_options: { fields: "eventually_due" } } }),
    },
  });
  return link.url;
}
