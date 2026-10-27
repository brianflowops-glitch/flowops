import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Unit + integration tests. Integration tests run the real route handlers, Better Auth and
 * Drizzle against an in-process PGlite Postgres (tests/helpers/db.ts) — they never connect
 * to Neon or any other real database.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: r("./src/") },
      // `server-only` throws outside a React Server bundle; it's a no-op marker for tests.
      { find: /^server-only$/, replacement: r("./tests/helpers/server-only.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file gets its own module graph (and so its own PGlite database).
    isolate: true,
    env: {
      // Dummy, test-only values. No real secrets are needed or read.
      BETTER_AUTH_SECRET: "test-secret-not-used-in-any-real-environment-0123456789",
      BETTER_AUTH_URL: "http://localhost:3000",
      DATABASE_URL: "pglite://in-memory-test-db",
      RESEND_API_KEY: "",
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      FLOWOPS_OWNER_EMAILS: "",
      REQUIRE_EMAIL_VERIFICATION: "",
    },
  },
});
