import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { OrgContext } from "@/lib/server/context";
import { getStripe } from "./stripe";

/** Existing Stripe customer for the org, or a new one (one customer per organization). */
export async function getOrCreateCustomer(ctx: OrgContext): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, ctx.org.id)).limit(1);
  if (existing) return existing.stripeCustomerId;
  const customer = await getStripe().customers.create(
    { name: ctx.org.name, email: ctx.user.email, metadata: { organizationId: ctx.org.id } },
    { idempotencyKey: `flowops-customer-${ctx.org.id}` },
  );
  await db.insert(schema.billingCustomer).values({ organizationId: ctx.org.id, stripeCustomerId: customer.id }).onConflictDoNothing();
  const [row] = await db.select().from(schema.billingCustomer).where(eq(schema.billingCustomer.organizationId, ctx.org.id)).limit(1);
  return row.stripeCustomerId;
}
