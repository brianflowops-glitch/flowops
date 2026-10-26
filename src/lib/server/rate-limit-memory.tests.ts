/** In-memory rate-limit fallback tests (RL-001). */
import type { Assertion, TestCase } from "@/lib/booking/tests";
import { MemoryRateLimiter } from "./rate-limit-memory";

const check = (label: string, pass: boolean, detail?: string): Assertion => ({ label, pass, detail });

export const RATE_LIMIT_TEST_CASES: TestCase[] = [
  {
    id: "RL-001",
    name: "In-memory fallback limiter (DB outage)",
    description: "Enforces max per window, reports Retry-After, resets after the window, keys are independent.",
    run: async () => {
      const m = new MemoryRateLimiter();
      const t = 1_000_000;
      const r = [1, 2, 3].map((i) => m.check("ai:user:u1", 2, 60, t + i));
      const other = m.check("ai:user:u2", 2, 60, t + 4);
      const later = m.check("ai:user:u1", 2, 60, t + 61_000);
      return [
        check("first 2 allowed, 3rd blocked", r[0].ok && r[1].ok && !r[2].ok, JSON.stringify(r)),
        check("retryAfter ≈ window remaining", r[2].retryAfter === 60, String(r[2].retryAfter)),
        check("other key independent", other.ok),
        check("resets after window", later.ok),
      ];
    },
  },
];
