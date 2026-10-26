import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createEmailVerificationToken } from "better-auth/api";
import { initTestDb } from "./helpers/db";
import { BASE, authCall, futureWeekday, memberOf, params, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { getAuth } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { LEGACY_INVITE_TTL_DAYS, legacyInviteUsable } from "@/lib/tenancy/membership";
import { inviteExpiry, newInviteToken } from "@/lib/tenancy/invites";
import * as acceptInvite from "@/app/api/invites/[token]/accept/route";
import * as bookings from "@/app/api/bookings/route";

const SECRET = process.env.BETTER_AUTH_SECRET!;
const DAY = 24 * 3600 * 1000;

/** Simulate the user clicking the emailed verification link (real Better Auth verify-email endpoint). */
async function verifyEmail(email: string) {
  const token = await createEmailVerificationToken(SECRET, email);
  const res = await getAuth().handler(new Request(`${BASE}/api/auth/verify-email?token=${encodeURIComponent(token)}`, { headers: { origin: BASE } }));
  expect(res.status).toBeLessThan(400);
  const [u] = await getDb().select().from(schema.user).where(eq(schema.user.email, email));
  expect(u.emailVerified).toBe(true);
}

async function legacyInvite(orgId: string, email: string, ageMs = 0) {
  const id = `sinv_${crypto.randomUUID().slice(0, 8)}`;
  await getDb().insert(schema.staffInvite).values({ id, organizationId: orgId, email, createdAt: new Date(Date.now() - ageMs) });
  return id;
}
const legacyRow = async (id: string) => (await getDb().select().from(schema.staffInvite).where(eq(schema.staffInvite.id, id)))[0];

async function tokenInvite(orgId: string, email: string, role: "admin" | "staff", expiresAt = inviteExpiry()) {
  const { token, tokenHash } = newInviteToken();
  await getDb().insert(schema.teamInvite).values({ id: `tinv_${crypto.randomUUID().slice(0, 8)}`, organizationId: orgId, email, role, tokenHash, expiresAt });
  return token;
}

let owner: TestUser;
let orgB: string;

beforeAll(async () => {
  await initTestDb();
  await seedDemoOrg();
  await signUp("demo-owner@inv.test");
  owner = await signUp("owner-b@inv.test", { businessName: "Business B" });
  orgB = (await memberOf(owner.id)).organizationId;
});
afterEach(() => vi.unstubAllEnvs());

describe("legacyInviteUsable", () => {
  it("needs a verified email and an invite younger than the TTL", () => {
    const fresh = { createdAt: new Date() };
    const old = { createdAt: new Date(Date.now() - (LEGACY_INVITE_TTL_DAYS + 1) * DAY) };
    expect(legacyInviteUsable(fresh, false)).toBe(false);
    expect(legacyInviteUsable(fresh, true)).toBe(true);
    expect(legacyInviteUsable(old, true)).toBe(false);
  });
});

describe("legacy email-match staff_invite takeover", () => {
  it("signing up (unverified) with an invited email does NOT join the inviting org", async () => {
    const id = await legacyInvite(orgB, "victim@inv.test");
    const attacker = await signUp("victim@inv.test");
    const m = await memberOf(attacker.id);
    expect(m.organizationId).not.toBe(orgB);
    expect(m.role).toBe("owner"); // their own new, empty workspace
    expect(await legacyRow(id)).toBeDefined(); // invite not consumed
  });

  it("after the real owner of the address verifies it, they join as Staff and the empty workspace is removed", async () => {
    const u = await signUp("verified-later@inv.test");
    const id = await legacyInvite(orgB, "verified-later@inv.test");
    const before = await memberOf(u.id);
    await verifyEmail("verified-later@inv.test");
    const after = await memberOf(u.id);
    expect(after).toMatchObject({ organizationId: orgB, role: "staff" });
    const [gone] = await getDb().select().from(schema.organization).where(eq(schema.organization.id, before.organizationId));
    expect(gone).toBeUndefined();
    expect(await legacyRow(id)).toBeUndefined();
  });

  it("expired legacy invites are ignored even after verification", async () => {
    const u = await signUp("expired-legacy@inv.test");
    await legacyInvite(orgB, "expired-legacy@inv.test", (LEGACY_INVITE_TTL_DAYS + 1) * DAY);
    await verifyEmail("expired-legacy@inv.test");
    expect((await memberOf(u.id)).organizationId).not.toBe(orgB);
  });

  it("verification never pulls someone out of a workspace that has bookings", async () => {
    const u = await signUp("busy-owner@inv.test", { businessName: "Busy Biz" });
    const own = (await memberOf(u.id)).organizationId;
    const r = await (
      await bookings.POST(
        req("/api/bookings", {
          method: "POST",
          cookie: u.cookie,
          body: { action: "create", req: { customer: "Cust", email: "c@cust.test", category: "appointment", service: "S", resource: "R", date: futureWeekday(), time: "10:00", durationMin: 30 } },
        }),
      )
    ).json();
    expect(r.ok).toBe(true);
    await legacyInvite(orgB, "busy-owner@inv.test");
    await verifyEmail("busy-owner@inv.test");
    expect(await memberOf(u.id)).toMatchObject({ organizationId: own, role: "owner" });
  });
});

describe("token invites", () => {
  it("sign-up with a valid token joins with the invite's role; the token is single-use", async () => {
    const token = await tokenInvite(orgB, "tok-admin@inv.test", "admin");
    const u = await signUp("tok-admin@inv.test", { inviteToken: token });
    expect(await memberOf(u.id)).toMatchObject({ organizationId: orgB, role: "admin" });
    const reuse = await authCall("/sign-up/email", { email: "tok-admin2@inv.test", password: "correct-horse-battery-staple", name: "x", inviteToken: token });
    expect(reuse.status).toBe(400);
  });

  it("a token can't be used with a different email", async () => {
    const token = await tokenInvite(orgB, "intended@inv.test", "staff");
    const res = await authCall("/sign-up/email", { email: "someone-else@inv.test", password: "correct-horse-battery-staple", name: "x", inviteToken: token });
    expect(res.status).toBe(400);
  });

  it("an expired token is rejected", async () => {
    const token = await tokenInvite(orgB, "late@inv.test", "staff", new Date(Date.now() - 1000));
    const res = await authCall("/sign-up/email", { email: "late@inv.test", password: "correct-horse-battery-staple", name: "x", inviteToken: token });
    expect(res.status).toBe(400);
  });

  it("an existing account must verify its email before accepting (when email delivery is live)", async () => {
    const u = await signUp("existing@inv.test");
    const token = await tokenInvite(orgB, "existing@inv.test", "staff");
    vi.stubEnv("RESEND_API_KEY", "re_test_dummy_not_real");
    const call = () => acceptInvite.POST(req(`/api/invites/${token}/accept`, { method: "POST", cookie: u.cookie }), params({ token }));
    const denied = await call();
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toMatch(/Verify your email/);
    expect((await memberOf(u.id)).organizationId).not.toBe(orgB);
    await verifyEmail("existing@inv.test");
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(await memberOf(u.id)).toMatchObject({ organizationId: orgB, role: "staff" });
  });

  it("while email is simulated (no Resend), existing accounts can still accept (nobody could verify)", async () => {
    const u = await signUp("existing2@inv.test");
    const token = await tokenInvite(orgB, "existing2@inv.test", "staff");
    const res = await acceptInvite.POST(req(`/api/invites/${token}/accept`, { method: "POST", cookie: u.cookie }), params({ token }));
    expect(res.status).toBe(200);
  });
});
