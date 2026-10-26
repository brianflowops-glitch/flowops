import { vi } from "vitest";

// Route every `@/lib/db` import to the in-process PGlite database (never a real DB).
vi.mock("@/lib/db", async () => await import("./db"));

// Safety net: tests must never reach the network (Resend, Twilio, Google, AI Gateway…).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return realFetch(input, init);
  throw new Error(`Network access is blocked in tests: ${url}`);
}) as typeof fetch;
