import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb, schema } from "@/lib/db";
import { ensureMembership } from "@/lib/tenancy/membership";

function trustedOrigins() {
  const list = ["https://flowopsagent.ai", "https://www.flowopsagent.ai"];
  if (process.env.VERCEL_URL) list.push(`https://${process.env.VERCEL_URL}`);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) list.push(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  if (process.env.VERCEL_BRANCH_URL) list.push(`https://${process.env.VERCEL_BRANCH_URL}`);
  if (process.env.NODE_ENV !== "production") list.push("http://localhost:3000");
  return list;
}

function createAuth() {
  return betterAuth({
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
    user: {
      additionalFields: {
        // Optional business name typed at sign-up; used to name a new organization.
        businessName: { type: "string", required: false, input: true, returned: false },
      },
    },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    trustedOrigins: trustedOrigins(),
    databaseHooks: {
      user: {
        create: {
          after: async (u) => {
            const businessName = (u as { businessName?: string | null }).businessName ?? null;
            await ensureMembership({ id: u.id, email: u.email, name: u.name, businessName });
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let _auth: Auth | null = null;
/** Lazily constructed so `next build` doesn't need DATABASE_URL / BETTER_AUTH_SECRET. */
export function getAuth(): Auth {
  if (!_auth) _auth = createAuth();
  return _auth;
}
