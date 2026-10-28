/**
 * Where the session-lock pool (billing add-on changes, docs/BILLING.md §11) connects. Pure (no `server-only`, no pg),
 * so the test stand-ins for `@/lib/db` can re-export it.
 */
export type Env = Record<string, string | undefined>;

/** Why the session pool can't work with this environment, or null if it can. */
export function sessionDbProblem(env: Env = process.env): string | null {
  if (env.DATABASE_URL_UNPOOLED?.trim()) return null;
  const url = env.DATABASE_URL?.trim();
  if (!url) return "DATABASE_URL is not set";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* not a URL (e.g. pglite://): fine */
  }
  if (/-pooler\./i.test(host)) return "DATABASE_URL_UNPOOLED is required: the pooled (PgBouncer transaction mode) DATABASE_URL can't hold a session advisory lock";
  return null;
}

/** DATABASE_URL_UNPOOLED if set; else DATABASE_URL unless it is a Neon `-pooler` host (then throws). */
export function sessionDatabaseUrl(env: Env = process.env): string {
  const problem = sessionDbProblem(env);
  if (problem) throw new Error(problem);
  return env.DATABASE_URL_UNPOOLED?.trim() || env.DATABASE_URL!.trim();
}
