/**
 * Booking side effects run only after the booking transaction commits (real local Postgres).
 * Resend / Twilio / Google Calendar adapters are mocks; nothing leaves the box.
 * Skipped unless TEST_DATABASE_URL points at a local Postgres (CI provides one).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Booking } from "@/lib/booking/types";

const fx = vi.hoisted(() => ({
  calendar: {
    label: "Google Calendar (mock)",
    create: vi.fn<(b: Booking) => Promise<string>>(),
    update: vi.fn<(b: Booking) => Promise<string>>(),
    remove: vi.fn<(id: string) => Promise<void>>(),
  },
  notifier: {
    channels: { email: true, sms: true },
    send: vi.fn<(b: Booking, subject: string, body: string, channel: "email" | "sms") => Promise<{ ok: boolean; detail?: string }>>(),
  },
}));

vi.mock("@/lib/db", async () => await import("./helpers/pg"));
vi.mock("@/lib/server/integrations/google", async (orig) => ({ ...(await orig<object>()), googleCalendarAdapter: () => fx.calendar }));
vi.mock("@/lib/server/integrations/notify", async (orig) => ({ ...(await orig<object>()), notifierAdapter: () => fx.notifier }));

import { TEST_DATABASE_URL, closeTestDb, initTestDb } from "./helpers/pg";
import { getDb, schema } from "@/lib/db";
import { runPipeline } from "@/lib/server/pipeline";
import { seedDemoOrg, futureWeekday } from "./helpers/app";
import { DEMO_ORG_ID } from "@/lib/tenancy/defaults";

type Org = typeof schema.organization.$inferSelect;
const ctx = { actor: "test@flowops.test", source: "dashboard" as const };
let org: Org;
let slot = 0;
const request = (over: Partial<{ phone: string; smsConsent: boolean }> = {}) => ({
  customer: "Pat Example",
  email: "pat@example.test",
  category: "appointment" as const,
  service: "Consultation",
  resource: "Room A",
  date: futureWeekday(10 + slot),
  time: `${String(9 + (slot++ % 6)).padStart(2, "0")}:00`,
  durationMin: 60,
  ...over,
});
const bookingRow = async (id: string) => (await getDb().select().from(schema.booking).where(eq(schema.booking.id, id)))[0];
const notificationRows = (bookingId: string) => getDb().select().from(schema.notification).where(eq(schema.notification.bookingId, bookingId));
const adapterCalls = () => fx.calendar.create.mock.calls.length + fx.calendar.update.mock.calls.length + fx.calendar.remove.mock.calls.length + fx.notifier.send.mock.calls.length;

describe.skipIf(!TEST_DATABASE_URL)("booking side effects (real Postgres)", () => {
  beforeAll(async () => {
    await initTestDb();
    // Prove this is the real local Postgres server, not PGlite.
    const { rows } = await getDb().execute(sql`select current_setting('port') as port, version() as v`);
    expect(String((rows[0] as { port: string }).port)).toBe(new URL(TEST_DATABASE_URL).port || "5432");
    await seedDemoOrg();
    [org] = await getDb().select().from(schema.organization).where(eq(schema.organization.id, DEMO_ORG_ID));
  });
  afterAll(async () => {
    await getDb().execute(sql`drop trigger if exists fail_notification_insert on notification`);
    await closeTestDb();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    fx.calendar.create.mockResolvedValue("gcal_evt_123");
    fx.calendar.update.mockImplementation(async (b) => b.calendarEventId!);
    fx.calendar.remove.mockResolvedValue();
    fx.notifier.send.mockResolvedValue({ ok: true, detail: "mock provider accepted" });
  });

  describe("(1) when the booking save fails, no email/SMS/calendar adapter is called", () => {
    it("a database error during the save rolls everything back and calls nothing", async () => {
      // Make the save fail inside the transaction, after the booking row was inserted.
      await getDb().execute(sql.raw(`
        create or replace function fail_notification_insert() returns trigger language plpgsql as $$
        begin raise exception 'simulated database failure during booking save'; end $$;
        create trigger fail_notification_insert before insert on notification for each row execute function fail_notification_insert();`));
      try {
        const before = (await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.booking))[0].n;
        await expect(runPipeline(org, { action: "create", req: request({ phone: "+12025550123", smsConsent: true }) }, ctx)).rejects.toThrow();
        expect(adapterCalls()).toBe(0);
        expect((await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.booking))[0].n).toBe(before);
      } finally {
        await getDb().execute(sql`drop trigger if exists fail_notification_insert on notification`);
      }
    });

    it("a failed reschedule save calls nothing and leaves the booking untouched", async () => {
      const created = await runPipeline(org, { action: "create", req: request() }, ctx);
      expect(created.ok).toBe(true);
      const id = created.booking!.id;
      const original = await bookingRow(id);
      vi.clearAllMocks();
      await getDb().execute(sql.raw(`create trigger fail_notification_insert before insert on notification for each row execute function fail_notification_insert();`));
      try {
        await expect(runPipeline(org, { action: "reschedule", bookingId: id, date: futureWeekday(40), time: "14:00" }, ctx)).rejects.toThrow();
      } finally {
        await getDb().execute(sql`drop trigger if exists fail_notification_insert on notification`);
      }
      expect(adapterCalls()).toBe(0);
      expect(await bookingRow(id)).toMatchObject({ date: original.date, time: original.time, calendarEventId: "gcal_evt_123" });
    });

    it("a pipeline that fails (nothing saved) calls nothing", async () => {
      const r = await runPipeline(org, { action: "create", req: request() }, { ...ctx, failAgent: "NotificationAgent" });
      expect(r.ok).toBe(false);
      expect(adapterCalls()).toBe(0);
      expect(r.booking ? await bookingRow(r.booking.id) : undefined).toBeUndefined();
    });
  });

  describe("(2) after a successful save", () => {
    it("adapters run after commit; notification rows go queued → sent/failed; the calendar event id is stored", async () => {
      const seenDuringCalls: { calendarRow?: unknown; statuses: string[][] } = { statuses: [] };
      fx.calendar.create.mockImplementation(async (b) => {
        seenDuringCalls.calendarRow = await bookingRow(b.id); // committed and visible to another connection
        return "gcal_evt_123";
      });
      fx.notifier.send.mockImplementation(async (b, _s, _body, channel) => {
        seenDuringCalls.statuses.push((await notificationRows(b.id)).map((n) => `${n.channel}:${n.deliveryStatus}`).sort());
        return channel === "email" ? { ok: true, detail: "resend id mock_1" } : { ok: false, detail: "twilio mock error 21610" };
      });

      const r = await runPipeline(org, { action: "create", req: request({ phone: "+12025550123", smsConsent: true }) }, ctx);
      expect(r.ok).toBe(true);
      const id = r.booking!.id;

      expect(fx.calendar.create).toHaveBeenCalledTimes(1);
      expect(seenDuringCalls.calendarRow).toMatchObject({ id, calendarEventId: null });
      expect(fx.notifier.send).toHaveBeenCalledTimes(2);
      // While the first send runs, both rows are already committed as 'queued'.
      expect(seenDuringCalls.statuses[0]).toEqual(["email:queued", "sms:queued"]);

      const rows = await notificationRows(id);
      expect(Object.fromEntries(rows.map((n) => [n.channel, n.deliveryStatus]))).toEqual({ email: "sent", sms: "failed" });
      expect(rows.find((n) => n.channel === "sms")!.detail).toContain("21610");
      expect((await bookingRow(id)).calendarEventId).toBe("gcal_evt_123");
      expect(r.booking!.calendarEventId).toBe("gcal_evt_123");

      // The failed SMS is recorded in the audit log.
      const audit = await getDb().select().from(schema.auditEntry).where(and(eq(schema.auditEntry.bookingId, id), eq(schema.auditEntry.outcome, "failed")));
      expect(audit.some((a) => a.detail.includes("sms"))).toBe(true);
    });

    it("reschedule updates the stored calendar event and re-notifies", async () => {
      const created = await runPipeline(org, { action: "create", req: request() }, ctx);
      const id = created.booking!.id;
      vi.clearAllMocks();
      fx.notifier.send.mockResolvedValue({ ok: true, detail: "ok" });
      const r = await runPipeline(org, { action: "reschedule", bookingId: id, date: futureWeekday(45), time: "15:00" }, ctx);
      expect(r.ok).toBe(true);
      expect(fx.calendar.create).not.toHaveBeenCalled();
      expect(fx.calendar.update).toHaveBeenCalledWith(expect.objectContaining({ id, calendarEventId: "gcal_evt_123" }));
      expect((await bookingRow(id)).calendarEventId).toBe("gcal_evt_123");
      const rows = await notificationRows(id);
      expect(rows.filter((n) => n.deliveryStatus === "queued")).toHaveLength(0);
      expect(rows.filter((n) => n.deliveryStatus === "sent")).toHaveLength(2); // create + reschedule emails
    });

    it("a calendar failure after save keeps the booking, stores no event id, and is audited", async () => {
      fx.calendar.create.mockRejectedValue(new Error("google mock 503"));
      const r = await runPipeline(org, { action: "create", req: request() }, ctx);
      expect(r.ok).toBe(true);
      const row = await bookingRow(r.booking!.id);
      expect(row).toMatchObject({ status: "confirmed", calendarEventId: null });
      expect((await notificationRows(row.id)).map((n) => n.deliveryStatus)).toEqual(["sent"]);
      const audit = await getDb().select().from(schema.auditEntry).where(and(eq(schema.auditEntry.bookingId, row.id), eq(schema.auditEntry.outcome, "failed")));
      expect(audit.some((a) => a.detail.includes("calendar create failed"))).toBe(true);
    });
  });
});
