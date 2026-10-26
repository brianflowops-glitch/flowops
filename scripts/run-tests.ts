// Runs the FL-001…FL-007 simulation suite in Node: `npm test`
import { TEST_CASES, runTest } from "../src/lib/booking/tests";

(async () => {
  let failed = 0;
  for (const t of TEST_CASES) {
    const r = await runTest(t);
    if (!r.pass) failed++;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.name}  (${r.durationMs}ms)`);
    for (const a of r.assertions) console.log(`      ${a.pass ? "✓" : "✗"} ${a.label}${a.detail ? `  [${a.detail}]` : ""}`);
    if (r.error) console.log(`      error: ${r.error}`);
  }
  console.log(`\n${TEST_CASES.length - failed} passed, ${failed} failed (simulation only)`);
  process.exit(failed ? 1 : 0);
})();
