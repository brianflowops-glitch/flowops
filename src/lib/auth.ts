import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { APIError } from "better-auth/api";
import { getDb, schema } from "@/lib/db";
import { ensureMembership } from "@/lib/tenancy/membership";
import { findUsableInvite } from "@/lib/tenancy/invites";
import { emailVerificationRequired, resendConfigured, sendAccountEmail } from "@/lib/server/integrations/notify";

/** Invite token sent with sign-up from /invite/[token] (not a user column). */
function inviteTokenFrom(ctx: { body?: unknown } | null | undefined) {
  const t = (ctx?.body as { inviteToken?: unknown } | undefined)?.inviteToken;
  return typeof t === "string" && t.length > 0 ? t : null;
}

function trustedOrigins() {
  const list = ["https://flowopsagent.ai", "https://www.flowopsagent.ai", "https://flowops-blue.vercel.app"];
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
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      autoSignIn: true,
      // Off by default; REQUIRE_EMAIL_VERIFICATION=true only takes effect once Resend is configured.
      requireEmailVerification: emailVerificationRequired(),
      resetPasswordTokenExpiresIn: 60 * 60, // 1 hour (emailed links)
      revokeSessionsOnPasswordReset: true,
      // Same response whether or not the email exists (Better Auth). While email is simulated
      // the link is dropped: not sent, not logged. Owners/Admins can generate one instead.
      sendResetPassword: async ({ user, url }) => {
        await sendAccountEmail(
          user.email,
          "Reset your FlowOps password",
          `Hi ${user.name || "there"},\n\nSomeone asked to reset the password for your FlowOps account. Open this link within 1 hour to choose a new one:\n\n${url}\n\nIf you didn't ask, ignore this email — your password stays the same.\n\n— FlowOps`,
        );
      },
    },
    emailVerification: {
      sendOnSignUp: resendConfigured(),
      sendOnSignIn: emailVerificationRequired(),
      autoSignInAfterVerification: true,
      expiresIn: 24 * 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAccountEmail(
          user.email,
          "Verify your FlowOps email",
          `Hi ${user.name || "there"},\n\nConfirm this is your email address for FlowOps by opening this link (valid 24 hours):\n\n${url}\n\n— FlowOps`,
        );
      },
    },
    user: {
      additionalFields: {
        // Optional business name typed at sign-up; used to name a new organization.
        businessName: { type: "string", required: false, input: true, returned: false },
      },
    },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    // Per-IP limits stored in Postgres (works across serverless instances). Defaults already cap
    // /sign-in/* and /sign-up/* at 3 per 10 s and reset/verification emails at 3 per minute;
    // account creation is additionally capped at 5 per 10 minutes per IP.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-up/*": { window: 600, max: 5 },
        "/sign-in/*": { window: 60, max: 10 },
      },
    },
    // Vercel sets x-vercel-forwarded-for / x-real-ip to the real client IP.
    advanced: { ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"] } },
    trustedOrigins: trustedOrigins(),
    databaseHooks: {
      user: {
        create: {
          before: async (u, ctx) => {
            // Signing up from an invite link: the token must be usable and for this exact email.
            const token = inviteTokenFrom(ctx);
            if (token && !(await findUsableInvite(token, u.email)))
              throw new APIError("BAD_REQUEST", { message: "This invite link is invalid, expired, already used, or for a different email." });
          },
          after: async (u, ctx) => {
            const businessName = (u as { businessName?: string | null }).businessName ?? null;
            await ensureMembership({ id: u.id, email: u.email, name: u.name, businessName, inviteToken: inviteTokenFrom(ctx) });
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
