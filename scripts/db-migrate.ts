// Applies Drizzle migrations in ./drizzle and seeds the demo org (idempotent).
//   npm run db:migrate            (reads DATABASE_URL; use dotenv: `npx dotenv -e .env.development.local -- npm run db:migrate`)
//   MIGRATE_ONLY=1 skips the demo seed (use on production).
// Neon URLs use Neon's serverless driver (WebSocket over 443), which also works where port 5432 is blocked.
import { Pool as PgPool } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { DEMO_ORG_ID, DEMO_ORG_SLUG, DEMO_SERVICES, defaultHours } from "../src/lib/tenancy/defaults";

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const isNeon = /\.neon\.tech/.test(url) && process.env.DB_DRIVER !== "pg";
  let pool: PgPool | NeonPool;
  let db: ReturnType<typeof drizzlePg<typeof schema>>;
  if (isNeon) {
    neonConfig.webSocketConstructor = ws;
    const p = new NeonPool({ connectionString: url, max: 1 });
    pool = p;
    const d = drizzleNeon(p, { schema });
    await migrateNeon(d, { migrationsFolder: "./drizzle" });
    db = d as unknown as typeof db;
  } else {
    const p = new PgPool({ connectionString: url, max: 1 });
    pool = p;
    db = drizzlePg(p, { schema });
    await migratePg(db, { migrationsFolder: "./drizzle" });
  }
  console.log("migrations applied");
  if (process.env.MIGRATE_ONLY === "1") {
    // Schema only — never re-seed demo rows into a live database.
    await pool.end();
    return;
  }

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
