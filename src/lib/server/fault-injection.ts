import type { Role } from "@/lib/server/context";

/**
 * Fault injection (`failAgent`) makes a pipeline agent throw on purpose, to exercise failure
 * handling. It is a test/dev tool: it is never honored in production.
 *
 * Allowed when NODE_ENV is not "production" (local dev, tests), or on a non-production Vercel
 * deployment (preview/development) that explicitly sets FLOWOPS_ENABLE_FAULT_INJECTION=true.
 * On the production deployment (VERCEL_ENV=production) it is always off, whatever the flag says.
 */
export function faultInjectionEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV === "production") return false;
  if (env.NODE_ENV !== "production") return true;
  return env.FLOWOPS_ENABLE_FAULT_INJECTION?.trim().toLowerCase() === "true";
}

/** Only Owners/Admins may inject faults, and only where fault injection is enabled. */
export function canInjectFaults(role: Role, env: NodeJS.ProcessEnv = process.env) {
  return (role === "owner" || role === "admin") && faultInjectionEnabled(env);
}
