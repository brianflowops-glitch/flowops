import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { initTestDb } from "./helpers/db";
import { futureWeekday, memberOf, moveToOrg, params, req, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { getDb, schema } from "@/lib/db";
import { getContextFromHeaders } from "@/lib/server/context";
import { assistantTools } from "@/lib/server/assistant-tools";
import { loadState, listServices } from "@/lib/server/pipeline";
import * as state from "@/app/api/state/route";
import * as bookings from "@/app/api/bookings/route";
import * as services from "@/app/api/admin/services/route";
import * as serviceById from "@/app/api/admin/services/[id]/route";
import * as staff from "@/app/api/admin/staff/route";
import * as invites from "@/app/api/admin/invites/route";
import * as inviteById from "@/app/api/admin/invites/[id]/route";
import * as inviteResend from "@/app/api/admin/invites/[id]/resend/route";
import * as resetLink from "@/app/api/admin/members/[id]/reset-link/route";
import * as publicOrg from "@/app/api/public/[slug]/route";

/**
 * Two independent businesses (A and B). Everything A does through the API must be scoped to A:
 * B's bookings, services, members and invites must be invisible and immutable to A.
 */
describe("tenant isolation", () => {
  let a: TestUser, b: TestUser, bStaff: TestUser;
  let orgA: string, orgB: string;
  let bBookingId: string, bServiceId: string, bInviteId: string, bStaffMemberId: string;
  const date = futureWeekday();

  const book = (u: TestUser, customer: string) =>
    bookings.POST(
      req("/api/bookings", {
        method: "POST",
        cookie: u.cookie,
        body: { action: "create", req: { customer, email: `${customer.toLowerCase()}@cust.test`, category: "appointment", service: "Tenant svc", resource: "Room T", date, time: "10:00", durationMin: 30 } },
      }),
    );

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    await signUp("demo-owner@tenancy.test"); // claims the demo org so A and B get their own
    a = await signUp("owner-a@tenancy.test", { businessName: "Business A" });
    b = await signUp("owner-b@tenancy.test", { businessName: "Business B" });
    bStaff = await signUp("staff-b@tenancy.test");
    orgA = (await memberOf(a.id)).organizationId;
    orgB = (await memberOf(b.id)).organizationId;
    await moveToOrg(bStaff.id, orgB, "staff");
    bStaffMemberId = (await memberOf(bStaff.id)).id;
    expect(orgA).not.toBe(orgB);

    const rb = await (await book(b, "Bravo")).json();
    expect(rb.ok).toBe(true);
    bBookingId = rb.booking.id;
    const ra = await (await book(a, "Alpha")).json();
    expect(ra.ok).toBe(true);

    const svc = await (await services.POST(req("/api/admin/services", { method: "POST", cookie: b.cookie, body: { name: "B only service", durationMin: 45, resource: "B room" } }))).json();
    bServiceId = svc.service.id;
    const inv = await (await invites.POST(req("/api/admin/invites", { method: "POST", cookie: b.cookie, body: { email: "new-b@tenancy.test", role: "staff" } }))).json();
    bInviteId = inv.invite.id;
  });

  it("session context resolves each user to their own org", async () => {
    const ctxA = await getContextFromHeaders(new Headers({ cookie: a.cookie }));
    const ctxB = await getContextFromHeaders(new Headers({ cookie: b.cookie }));
    expect(ctxA?.org.id).toBe(orgA);
    expect(ctxB?.org.id).toBe(orgB);
  });

  it("GET /api/state only returns the caller's bookings, audit and notifications", async () => {
    const s = await (await state.GET(req("/api/state", { cookie: a.cookie }))).json();
    expect(s.org.id).toBe(orgA);
    expect(s.state.bookings.map((x: { customer: string }) => x.customer)).toEqual(["Alpha"]);
    expect(s.state.audit.every((x: { bookingId: string | null }) => x.bookingId !== bBookingId)).toBe(true);
    expect(s.state.notifications.every((x: { bookingId: string }) => x.bookingId !== bBookingId)).toBe(true);
  });

  it("data-access layer is org-scoped", async () => {
    const st = await loadState(orgA);
    expect(st.bookings.some((x) => x.id === bBookingId)).toBe(false);
    const svcs = await listServices(orgA);
    expect(svcs.some((s) => s.id === bServiceId)).toBe(false);
  });

  it("A can't reschedule or cancel B's booking", async () => {
    const r1 = await (await bookings.POST(req("/api/bookings", { method: "POST", cookie: a.cookie, body: { action: "cancel", bookingId: bBookingId } }))).json();
    expect(r1.ok).toBe(false);
    const r2 = await (await bookings.POST(req("/api/bookings", { method: "POST", cookie: a.cookie, body: { action: "reschedule", bookingId: bBookingId, date, time: "14:00" } }))).json();
    expect(r2.ok).toBe(false);
    const [row] = await getDb().select().from(schema.booking).where(eq(schema.booking.id, bBookingId));
    expect(row).toMatchObject({ organizationId: orgB, status: "confirmed", time: "10:00" });
  });

  it("A can't list, edit or delete B's services", async () => {
    const list = await (await services.GET(req("/api/admin/services", { cookie: a.cookie }))).json();
    expect(list.services.some((s: { id: string }) => s.id === bServiceId)).toBe(false);
    const patch = await serviceById.PATCH(req(`/api/admin/services/${bServiceId}`, { method: "PATCH", cookie: a.cookie, body: { name: "pwned" } }), params({ id: bServiceId }));
    expect(patch.status).toBe(404);
    await serviceById.DELETE(req(`/api/admin/services/${bServiceId}`, { method: "DELETE", cookie: a.cookie }), params({ id: bServiceId }));
    const [row] = await getDb().select().from(schema.service).where(eq(schema.service.id, bServiceId));
    expect(row).toMatchObject({ name: "B only service", organizationId: orgB });
  });

  it("A can't see, remove or reset B's members", async () => {
    const team = await (await staff.GET(req("/api/admin/staff", { cookie: a.cookie }))).json();
    expect(team.members.map((m: { email: string }) => m.email)).toEqual(["owner-a@tenancy.test"]);
    expect((await staff.DELETE(req("/api/admin/staff", { method: "DELETE", cookie: a.cookie, body: { memberId: bStaffMemberId } }))).status).toBe(404);
    expect((await resetLink.POST(req(`/api/admin/members/${bStaffMemberId}/reset-link`, { method: "POST", cookie: a.cookie }), params({ id: bStaffMemberId }))).status).toBe(404);
    expect(await memberOf(bStaff.id)).toMatchObject({ organizationId: orgB });
  });

  it("A can't see, revoke or re-issue B's invites", async () => {
    const team = await (await staff.GET(req("/api/admin/staff", { cookie: a.cookie }))).json();
    expect(team.invites.some((i: { id: string }) => i.id === bInviteId)).toBe(false);
    expect((await inviteById.DELETE(req(`/api/admin/invites/${bInviteId}`, { method: "DELETE", cookie: a.cookie }), params({ id: bInviteId }))).status).toBe(404);
    expect((await inviteResend.POST(req(`/api/admin/invites/${bInviteId}/resend`, { method: "POST", cookie: a.cookie }), params({ id: bInviteId }))).status).toBe(404);
    const [row] = await getDb().select().from(schema.teamInvite).where(and(eq(schema.teamInvite.id, bInviteId), eq(schema.teamInvite.organizationId, orgB)));
    expect(row.revokedAt).toBeNull();
  });

  it("FlowAI tools are scoped to the caller's org", async () => {
    const ctxA = (await getContextFromHeaders(new Headers({ cookie: a.cookie })))!;
    const tools = assistantTools(ctxA);
    const opts = { toolCallId: "t1", messages: [] };
    const byId = (await tools.listBookings.execute!({ bookingId: bBookingId, status: "all" }, opts)) as { count: number };
    expect(byId.count).toBe(0);
    const all = (await tools.listBookings.execute!({ status: "all" }, opts)) as { bookings: { customer: string }[] };
    expect(all.bookings.map((x) => x.customer)).toEqual(["Alpha"]);
    const svc = (await tools.listServices.execute!({}, opts)) as { name: string }[];
    expect(svc.some((s) => s.name === "B only service")).toBe(false);
    const rs = (await tools.rescheduleBooking.execute!({ bookingId: bBookingId, date, time: "15:00" }, opts)) as { ok: boolean };
    expect(rs.ok).toBe(false);
  });

  it("the public booking page only exposes that org's active services", async () => {
    const [bOrg] = await getDb().select().from(schema.organization).where(eq(schema.organization.id, orgB));
    const res = await (await publicOrg.GET(req(`/api/public/${bOrg.slug}`), params({ slug: bOrg.slug }))).json();
    expect(res.org.name).toBe("Business B");
    expect(res.services.map((s: { name: string }) => s.name)).toContain("B only service");
    expect(JSON.stringify(res)).not.toContain(orgA);
  });
});
