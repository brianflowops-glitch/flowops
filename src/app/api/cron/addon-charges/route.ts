import { timingSafeEqual } from "node:crypto";
import { billingConfigured, billingEnabled } from "@/lib/billing/config";
import { billingExemptOrgIds } from "@/lib/billing/access-rules";
import { sweepAddonCharges } from "@/lib/billing/addon-charges-db";
import { getStripe } from "@/lib/billing/stripe";
import { getDb } from "@/lib/db";
import { DEMO_ORG_ID } from "@/lib/tenancy/defaults";

/**
 * Daily sweep of trial add-on charge attempts left `pending` / `paid` by a crash (docs/BILLING.md §11, 0006).
 * Vercel Cron calls it with GET and `Authorization: Bearer ${CRON_SECRET}` (vercel.json: once a day, which the Hobby
 * plan allows; Hobby runs it at some minute within the scheduled hour). Same auth as /api/cron/notifications:
 * fails closed, 503 when CRON_SECRET is unset, 401 on mismatch (constant-time compare).
 * BILLING_ENABLED off → 200 no-op (nothing read or written). Demo / exempt orgs (org_flowops_demo +
 * BILLING_EXEMPT_ORG_IDS) are never touched. Each org is settled under its add-on lock; busy orgs are skipped and
 * retried next run (a live request settles them anyway). Idempotent.
 */
export const maxDuration = 60;
/** Stop starting new orgs after this long, so the run finishes inside maxDuration; the rest waits for the next run. */
const BUDGET_MS = 45_000;

function authorized(req: Request, secret: string) {
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return new Response("Not configured", { status: 503 });
  if (!authorized(req, secret)) return new Response("Unauthorized", { status: 401 });
  if (!billingEnabled()) return Response.json({ skipped: "billing_disabled" });
  if (!billingConfigured()) return Response.json({ skipped: "billing_not_configured" });
  try {
    const skipOrgIds = new Set([DEMO_ORG_ID, ...billingExemptOrgIds()]);
    const results = await sweepAddonCharges(getDb(), getStripe(), { skipOrgIds, deadline: Date.now() + BUDGET_MS });
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const settled = results.filter((r) => r.id !== "*" && r.status !== "pending" && r.status !== "paid" && r.status !== "error").length;
    if (results.length) console.log(`[addon-charges] ${JSON.stringify(counts)}`);
    return Response.json({ orgs: new Set(results.map((r) => r.orgId)).size, settled, counts });
  } catch (e) {
    console.error(`[addon-charges] run failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
    return Response.json({ error: "sweep failed" }, { status: 500 });
  }
}
