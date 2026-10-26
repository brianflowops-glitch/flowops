import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { initTestDb } from "./helpers/db";
import { memberOf, moveToOrg, params, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { getDb, schema } from "@/lib/db";
import { canManageTeam } from "@/lib/server/context";
import { canInviteRole, canRemove, canResetFor } from "@/lib/tenancy/team-rules";
import * as services from "@/app/api/admin/services/route";
import * as serviceById from "@/app/api/admin/services/[id]/route";
import * as org from "@/app/api/admin/org/route";
import * as staff from "@/app/api/admin/staff/route";
import * as invites from "@/app/api/admin/invites/route";
import * as resetLink from "@/app/api/admin/members/[id]/reset-link/route";
import * as state from "@/app/api/state/route";

describe("team-rules (pure)", () => {
  const owner = { id: "u_o", role: "owner" as const };
  const admin = { id: "u_a", role: "admin" as const };
  const staffer = { id: "u_s", role: "staff" as const };

  it("canManageTeam: owner and admin only", () => {
    expect(canManageTeam("owner")).toBe(true);
    expect(canManageTeam("admin")).toBe(true);
    expect(canManageTeam("staff")).toBe(false);
  });
  it("canInviteRole: owner → admin|staff, admin → staff, staff → none", () => {
    expect(canInviteRole("owner", "admin")).toBe(true);
    expect(canInviteRole("owner", "staff")).toBe(true);
    expect(canInviteRole("admin", "admin")).toBe(false);
    expect(canInviteRole("admin", "staff")).toBe(true);
    expect(canInviteRole("staff", "staff")).toBe(false);
  });
  it("canResetFor", () => {
    expect(canResetFor(staffer, { userId: "u_s", role: "staff" })).toBe(false);
    expect(canResetFor(admin, { userId: "x", role: "staff" })).toBe(true);
    expect(canResetFor(admin, { userId: "x", role: "admin" })).toBe(false);
    expect(canResetFor(admin, { userId: "x", role: "owner" })).toBe(false);
    expect(canResetFor(admin, { userId: "u_a", role: "admin" })).toBe(true);
    expect(canResetFor(owner, { userId: "x", role: "admin" })).toBe(true);
  });
  it("canRemove: never the owner, never yourself; admin removes staff only", () => {
    expect(canRemove(owner, { userId: "x", role: "owner" })).toBe(false);
    expect(canRemove(owner, { userId: "u_o", role: "owner" })).toBe(false);
    expect(canRemove(owner, { userId: "x", role: "admin" })).toBe(true);
    expect(canRemove(admin, { userId: "x", role: "admin" })).toBe(false);
    expect(canRemove(admin, { userId: "x", role: "staff" })).toBe(true);
    expect(canRemove(admin, { userId: "u_a", role: "admin" })).toBe(false);
    expect(canRemove(staffer, { userId: "x", role: "staff" })).toBe(false);
  });
});

describe("role permissions on the API (one org: owner, admin, staff)", () => {
  let owner: TestUser, admin: TestUser, staffer: TestUser, staffer2: TestUser;
  let orgId: string;

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    owner = await signUp("owner@roles.test", { businessName: "Roles Co" });
    orgId = (await memberOf(owner.id)).organizationId;
    admin = await signUp("admin@roles.test");
    staffer = await signUp("staff@roles.test");
    staffer2 = await signUp("staff2@roles.test");
    await moveToOrg(admin.id, orgId, "admin");
    await moveToOrg(staffer.id, orgId, "staff");
    await moveToOrg(staffer2.id, orgId, "staff");
  });

  const svcBody = { name: "Role test service", durationMin: 30, resource: "Room Z" };

  it("every role can read its own org state", async () => {
    for (const u of [owner, admin, staffer]) {
      const res = await state.GET(req("/api/state", { cookie: u.cookie }));
      expect(res.status).toBe(200);
      expect((await res.json()).org.id).toBe(orgId);
    }
  });

  it("services: only the Owner can create, edit or delete", async () => {
    for (const u of [admin, staffer]) {
      expect((await services.POST(req("/api/admin/services", { method: "POST", body: svcBody, cookie: u.cookie }))).status).toBe(403);
    }
    const created = await services.POST(req("/api/admin/services", { method: "POST", body: svcBody, cookie: owner.cookie }));
    expect(created.status).toBe(200);
    const { service } = await created.json();
    for (const u of [admin, staffer]) {
      expect((await serviceById.PATCH(req(`/api/admin/services/${service.id}`, { method: "PATCH", body: { active: false }, cookie: u.cookie }), params({ id: service.id }))).status).toBe(403);
      expect((await serviceById.DELETE(req(`/api/admin/services/${service.id}`, { method: "DELETE", cookie: u.cookie }), params({ id: service.id }))).status).toBe(403);
    }
    expect((await serviceById.PATCH(req(`/api/admin/services/${service.id}`, { method: "PATCH", body: { active: false }, cookie: owner.cookie }), params({ id: service.id }))).status).toBe(200);
  });

  it("organization settings: Owner only", async () => {
    for (const u of [admin, staffer]) {
      expect((await org.PATCH(req("/api/admin/org", { method: "PATCH", body: { name: "Nope" }, cookie: u.cookie }))).status).toBe(403);
    }
    const res = await org.PATCH(req("/api/admin/org", { method: "PATCH", body: { name: "Roles Co Renamed" }, cookie: owner.cookie }));
    expect(res.status).toBe(200);
  });

  it("invites: staff can't invite; admin can invite staff but not admins; owner can invite admins", async () => {
    const inv = (u: TestUser, email: string, role: "admin" | "staff") =>
      invites.POST(req("/api/admin/invites", { method: "POST", body: { email, role }, cookie: u.cookie }));
    expect((await inv(staffer, "x1@roles.test", "staff")).status).toBe(403);
    expect((await inv(admin, "x2@roles.test", "admin")).status).toBe(403);
    expect((await inv(admin, "x3@roles.test", "staff")).status).toBe(200);
    expect((await inv(owner, "x4@roles.test", "admin")).status).toBe(200);
  });

  it("team list: staff don't see invites", async () => {
    const s = await (await staff.GET(req("/api/admin/staff", { cookie: staffer.cookie }))).json();
    expect(s.canManage).toBe(false);
    expect(s.invites).toEqual([]);
    const o = await (await staff.GET(req("/api/admin/staff", { cookie: owner.cookie }))).json();
    expect(o.canManage).toBe(true);
    expect(o.invites.length).toBeGreaterThan(0);
  });

  it("removing members: staff can't; admin can't remove admin/owner; nobody removes the owner", async () => {
    const mem = async (u: TestUser) => (await memberOf(u.id)).id;
    const del = (actor: TestUser, memberId: string) => staff.DELETE(req("/api/admin/staff", { method: "DELETE", body: { memberId }, cookie: actor.cookie }));
    expect((await del(staffer, await mem(staffer2))).status).toBe(403);
    expect((await del(admin, await mem(owner))).status).toBe(403);
    expect((await del(owner, await mem(owner))).status).toBe(403);
    // Admin removes a staff member → their login is deleted.
    expect((await del(admin, await mem(staffer2))).status).toBe(200);
    const [gone] = await getDb().select().from(schema.user).where(eq(schema.user.id, staffer2.id));
    expect(gone).toBeUndefined();
  });

  it("reset links: staff can't; admin can for staff but not the owner", async () => {
    const mem = async (u: TestUser) => (await memberOf(u.id)).id;
    const call = (actor: TestUser, memberId: string) => resetLink.POST(req(`/api/admin/members/${memberId}/reset-link`, { method: "POST", cookie: actor.cookie }), params({ id: memberId }));
    expect((await call(staffer, await mem(staffer))).status).toBe(403);
    expect((await call(admin, await mem(owner))).status).toBe(403);
    expect((await call(admin, await mem(staffer))).status).toBe(200);
    expect((await call(owner, await mem(admin))).status).toBe(200);
  });
});
