import "server-only";
import { eq } from "drizzle-orm";
import { getDb, hasDatabase, schema } from "@/lib/db";

export async function orgBySlug(slug: string) {
  if (!hasDatabase()) return null;
  const [org] = await getDb().select().from(schema.organization).where(eq(schema.organization.slug, slug.toLowerCase())).limit(1);
  return org && org.publicBooking ? org : null;
}
