import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema";

/**
 * Lazily-created Postgres pool (DATABASE_URL from the Neon Marketplace integration).
 * Lazy so `next build` never needs the database.
 */
function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — provision Postgres (Neon) and run `vercel env pull`.");
  const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
  });
  attachDatabasePool(pool);
  return { pool, db: drizzle(pool, { schema }) };
}

let _conn: ReturnType<typeof create> | null = null;

export function getConn() {
  if (!_conn) _conn = create();
  return _conn;
}
export function getDb() {
  return getConn().db;
}
export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}
export type Db = ReturnType<typeof getDb>;
export { schema };
