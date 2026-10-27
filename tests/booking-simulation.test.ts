import { describe, expect, it } from "vitest";
import { TEST_CASES, runTest } from "@/lib/booking/tests";

/** The in-memory FL-00x pipeline simulation suite (also runnable alone via `npm run test:sim`). */
describe("booking engine simulation (FL-00x)", () => {
  it.each(TEST_CASES.map((t) => [t.id, t] as const))("%s", async (_id, t) => {
    const r = await runTest(t);
    const failed = r.assertions.filter((a) => !a.pass).map((a) => `${a.label}${a.detail ? ` [${a.detail}]` : ""}`);
    expect(r.error ?? null, `${t.id} ${t.name}`).toBeNull();
    expect(failed, `${t.id} ${t.name}`).toEqual([]);
    expect(r.pass).toBe(true);
  });
});
