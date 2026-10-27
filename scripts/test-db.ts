// DB integration tests for webhook STOP/START phone matching (incl. the 0007 expression index and time-zone-aware
// START) and the sweeper's SMS path.
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres npm run test:db
// Refuses anything but a localhost database. Applies migrations, uses its own random test org, deletes it at the end.
// Provider calls are mocked (global fetch); nothing is sent.
import { randomUUID } from "node:crypto";

const url = process.env.TEST_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("TEST_DATABASE_URL must point at a local throwaway Postgres (localhost / 127.0.0.1). Refusing.");
  process.exit(2);
}
process.env.DATABASE_URL = url;
process.env.RESEND_API_KEY = "re_test";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_FROM_NUMBER = "+16105550100";
delete process.env.ALERT_WEBHOOK_URL;
delete process.env.ALERT_EMAIL;

const smsTo: string[] = [];
const emailKeys: string[] = [];
globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
  if (String(u).includes("twilio")) {
    smsTo.push(new URLSearchParams(String(init?.body)).get("To") ?? "");
    return new Response(JSON.stringify({ sid: "SMtest", status: "queued" }), { status: 201 });
  }
  emailKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
  return new Response(JSON.stringify({ id: "em_test" }), { status: 200 });
}) as typeof fetch;

(async () => {
  const { sql, eq, inArray } = await import("drizzle-orm");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const { getDb, getConn, schema } = await import("../src/lib/db");
  const { toE164 } = await import("../src/lib/phone");
  const { localStamp } = await import("../src/lib/booking/engine");
  const { readFileSync } = await import("node:fs");
  const { applySmsKeyword, phoneE164Sql } = await import("../src/lib/server/webhooks/store");
  const { sweepQueuedNotifications } = await import("../src/lib/server/notification-sweeper");
  const { notifierAdapter } = await import("../src/lib/server/integrations/notify");
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });

  let failed = 0;
  const check = (label: string, pass: boolean, detail?: unknown) => {
    if (!pass) failed++;
    console.log(`${pass ? "✓" : "✗"} ${label}${detail !== undefined ? `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]` : ""}`);
  };

  // 1. SQL normalization agrees with toE164 on every format.
  const formats = ["610-555-0134", "(610) 555-0134", "610 555 0134", "+1 610 555 0134", "+16105550134", "1-610-555-0134", "610.555.0134",
    "610-555-0134 ext 12", "610-555-0134x9", "+44 20 7946 0958", "555-0134", "610-555-0134 call me", "", "  (610)555-0134  "];
  const rows = (await db.execute<{ v: string; n: string | null }>(sql`select v, ${phoneE164Sql(sql`v`)} as n from unnest(${sql.raw(`ARRAY[${formats.map((f) => `'${f.replace(/'/g, "''")}'`).join(",")}]::text[]`)}) as v`)).rows;
  const mismatches = rows.filter((r) => (r.n ?? null) !== (toE164(r.v) ?? null));
  check("phoneE164Sql == toE164 for all formats", mismatches.length === 0, mismatches.length ? mismatches : `${rows.length} formats`);

  // 2. STOP then START across stored formats.
  const org = `org_test_${randomUUID().slice(0, 8)}`;
  await db.insert(schema.organization).values({ id: org, slug: org, name: "DB Test Org", hours: {} as never });
  const stored = { dash: "610-555-0134", paren: "(610) 555-0134", space: "610 555 0134", plus1: "+1 610 555 0134", e164: "+16105550134", other: "610-555-0199", past: "610.555.0134", noConsent: "610-555-0134" };
  const base = { organizationId: org, customer: "T", email: "t@example.com", category: "appointment" as const, service: "S", resource: "R", time: "10:00", durationMin: 60, status: "confirmed" as const, history: [], createdAt: new Date(), updatedAt: new Date() };
  const ids: Record<string, string> = {};
  for (const [k, phone] of Object.entries(stored)) {
    ids[k] = `BK-${k}-${randomUUID().slice(0, 6)}`;
    await db.insert(schema.booking).values({ ...base, id: ids[k], phone, smsConsent: k !== "noConsent", smsConsentAt: k !== "noConsent" ? new Date() : null, date: k === "past" ? "2000-01-01" : "2099-01-01" });
  }
  const state = async () => Object.fromEntries((await db.select({ id: schema.booking.id, c: schema.booking.smsConsent, phone: schema.booking.phone }).from(schema.booking).where(eq(schema.booking.organizationId, org))).map((r) => [Object.keys(ids).find((k) => ids[k] === r.id)!, r]));

  const stopped = await db.transaction((tx) => applySmsKeyword(tx, "+16105550134", "STOP"));
  let s = await state();
  check("STOP updates dashed/parenthesized/spaced/+1/E.164/dotted bookings", stopped === 6 && ["dash", "paren", "space", "plus1", "e164", "past"].every((k) => !s[k].c), { stopped });
  check("STOP leaves a different number alone", s.other.c === true);
  check("stored phone values are not rewritten", Object.entries(stored).every(([k, v]) => s[k].phone === v));

  const started = await db.transaction((tx) => applySmsKeyword(tx, "+16105550134", "START"));
  s = await state();
  check("START restores upcoming STOP-revoked bookings in every format", started === 5 && ["dash", "paren", "space", "plus1", "e164"].every((k) => s[k].c), { started });
  check("START does not restore past bookings or never-consented ones", !s.past.c && !s.noConsent.c);

  // 2b. START is time-zone-aware: "upcoming" is judged in each business's own zone (date/time are org-local).
  const tzPhone = "+16105550177";
  const localAt = (offsetMin: number, tz: string) => { const s = localStamp(new Date(Date.now() + offsetMin * 60_000), tz); return { date: s.slice(0, 10), time: s.slice(11, 16) }; };
  const tzOrgs = { kir: { id: `${org}_kir`, tz: "Pacific/Kiritimati" }, hnl: { id: `${org}_hnl`, tz: "Pacific/Honolulu" }, bad: { id: `${org}_bad`, tz: "Not/AZone" } };
  for (const o of Object.values(tzOrgs)) await db.insert(schema.organization).values({ id: o.id, slug: o.id, name: `TZ ${o.tz}`, timeZone: o.tz, hours: {} as never });
  const tzBookings = {
    kirPast: { org: tzOrgs.kir.id, ...localAt(-60, tzOrgs.kir.tz) }, // an hour ago in UTC+14: always on/after the UTC date, so a UTC date-only rule wrongly restores it
    kirSoon: { org: tzOrgs.kir.id, ...localAt(60, tzOrgs.kir.tz) },
    hnlPast: { org: tzOrgs.hnl.id, ...localAt(-60, tzOrgs.hnl.tz) },
    hnlSoon: { org: tzOrgs.hnl.id, ...localAt(60, tzOrgs.hnl.tz) }, // in UTC-10: before the UTC date for much of the day
    badFuture: { org: tzOrgs.bad.id, date: "2099-01-01", time: "10:00" },
    badPast: { org: tzOrgs.bad.id, date: "2000-01-01", time: "10:00" },
  };
  const tzIds: Record<string, string> = {};
  for (const [k, b] of Object.entries(tzBookings)) {
    tzIds[k] = `BK-tz-${k}-${randomUUID().slice(0, 6)}`;
    await db.insert(schema.booking).values({ ...base, organizationId: b.org, id: tzIds[k], phone: "610-555-0177", smsConsent: true, smsConsentAt: new Date(), date: b.date, time: b.time });
  }
  const tzStopped = await db.transaction((tx) => applySmsKeyword(tx, tzPhone, "STOP"));
  const tzStarted = await db.transaction((tx) => applySmsKeyword(tx, tzPhone, "START"));
  const tzState = Object.fromEntries((await db.select({ id: schema.booking.id, c: schema.booking.smsConsent }).from(schema.booking).where(inArray(schema.booking.id, Object.values(tzIds)))).map((r) => [Object.keys(tzIds).find((k) => tzIds[k] === r.id)!, r.c]));
  check("TZ: STOP revoked all 6 bookings", tzStopped === 6, { tzStopped });
  check("TZ: START restores bookings upcoming in their own zone (Kiritimati +1h, Honolulu +1h)", tzState.kirSoon === true && tzState.hnlSoon === true, { tzState, tzBookings });
  check("TZ: START leaves bookings already past in their own zone (Kiritimati −1h, Honolulu −1h)", tzState.kirPast === false && tzState.hnlPast === false, { tzState, tzBookings });
  check("TZ: unknown zone falls back to date-only (future restored, past not)", tzState.badFuture === true && tzState.badPast === false, tzState);
  check("TZ: START count matches", tzStarted === 3, { tzStarted });

  // 2c. 0007 expression index exists, re-applying it is a no-op, and the planner uses it for the STOP/START match.
  const idx = (await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where tablename = 'booking' and indexname = 'booking_phone_e164_idx'`)).rows;
  check("0007: booking_phone_e164_idx exists", idx.length === 1);
  let reapplied = true;
  try { await db.execute(sql.raw(readFileSync("./drizzle/0007_phone_e164_idx.sql", "utf8"))); } catch (e) { reapplied = false; console.error(e); }
  check("0007: re-running the migration SQL is a no-op (IF NOT EXISTS)", reapplied);
  const plan = await db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const r = await tx.execute<{ "QUERY PLAN": string }>(sql`explain select ${schema.booking.id} from ${schema.booking} where ${phoneE164Sql(schema.booking.phone)} = ${"+16105550134"} and ${schema.booking.smsConsent} = true`);
    return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
  });
  check("0007: planner can use booking_phone_e164_idx for the STOP/START phone match", /booking_phone_e164_idx/.test(plan), plan);

  // 3. Sweeper + sendSms with a non-E.164 stored phone: sends to E.164, and honors STOP for that phone.
  const mk = async (id: string, booking: string) =>
    db.insert(schema.notification).values({ id, organizationId: org, at: new Date(Date.now() - 6 * 60_000), bookingId: booking, recipient: stored.paren, channel: "sms", subject: "Booking confirmed: S on 2099-01-01 at 10:00", deliveryStatus: "queued", detail: "queued" });
  const n1 = `NT-${randomUUID().slice(0, 8)}`;
  await mk(n1, ids.paren);
  smsTo.length = 0;
  await sweepQueuedNotifications();
  const [r1] = await db.select().from(schema.notification).where(eq(schema.notification.id, n1));
  check("sweeper sends SMS for '(610) 555-0134' to +16105550134", r1.deliveryStatus === "sent" && smsTo.join() === "+16105550134", { status: r1.deliveryStatus, smsTo });

  await db.transaction((tx) => applySmsKeyword(tx, "+16105550134", "STOP"));
  await db.update(schema.booking).set({ smsConsent: true }).where(eq(schema.booking.id, ids.paren)); // simulate consent left on
  const n2 = `NT-${randomUUID().slice(0, 8)}`;
  await mk(n2, ids.paren);
  smsTo.length = 0;
  await sweepQueuedNotifications();
  const [r2] = await db.select().from(schema.notification).where(eq(schema.notification.id, n2));
  check("opted-out number is not texted even when stored as '(610) 555-0134'", r2.deliveryStatus === "failed" && smsTo.length === 0 && /opted out/.test(r2.detail ?? ""), { status: r2.deliveryStatus, detail: r2.detail });

  // 4. Email idempotency key: pipeline path (PR #3 passes "notification-<row id>") and sweeper produce the same key.
  const [bk] = await db.select().from(schema.booking).where(eq(schema.booking.id, ids.dash));
  emailKeys.length = 0;
  await notifierAdapter({ businessName: "DB Test Org", organizationId: org })!.send(bk as never, "Booking confirmed", "body", "email", { idempotencyKey: "notification-NT-pipe1" });
  check("pipeline adapter forwards key → Idempotency-Key flowops-notification-<row id>", emailKeys.join() === "flowops-notification-NT-pipe1", emailKeys);
  const n3 = `NT-${randomUUID().slice(0, 8)}`;
  await db.insert(schema.notification).values({ id: n3, organizationId: org, at: new Date(Date.now() - 6 * 60_000), bookingId: ids.dash, recipient: "t@example.com", channel: "email", subject: "Booking confirmed: S on 2099-01-01 at 10:00", deliveryStatus: "queued", detail: "queued" });
  emailKeys.length = 0;
  await sweepQueuedNotifications();
  check("sweeper re-send of the same row uses the same key format", emailKeys.join() === `flowops-notification-${n3}`, emailKeys);

  // Cleanup: only this run's org (cascades to its bookings/notifications) and the opt-out row it created.
  await db.delete(schema.notificationFailure).where(eq(schema.notificationFailure.organizationId, org));
  await db.delete(schema.organization).where(inArray(schema.organization.id, [org, ...Object.values(tzOrgs).map((o) => o.id)]));
  await db.delete(schema.smsOptOut).where(inArray(schema.smsOptOut.phone, ["+16105550134", tzPhone]));
  await new Promise((r) => setTimeout(r, 200));
  await getConn().pool.end();
  console.log(`\n${failed ? `${failed} FAILED` : "all DB checks passed"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
