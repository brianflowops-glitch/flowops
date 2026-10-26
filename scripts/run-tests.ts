// Runs the FL-001…FL-008 simulation suite plus RT-001…RT-007 (notification retry) and WH-001…WH-003 (webhook signatures) unit tests in Node: `npm test`
import { TEST_CASES, runTest } from "../src/lib/booking/tests";
import { RETRY_TEST_CASES } from "../src/lib/server/integrations/retry.tests";
import { WEBHOOK_TEST_CASES } from "../src/lib/server/webhooks/webhooks.tests";

const ALL = [...TEST_CASES, ...RETRY_TEST_CASES, ...WEBHOOK_TEST_CASES];

(async () => {
  let failed = 0;
  for (const t of ALL) {
    const r = await runTest(t);
    if (!r.pass) failed++;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.name}  (${r.durationMs}ms)`);
    for (const a of r.assertions) console.log(`      ${a.pass ? "✓" : "✗"} ${a.label}${a.detail ? `  [${a.detail}]` : ""}`);
    if (r.error) console.log(`      error: ${r.error}`);
  }
  console.log(`\n${ALL.length - failed} passed, ${failed} failed (simulation only)`);
  process.exit(failed ? 1 : 0);
})();
