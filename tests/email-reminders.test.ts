/**
 * Email-only appointment reminders: flag, exactly-once enqueue/claim/send, reschedule/cancel races, crash recovery,
 * and the cron route. Runs against in-process PGlite with the real ./drizzle migrations (incl. 0013). Resend and Twilio
 * are mocks; nothing leaves the process. SMS must never be touched: `sendSms` is asserted to have zero calls.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runTest } from "@/lib/booking/tests";

const fx = vi.hoisted(() => ({
  configured: true,
  sendEmail: vi.fn<(to: string, subject: string, text: string, replyTo?: string, meta?: { tag?: string; organizationId?: string | null; idempotencyKey?: string }) => Promise<{ ok: boolean; detail?: string }>>(),
  sendSms: vi.fn(),
}));
vi.mock("@/lib/server/integrations/notify", async (orig) => ({
  ...(await orig<object>()),
  resendConfigured: () => fx.configured,
  sendEmail: fx.sendEmail,
  sendSms: fx.sendSms,
}));

import { getDb, schema } from "@/lib/db";
import { initTestDb } from "./helpers/db";
import { seedDemoOrg } from "./helpers/app";
import { defaultHours } from "@/lib/tenancy/defaults";
import { REMINDER_TEST_CASES } from "@/lib/server/reminders/reminders.tests";
import { reminderConfig } from "@/lib/server/reminders/reminders";
import { runEmailReminders } from "@/lib/server/reminders/run";

describe("email reminder unit cases (RM-00x, also in `npm run test:sim`)", () => {
  it.each(REMINDER_TEST_CASES.map((t) => [t.id, t] as const))("%s", async (_id, t) => {
    const r = await runTest(t);
    expect(r.assertions.filter((a) => !a.pass).map((a) => `${a.label}${a.detail ? ` [${a.detail}]` : ""}`)).toEqual([]);
    expect(r.error ?? null).toBeNull();
    expect(r.pass).toBe(true);
  });
});

const ON = reminderConfig({ EMAIL_REMINDERS_ENABLED: "true" });
const OFF = reminderConfig({});
const ORG = "org-reminders";
// 2030-06-15 10:00 America/New_York = 14:00Z. "now" is 12 h earlier; all fixtures were booked well ahead.
const NOW = new Date("2030-06-15T02:00:00Z");
const n = schema.notification;
let seq = 0;

async function addBooking(over: Partial<typeof schema.booking.$inferInsert> = {}) {
  const id = over.id ?? `BK-RM-${++seq}`;
  await getDb()
    .insert(schema.booking)
    .values({
      id,
      organizationId: ORG,
      customer: "Pat Example",
      email: "pat@example.test",
      phone: "+16105550134",
      smsConsent: true,
      category: "appointment",
      service: "Consultation",
      resource: "Room A",
      date: "2030-06-15",
      time: "10:00",
      durationMin: 60,
      status: "confirmed",
      history: [],
      createdAt: new Date("2030-06-01T12:00:00Z"),
      updatedAt: new Date("2030-06-01T12:00:00Z"),
      ...over,
    });
  return id;
}
const rows = () => getDb().select().from(n);
const run = (o: Parameters<typeof runEmailReminders>[0] = {}) => runEmailReminders({ now: NOW, config: ON, ...o });

describe("email reminders (PGlite)", () => {
  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    await getDb().insert(schema.organization).values({ id: ORG, slug: "acme-dental", name: "Acme Dental", timeZone: "America/New_York", hours: defaultHours() });
  });
  beforeEach(async () => {
    fx.configured = true;
    fx.sendEmail.mockReset().mockResolvedValue({ ok: true, detail: "resend id test" });
    fx.sendSms.mockReset();
    await getDb().delete(n);
    await getDb().delete(schema.booking);
  });

  it("flag off: no sends, no rows, database untouched", async () => {
    await addBooking();
    const rep = await run({ config: OFF });
    expect(rep).toMatchObject({ enabled: false, candidates: 0, enqueued: 0, sent: 0 });
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("flag on but Resend not configured: nothing is enqueued", async () => {
    fx.configured = false;
    await addBooking();
    const rep = await run();
    expect(rep.note).toBe("email not configured");
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("sends one reminder in the org's time zone, with a deterministic idempotency key", async () => {
    const id = await addBooking();
    const rep = await run();
    expect(rep).toMatchObject({ enqueued: 1, claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, text, , meta] = fx.sendEmail.mock.calls[0];
    expect(to).toBe("pat@example.test");
    expect(subject).toBe("Reminder: your appointment with Acme Dental on Sat, Jun 15 at 10:00 AM EDT");
    expect(text).toContain("Acme Dental");
    expect(text).toContain(`Reference: ${id}`);
    expect(text).toContain("contact Acme Dental directly");
    expect(`${subject}\n${text}`).not.toMatch(/\b(sms|texts?|texting|stop|help)\b/i);
    expect(meta?.idempotencyKey).toBe(`reminder-${id}-2030-06-15T14:00:00.000Z`);
    const [row] = await rows();
    expect(row).toMatchObject({ bookingId: id, channel: "email", deliveryStatus: "sent", dedupeKey: meta?.idempotencyKey, recipient: "pat@example.test" });
  });

  it("exactly once: a second run, and two overlapping runs, send nothing more", async () => {
    await addBooking();
    await run();
    expect((await run()).enqueued).toBe(0);
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);

    await addBooking({ email: "lee@example.test" });
    await Promise.all([run(), run()]);
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(2);
  });

  it("the unique index rejects a duplicate key (migration 0013)", async () => {
    const id = await addBooking();
    await run();
    const [row] = await rows();
    await expect(getDb().insert(n).values({ ...row, id: "dup" })).rejects.toThrow();
    // …but ordinary rows without a key are unaffected (many nulls allowed).
    await getDb().insert(n).values({ ...row, id: "plain-1", dedupeKey: null });
    await getDb().insert(n).values({ ...row, id: "plain-2", dedupeKey: null });
    expect((await rows()).filter((r) => r.bookingId === id)).toHaveLength(3);
  });

  it("rescheduled booking gets a fresh reminder for the new time; the old one is never sent", async () => {
    const id = await addBooking();
    await run();
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    // Reschedule to the next day at 14:00 NY (= 18:00Z), long before the window.
    await getDb()
      .update(schema.booking)
      .set({ date: "2030-06-16", time: "14:00", history: [{ at: "2030-06-10T12:00:00Z", action: "rescheduled", detail: "x" }] })
      .where(eq(schema.booking.id, id));
    expect((await run()).enqueued).toBe(0); // 40 h out: too far
    const later = new Date("2030-06-15T20:00:00Z"); // 22 h before 2030-06-16 18:00Z
    const rep = await run({ now: later });
    expect(rep.sent).toBe(1);
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
    expect(fx.sendEmail.mock.calls[1][4]?.idempotencyKey).toBe(`reminder-${id}-2030-06-16T18:00:00.000Z`);
    expect(fx.sendEmail.mock.calls[1][1]).toContain("Sun, Jun 16 at 2:00 PM EDT");
    expect((await rows()).map((r) => r.dedupeKey).sort()).toEqual([`reminder-${id}-2030-06-15T14:00:00.000Z`, `reminder-${id}-2030-06-16T18:00:00.000Z`]);
  });

  it("a row enqueued for the old slot is skipped, not sent, if the booking was rescheduled or cancelled before it was claimed", async () => {
    const moved = await addBooking();
    const cancelled = await addBooking({ email: "c@example.test" });
    const mk = (bookingId: string, recipient: string) => ({
      id: `RM-pre-${bookingId}`,
      organizationId: ORG,
      at: NOW,
      bookingId,
      recipient,
      channel: "email",
      subject: "Reminder",
      deliveryStatus: "sending",
      dedupeKey: `reminder-${bookingId}-2030-06-15T14:00:00.000Z`,
    });
    await getDb().insert(n).values([mk(moved, "pat@example.test"), mk(cancelled, "c@example.test")]);
    await getDb().update(schema.booking).set({ date: "2030-06-18" }).where(eq(schema.booking.id, moved));
    await getDb().update(schema.booking).set({ status: "cancelled" }).where(eq(schema.booking.id, cancelled));
    const rep = await run();
    expect(rep).toMatchObject({ claimed: 2, sent: 0, skipped: 2 });
    expect(fx.sendEmail).not.toHaveBeenCalled();
    const byBooking = Object.fromEntries((await rows()).map((r) => [r.bookingId, r]));
    expect(byBooking[moved]).toMatchObject({ deliveryStatus: "skipped", detail: "not sent: booking was rescheduled" });
    expect(byBooking[cancelled]).toMatchObject({ deliveryStatus: "skipped", detail: "not sent: booking is cancelled" });
  });

  it("skips cancelled, past, too-far, no-email, booked-inside-window and demo-org bookings", async () => {
    await addBooking({ status: "cancelled" });
    await addBooking({ date: "2030-06-14" }); // already started
    await addBooking({ date: "2030-06-18" }); // too far
    await addBooking({ email: "" });
    await addBooking({ createdAt: new Date("2030-06-15T00:00:00Z") }); // booked 14 h out
    const demo = (await getDb().select().from(schema.organization).where(eq(schema.organization.isDemo, true)))[0];
    await addBooking({ organizationId: demo.id });
    const rep = await run();
    expect(rep.enqueued).toBe(0);
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("a failed send is recorded as failed and not retried on the next run", async () => {
    fx.sendEmail.mockResolvedValue({ ok: false, detail: "Resend 422: nope" });
    await addBooking();
    expect(await run()).toMatchObject({ sent: 0, failed: 1 });
    expect((await rows())[0]).toMatchObject({ deliveryStatus: "failed", detail: "Resend 422: nope" });
    await run();
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("crash recovery: an expired lease is re-claimed and re-sent with the SAME idempotency key; exhausted rows expire", async () => {
    await addBooking();
    await run({ budgetMs: 0 }); // enqueue only; nothing is claimed
    let [row] = await rows();
    expect(row).toMatchObject({ deliveryStatus: "sending", sweepAttempts: 0 });
    // Simulate a run that claimed it and died: lease expired 1 h ago.
    await getDb().update(n).set({ claimedAt: sql`now() - interval '1 hour'`, sweepAttempts: 1, at: sql`now()` }).where(eq(n.id, row.id));
    const rep = await run();
    expect(rep).toMatchObject({ claimed: 1, sent: 1 });
    expect(fx.sendEmail.mock.calls[0][4]?.idempotencyKey).toBe(row.dedupeKey);
    [row] = await rows();
    expect(row).toMatchObject({ deliveryStatus: "sent", sweepAttempts: 2 });

    // A live lease is not stolen.
    await getDb().update(n).set({ deliveryStatus: "sending", claimedAt: sql`now()`, sweepAttempts: 1 }).where(eq(n.id, row.id));
    fx.sendEmail.mockClear();
    await run();
    expect(fx.sendEmail).not.toHaveBeenCalled();
    // Out of attempts and lease expired → expired (failed), never sent.
    await getDb().update(n).set({ claimedAt: sql`now() - interval '1 hour'`, sweepAttempts: 3 }).where(eq(n.id, row.id));
    expect(await run()).toMatchObject({ expired: 1, sent: 0 });
    expect((await rows())[0].deliveryStatus).toBe("failed");
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("is email only: no SMS call, no sms row, even for a booking with a phone and SMS consent", async () => {
    await addBooking({ phone: "+16105550134", smsConsent: true });
    await run();
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(fx.sendSms).not.toHaveBeenCalled();
    expect((await rows()).every((r) => r.channel === "email")).toBe(true);
  });

  it("does not interfere with the recovery sweeper: reminder rows are never 'queued'", async () => {
    await addBooking();
    await run();
    expect((await rows()).filter((r) => r.deliveryStatus === "queued")).toHaveLength(0);
  });
});

describe("cron route /api/cron/notifications", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/cron/notifications/route");
    return GET(new Request("http://localhost:3000/api/cron/notifications", { headers: { authorization: "Bearer cron-secret-test" } }));
  };
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron-secret-test");
    fx.configured = true;
    fx.sendEmail.mockReset().mockResolvedValue({ ok: true });
  });

  it("flag off: response is exactly the sweeper report (identical to today), no reminder work", async () => {
    vi.stubEnv("EMAIL_REMINDERS_ENABLED", "");
    const res = await call();
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(["claimed", "expired", "failed", "sent", "skipped"]);
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("flag on: runs the reminders after the sweeper and reports them", async () => {
    vi.stubEnv("EMAIL_REMINDERS_ENABLED", "true");
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reminders?: { enabled: boolean } };
    expect(body.reminders?.enabled).toBe(true);
  });

  it("still fails closed without / with a wrong secret", async () => {
    const { GET } = await import("@/app/api/cron/notifications/route");
    expect((await GET(new Request("http://localhost:3000/api/cron/notifications", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new Request("http://localhost:3000/api/cron/notifications"))).status).toBe(503);
  });
});
