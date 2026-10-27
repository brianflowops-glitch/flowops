/**
 * Real local Postgres standing in for `@/lib/db` (opt-in: set TEST_DATABASE_URL).
 * Safety: only localhost URLs are accepted, a fresh throwaway database is created per test
 * file, the real ./drizzle migrations are applied, and the database is dropped afterwards.
 * Never point this at Neon / production.
 */
import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../../src/lib/db/schema";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || "";

/** Throws unless the URL points at a local Postgres (refuses anything that could be production). */
export function assertLocal(url: string) {
  const u = new URL(url);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) throw new Error(`TEST_DATABASE_URL must be a local Postgres (got host ${u.hostname})`);
  return u;
}

let pool: Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;
let dbName = "";

export async function initTestDb() {
  if (db) return db;
  const admin = assertLocal(TEST_DATABASE_URL);
  dbName = `flowops_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const c = new Client({ connectionString: admin.href });
  await c.connect();
  await c.query(`create database ${dbName}`);
  await c.end();
  const url = new URL(admin.href);
  url.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: url.href, max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

export async function closeTestDb() {
  if (!pool) return;
  await pool.end();
  pool = null;
  db = null;
  const c = new Client({ connectionString: assertLocal(TEST_DATABASE_URL).href });
  await c.connect();
  await c.query(`drop database if exists ${dbName} with (force)`);
  await c.end();
}

export function getDb() {
  if (!db) throw new Error("call initTestDb() first");
  return db;
}
export function getConn() {
  return { pool: pool!, db: getDb() };
}
export function hasDatabase() {
  return true;
}
export type Db = ReturnType<typeof getDb>;
export { schema };
