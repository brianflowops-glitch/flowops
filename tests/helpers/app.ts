/**
 * Helpers to drive the real Better Auth handler and Next.js route handlers in-process.
 */
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { DEMO_ORG_ID, DEMO_ORG_SLUG, DEMO_SERVICES, defaultHours } from "@/lib/tenancy/defaults";

export const BASE = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple";
let ipCounter = 1;

/** Unique fake client IP per auth call so Better Auth's per-IP rate limits don't interfere. */
function nextIp() {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

export async function authCall(path: string, body: unknown, cookie?: string) {
  return getAuth().handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-real-ip": nextIp(), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

/** Turn Set-Cookie headers into a Cookie request header. */
export function cookieFrom(res: Response) {
  const list = res.headers.getSetCookie?.() ?? [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

export async function signUp(email: string, opts: { name?: string; businessName?: string; inviteToken?: string; password?: string } = {}): Promise<TestUser> {
  const res = await authCall("/sign-up/email", {
    email,
    password: opts.password ?? PASSWORD,
    name: opts.name ?? email.split("@")[0],
    ...(opts.businessName ? { businessName: opts.businessName } : {}),
    ...(opts.inviteToken ? { inviteToken: opts.inviteToken } : {}),
  });
  if (!res.ok) throw new Error(`sign-up failed for ${email}: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { user: { id: string } };
  return { id: j.user.id, email, cookie: cookieFrom(res) };
}

export async function signIn(email: string, password = PASSWORD) {
  return authCall("/sign-in/email", { email, password });
}

export function req(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", origin: BASE, ...(init.cookie ? { cookie: init.cookie } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** Seed the primary demo org (as scripts/db-migrate.ts does) — in the test DB only. */
export async function seedDemoOrg() {
  const db = getDb();
  await db.insert(schema.organization).values({ id: DEMO_ORG_ID, slug: DEMO_ORG_SLUG, name: "FlowOps Demo", hours: defaultHours(), isDemo: true }).onConflictDoNothing();
  await db
    .insert(schema.service)
    .values(DEMO_SERVICES.map((s, i) => ({ ...s, organizationId: DEMO_ORG_ID, sortOrder: i })))
    .onConflictDoNothing();
}

export async function memberOf(userId: string) {
  const [m] = await getDb().select().from(schema.member).where(eq(schema.member.userId, userId)).limit(1);
  return m;
}

export async function setRole(userId: string, role: "owner" | "admin" | "staff") {
  await getDb().update(schema.member).set({ role }).where(eq(schema.member.userId, userId));
}

/** Put an existing user into `orgId` with `role` (test fixture shortcut). */
export async function moveToOrg(userId: string, orgId: string, role: "owner" | "admin" | "staff") {
  await getDb().update(schema.member).set({ organizationId: orgId, role }).where(eq(schema.member.userId, userId));
}

/** A weekday at least a week out (org hours are Mon–Fri 08–18), as YYYY-MM-DD. */
export function futureWeekday(offsetDays = 10) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
