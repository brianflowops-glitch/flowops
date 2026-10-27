/**
 * In-process Postgres (PGlite) standing in for `@/lib/db` in tests. The real Drizzle
 * migrations in ./drizzle are applied, so tests exercise the production schema without
 * ever touching Neon. A fresh database is created per test file.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/lib/db/schema";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let client: PGlite | null = null;
let db: TestDb | null = null;
let ready: Promise<void> | null = null;

function create() {
  client = new PGlite();
  db = drizzle(client, { schema });
  ready = migrate(db, { migrationsFolder: "./drizzle" });
}

/** Wait for migrations; call in beforeAll. */
export async function initTestDb() {
  if (!db) create();
  await ready;
  return db!;
}

export function getDb() {
  if (!db) create();
  // Cast: PGlite and node-postgres Drizzle databases share the same query API.
  return db as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema>;
}
export function getConn() {
  return { pool: client, db: getDb() };
}
export function hasDatabase() {
  return true;
}
export type Db = ReturnType<typeof getDb>;
/** Same as @/lib/db. */
export function isPoolTimeout(err: unknown) {
  return err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message);
}
/** PGlite has one session: the "session connection" is that session (advisory locks work, release is a no-op). */
export async function connectSession() {
  if (!db) create();
  await ready;
  return {
    db: getDb(),
    query: async (text: string, params?: unknown[]) => ({ rows: (await client!.query(text, params as unknown[])).rows as never[] }),
    release: () => undefined,
  };
}
export { schema };
