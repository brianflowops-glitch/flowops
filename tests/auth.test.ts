import { beforeAll, describe, expect, it } from "vitest";
import { initTestDb } from "./helpers/db";
import { authCall, cookieFrom, memberOf, req, seedDemoOrg, signIn, signUp, params } from "./helpers/app";
import { DEMO_ORG_ID } from "@/lib/tenancy/defaults";
import * as state from "@/app/api/state/route";
import * as bookings from "@/app/api/bookings/route";
import * as services from "@/app/api/admin/services/route";
import * as serviceById from "@/app/api/admin/services/[id]/route";
import * as org from "@/app/api/admin/org/route";
import * as staff from "@/app/api/admin/staff/route";
import * as invites from "@/app/api/admin/invites/route";
import * as inviteById from "@/app/api/admin/invites/[id]/route";
import * as inviteResend from "@/app/api/admin/invites/[id]/resend/route";
import * as resetLink from "@/app/api/admin/members/[id]/reset-link/route";
import * as assistant from "@/app/api/assistant/route";
import * as acceptInvite from "@/app/api/invites/[token]/accept/route";

beforeAll(async () => {
  await initTestDb();
  await seedDemoOrg();
});

describe("sign-up and sign-in", () => {
  it("first account claims the primary org as Owner; later accounts get their own org", async () => {
    const first = await signUp("first-owner@example.test");
    expect(await memberOf(first.id)).toMatchObject({ organizationId: DEMO_ORG_ID, role: "owner" });

    const second = await signUp("second@example.test", { businessName: "Second Biz" });
    const m = await memberOf(second.id);
    expect(m.role).toBe("owner");
    expect(m.organizationId).not.toBe(DEMO_ORG_ID);
  });

  it("signs in with the right password and returns a session cookie", async () => {
    await signUp("signin@example.test");
    const ok = await signIn("signin@example.test");
    expect(ok.status).toBe(200);
    const cookie = cookieFrom(ok);
    expect(cookie).toMatch(/better-auth\.session_token=/);
    const res = await state.GET(req("/api/state", { cookie }));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("signin@example.test");
  });

  it("rejects a wrong password and an unknown account", async () => {
    expect((await signIn("signin@example.test", "wrong-password-123")).status).toBe(401);
    expect((await signIn("nobody@example.test")).status).toBe(401);
  });

  it("rejects passwords shorter than 10 characters", async () => {
    const res = await authCall("/sign-up/email", { email: "short@example.test", password: "short", name: "S" });
    expect(res.status).toBe(400);
  });
});

describe("API auth guards", () => {
  const anon = [
    ["GET /api/state", () => state.GET(req("/api/state"))],
    ["POST /api/bookings", () => bookings.POST(req("/api/bookings", { method: "POST", body: { action: "cancel", bookingId: "BK-1" } }))],
    ["GET /api/admin/services", () => services.GET(req("/api/admin/services"))],
    ["POST /api/admin/services", () => services.POST(req("/api/admin/services", { method: "POST", body: { name: "x", durationMin: 30, resource: "r" } }))],
    ["PATCH /api/admin/services/:id", () => serviceById.PATCH(req("/api/admin/services/svc_demo_consult", { method: "PATCH", body: { active: false } }), params({ id: "svc_demo_consult" }))],
    ["DELETE /api/admin/services/:id", () => serviceById.DELETE(req("/api/admin/services/svc_demo_consult", { method: "DELETE" }), params({ id: "svc_demo_consult" }))],
    ["PATCH /api/admin/org", () => org.PATCH(req("/api/admin/org", { method: "PATCH", body: { name: "Hacked" } }))],
    ["GET /api/admin/staff", () => staff.GET(req("/api/admin/staff"))],
    ["DELETE /api/admin/staff", () => staff.DELETE(req("/api/admin/staff", { method: "DELETE", body: { memberId: "mem_x" } }))],
    ["POST /api/admin/invites", () => invites.POST(req("/api/admin/invites", { method: "POST", body: { email: "a@b.test" } }))],
    ["DELETE /api/admin/invites/:id", () => inviteById.DELETE(req("/api/admin/invites/x", { method: "DELETE" }), params({ id: "x" }))],
    ["POST /api/admin/invites/:id/resend", () => inviteResend.POST(req("/api/admin/invites/x/resend", { method: "POST" }), params({ id: "x" }))],
    ["POST /api/admin/members/:id/reset-link", () => resetLink.POST(req("/api/admin/members/x/reset-link", { method: "POST" }), params({ id: "x" }))],
    ["POST /api/assistant", () => assistant.POST(req("/api/assistant", { method: "POST", body: { messages: [] } }))],
    ["POST /api/invites/:token/accept", () => acceptInvite.POST(req("/api/invites/t/accept", { method: "POST" }), params({ token: "t".repeat(43) }))],
  ] as const;

  it.each(anon)("%s returns 401 without a session", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it.each(anon)("%s returns 401 with a forged session cookie", async (_name, call) => {
    // Re-issue the same call with a made-up cookie by patching Request construction.
    const forged = "better-auth.session_token=forged.value; better-auth.session_data=eyJmb3JnZWQiOnRydWV9";
    const original = globalThis.Request;
    class ForgedRequest extends original {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        const h = new Headers(init?.headers);
        h.set("cookie", forged);
        super(input, { ...init, headers: h });
      }
    }
    globalThis.Request = ForgedRequest as typeof Request;
    try {
      const res = await call();
      expect(res.status).toBe(401);
    } finally {
      globalThis.Request = original;
    }
  });

  it("a signed-out session no longer authorizes API calls", async () => {
    const u = await signUp("signout@example.test");
    expect((await state.GET(req("/api/state", { cookie: u.cookie }))).status).toBe(200);
    const out = await authCall("/sign-out", {}, u.cookie);
    expect(out.status).toBe(200);
    // Only the session token (no cached session_data cookie) — the server-side session is gone.
    const tokenOnly = u.cookie.split("; ").filter((c) => c.startsWith("better-auth.session_token=")).join("; ");
    expect((await state.GET(req("/api/state", { cookie: tokenOnly }))).status).toBe(401);
  });
});
