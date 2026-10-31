/**
 * Analytics → "Automations executed per week": counts come from existing rows only (audit_entry, notification),
 * are scoped to one organization, bucketed by Monday-start weeks in the org's time zone, and the route needs a session.
 * Runs against in-process PGlite with the real ./drizzle migrations; never a real database.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "@/lib/db";
import { initTestDb } from "./helpers/db";
import { memberOf, req, seedDemoOrg, signUp } from "./helpers/app";
import { defaultHours } from "@/lib/tenancy/defaults";
import { automationTrend } from "@/lib/server/analytics/automation-trend";
import * as route from "@/app/api/analytics/automations/route";

const ORG = "org-trend";
const OTHER = "org-trend-other";
// Wednesday 2030-06-12 15:00 New York (19:00Z). Current week starts Mon 2030-06-10.
const NOW = new Date("2030-06-12T19:00:00Z");
let seq = 0;

async function audit(org: string, at: string, over: Partial<typeof schema.auditEntry.$inferInsert> = {}) {
  await getDb().insert(schema.auditEntry).values({
    id: `AU-T-${++seq}`,
    organizationId: org,
    at: new Date(at),
    action: "create",
    bookingId: "BK-1",
    agent: "AuditAgent",
    outcome: "success",
    detail: "test",
    ...over,
  });
}
async function notif(org: string, at: string, over: Partial<typeof schema.notification.$inferInsert> = {}) {
  const id = `NT-T-${++seq}`;
  await getDb().insert(schema.notification).values({
    id,
    organizationId: org,
    at: new Date(at),
    bookingId: "BK-1",
    recipient: "pat@example.test",
    channel: "email",
    subject: "Reminder",
    deliveryStatus: "sent",
    dedupeKey: `reminder-${id}`,
    ...over,
  });
}

beforeAll(async () => {
  await initTestDb();
  await seedDemoOrg();
  const db = getDb();
  for (const id of [ORG, OTHER]) {
    await db.insert(schema.organization).values({ id, slug: id, name: id, hours: defaultHours(), timeZone: "America/New_York" });
  }
  // Current week (Mon 2030-06-10 NY): 2 runs (create + cancel) + 1 reminder sent.
  await audit(ORG, "2030-06-10T13:00:00Z");
  await audit(ORG, "2030-06-11T13:00:00Z", { action: "cancel" });
  await notif(ORG, "2030-06-11T14:00:00Z");
  // Sunday 2030-06-09 23:30 NY = Mon 03:30Z: belongs to the PREVIOUS week in New York.
  await audit(ORG, "2030-06-10T03:30:00Z", { action: "reschedule" });
  // Not automations: halted runs, post-save warnings, admin actions, unsent / non-reminder notifications.
  await audit(ORG, "2030-06-11T13:00:00Z", { agent: "AvailabilityAgent", outcome: "conflict" });
  await audit(ORG, "2030-06-11T13:00:00Z", { action: "agent_failure", agent: "CalendarAgent", outcome: "failed" });
  await audit(ORG, "2030-06-11T13:00:00Z", { outcome: "failed" });
  await audit(ORG, "2030-06-11T13:00:00Z", { action: "member.removed", agent: "TeamAdmin" });
  await notif(ORG, "2030-06-11T14:00:00Z", { deliveryStatus: "failed" });
  await notif(ORG, "2030-06-11T14:00:00Z", { deliveryStatus: "sending" });
  await notif(ORG, "2030-06-11T14:00:00Z", { dedupeKey: null }); // booking confirmation, part of a run
  // 11 weeks back (first bucket, Mon 2030-03-25) and 12 weeks back (outside the window).
  await audit(ORG, "2030-03-26T13:00:00Z");
  await audit(ORG, "2030-03-20T13:00:00Z");
  // Future rows are ignored.
  await audit(ORG, "2030-06-20T13:00:00Z");
  // Another org's rows never leak in.
  await audit(OTHER, "2030-06-11T13:00:00Z");
  await notif(OTHER, "2030-06-11T14:00:00Z");
});

describe("automationTrend", () => {
  it("returns 12 Monday-start weeks in the org's time zone, current week last", async () => {
    const t = await automationTrend({ id: ORG, timeZone: "America/New_York" }, { now: NOW });
    expect(t.weeks).toHaveLength(12);
    expect(t.weeks[0].weekStart).toBe("2030-03-25");
    expect(t.weeks[11].weekStart).toBe("2030-06-10");
    expect(t.timeZone).toBe("America/New_York");
  });

  it("counts completed booking runs and sent reminders only, scoped to the org", async () => {
    const t = await automationTrend({ id: ORG, timeZone: "America/New_York" }, { now: NOW });
    expect(t.weeks[11]).toEqual({ weekStart: "2030-06-10", bookingRuns: 2, reminders: 1, total: 3 });
    expect(t.weeks[10]).toEqual({ weekStart: "2030-06-03", bookingRuns: 1, reminders: 0, total: 1 });
    expect(t.weeks[0]).toEqual({ weekStart: "2030-03-25", bookingRuns: 1, reminders: 0, total: 1 });
    expect(t.total).toBe(5);
    const other = await automationTrend({ id: OTHER, timeZone: "America/New_York" }, { now: NOW });
    expect(other.total).toBe(2);
  });

  it("buckets by the org's zone (UTC puts the Sunday-night run in the current week)", async () => {
    const t = await automationTrend({ id: ORG, timeZone: "UTC" }, { now: NOW });
    expect(t.weeks[11].bookingRuns).toBe(3);
  });

  it("an org with no activity gets 12 zero weeks", async () => {
    const t = await automationTrend({ id: "org-flowops-demo-none", timeZone: "America/New_York" }, { now: NOW });
    expect(t.total).toBe(0);
    expect(t.weeks.every((w) => w.total === 0)).toBe(true);
  });

  it("falls back to UTC for an unknown zone name", async () => {
    const t = await automationTrend({ id: ORG, timeZone: "Not/AZone" }, { now: NOW });
    expect(t.timeZone).toBe("UTC");
    expect(t.weeks).toHaveLength(12);
  });
});

describe("GET /api/analytics/automations", () => {
  it("requires a session", async () => {
    expect((await route.GET(req("/api/analytics/automations"))).status).toBe(401);
  });

  it("returns only the signed-in user's org (empty for a new org)", async () => {
    const u = await signUp("owner@trend.test", { businessName: "Trend Co" });
    const orgId = (await memberOf(u.id)).organizationId;
    expect(orgId).not.toBe(ORG);
    const res = await route.GET(req("/api/analytics/automations", { cookie: u.cookie }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.weeks).toHaveLength(12);
    expect(body.total).toBe(0);
  });
});
