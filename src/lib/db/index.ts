import "server-only";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema";

/**
 * Lazily-created Postgres pool (DATABASE_URL from the Neon Marketplace integration: the POOLED PgBouncer URL,
 * transaction mode). Lazy so `next build` never needs the database.
 * `connectionTimeoutMillis`: a request that can't get a connection fails fast (pg-pool "timeout exceeded when trying
 * to connect", see `isPoolTimeout`) instead of hanging the function until it is killed.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — provision Postgres (Neon) and run `vercel env pull`.");
  const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
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

/** True for pg-pool's "no free connection within connectionTimeoutMillis" error (→ the caller answers 503). */
export function isPoolTimeout(err: unknown) {
  return err instanceof Error && /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(err.message);
}

// ── Session connections (0006): ONE dedicated connection for work that needs a real Postgres session ──

/**
 * One checked-out connection with its own Drizzle handle. Every statement on it autocommits unless the caller opens a
 * transaction. `release(true)` destroys the connection (Postgres then drops any session lock it held).
 */
export type SessionClient = {
  db: Db;
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  release(destroy?: boolean): void;
};

/**
 * Session-level features (pg_advisory_lock) do NOT work through Neon's pooled DATABASE_URL: Neon's PgBouncer runs in
 * TRANSACTION mode, so consecutive statements of one client may land on different server connections and a session
 * lock would be taken on one backend and "released" on another (it would leak). This pool therefore connects DIRECT:
 * DATABASE_URL_UNPOOLED (set by the Neon integration next to DATABASE_URL). Without it, DATABASE_URL is used only if
 * it is not a Neon pooler host (`-pooler.`, e.g. local Postgres); otherwise we refuse (fail closed, callers → 503).
 * Small (max 3) and only used by the add-on change route and its cron sweep, so direct connections stay few.
 */
export const SESSION_POOL_MAX = 3;
export const SESSION_CONNECTION_TIMEOUT_MS = 5_000;
/** Server-side backstop: a session idle this long (e.g. a frozen/killed function holding a lock) is terminated by Postgres. */
export const SESSION_IDLE_TIMEOUT = "120s";

export function sessionDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const direct = env.DATABASE_URL_UNPOOLED?.trim();
  if (direct) return direct;
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* not a URL (e.g. pglite://): fall through */
  }
  if (/-pooler\./i.test(host)) throw new Error("DATABASE_URL_UNPOOLED is required: the pooled (PgBouncer transaction mode) DATABASE_URL can't hold a session advisory lock");
  return url;
}

let _session: Pool | null = null;
export function getSessionPool() {
  if (!_session) {
    const pool = new Pool({
      connectionString: sessionDatabaseUrl(),
      max: SESSION_POOL_MAX,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: SESSION_CONNECTION_TIMEOUT_MS,
    });
    pool.on("connect", (c) => {
      c.query(`set idle_session_timeout = '${SESSION_IDLE_TIMEOUT}'`).catch(() => undefined); // PG14+; a no-op elsewhere
    });
    pool.on("error", (e) => console.error("[db] idle session connection error", e.message)); // e.g. idle_session_timeout fired
    attachDatabasePool(pool);
    _session = pool;
  }
  return _session;
}

/** Check out one session connection (throws a pool timeout after SESSION_CONNECTION_TIMEOUT_MS). */
export async function connectSession(): Promise<SessionClient> {
  const client: PoolClient = await getSessionPool().connect();
  return {
    db: drizzle(client, { schema }) as unknown as Db,
    query: (text, params) => client.query(text, params as unknown[]) as never,
    release: (destroy) => client.release(destroy ? true : undefined),
  };
}
