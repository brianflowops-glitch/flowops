// Applies Drizzle migrations in ./drizzle and seeds the demo org (idempotent).
//   npm run db:migrate            (reads DATABASE_URL; use dotenv: `npx dotenv -e .env.development.local -- npm run db:migrate`)
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { DEMO_ORG_ID, DEMO_ORG_SLUG, DEMO_SERVICES, defaultHours } from "../src/lib/tenancy/defaults";

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("migrations applied");

  await db
    .insert(schema.organization)
    .values({ id: DEMO_ORG_ID, slug: DEMO_ORG_SLUG, name: "FlowOps Demo", hours: defaultHours(), isDemo: true })
    .onConflictDoNothing();
  for (const [i, s] of DEMO_SERVICES.entries()) {
    await db
      .insert(schema.service)
      .values({ ...s, organizationId: DEMO_ORG_ID, sortOrder: i })
      .onConflictDoNothing();
  }
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from "user"`)).rows as { n: number }[];
  console.log(`demo org "${DEMO_ORG_SLUG}" ready · users in database: ${n}`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
