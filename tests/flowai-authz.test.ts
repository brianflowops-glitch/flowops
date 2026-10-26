import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { initTestDb } from "./helpers/db";
import { futureWeekday, memberOf, moveToOrg, seedDemoOrg, signUp, type TestUser } from "./helpers/app";
import { getDb, schema } from "@/lib/db";
import { getContextFromHeaders, type OrgContext, type Role } from "@/lib/server/context";
import { assistantTools } from "@/lib/server/assistant-tools";
import { FLOWAI_POLICY, canUseFlowAiTool, flowAiNeedsApproval } from "@/lib/server/flowai-policy";

describe("FLOWAI_POLICY", () => {
  it("every mutating tool requires approval; read tools don't", () => {
    for (const [name, p] of Object.entries(FLOWAI_POLICY)) {
      expect(flowAiNeedsApproval(name), name).toBe(p.kind !== "read");
    }
    expect(flowAiNeedsApproval("cancelBooking")).toBe(true);
    expect(flowAiNeedsApproval("createBooking")).toBe(true);
    expect(flowAiNeedsApproval("rescheduleBooking")).toBe(true);
  });
  it("unknown tools are denied for every role and treated as needing approval", () => {
    for (const r of ["owner", "admin", "staff"] as Role[]) expect(canUseFlowAiTool(r, "deleteOrganization")).toBe(false);
    expect(flowAiNeedsApproval("deleteOrganization")).toBe(true);
  });
  it("an unknown role gets nothing", () => {
    expect(canUseFlowAiTool("viewer" as Role, "listBookings")).toBe(false);
  });
});

describe("assistantTools authorization", () => {
  let owner: TestUser, staffer: TestUser;
  let ownerCtx: OrgContext, staffCtx: OrgContext;
  const date = futureWeekday();

  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    owner = await signUp("owner@flowai.test"); // demo org owner (has the demo services)
    staffer = await signUp("staff@flowai.test");
    await moveToOrg(staffer.id, (await memberOf(owner.id)).organizationId, "staff");
    ownerCtx = (await getContextFromHeaders(new Headers({ cookie: owner.cookie })))!;
    staffCtx = (await getContextFromHeaders(new Headers({ cookie: staffer.cookie })))!;
  });

  it("exposes only the tools in the policy, with approval flags from the policy", () => {
    const tools = assistantTools(ownerCtx);
    expect(Object.keys(tools).sort()).toEqual(Object.keys(FLOWAI_POLICY).sort());
    for (const [name, t] of Object.entries(tools)) expect(t.needsApproval, name).toBe(flowAiNeedsApproval(name));
  });

  it("staff get the same booking tools as on the dashboard (parity with /api/bookings)", () => {
    expect(Object.keys(assistantTools(staffCtx)).sort()).toEqual(Object.keys(FLOWAI_POLICY).sort());
  });

  it("a role outside the policy gets no tools at all", () => {
    expect(Object.keys(assistantTools({ ...ownerCtx, role: "viewer" as Role }))).toEqual([]);
  });

  it("execute() re-checks the role even if a tool object is reused after a role change", async () => {
    const ctx = { ...staffCtx };
    const tools = assistantTools(ctx);
    ctx.role = "viewer" as Role; // simulate demotion mid-conversation
    const r = (await tools.listBookings.execute!({ status: "all" }, { toolCallId: "x", messages: [] })) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/can't use listBookings/);
  });

  it("the model can't create a booking without the user's approval", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "createBooking",
            input: JSON.stringify({ customer: "No Approval", email: "na@cust.test", service: "Consultation", date, time: "10:00" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
    const result = await generateText({ model, prompt: "book it", tools: assistantTools(staffCtx), stopWhen: stepCountIs(3) });
    const approvals = result.content.filter((c) => c.type === "tool-approval-request");
    expect(approvals).toHaveLength(1);
    expect(result.toolResults).toHaveLength(0);
    const rows = await getDb().select().from(schema.booking).where(eq(schema.booking.customer, "No Approval"));
    expect(rows).toHaveLength(0);
  });

  it("read tools run without approval", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "tool-call", toolCallId: "call_2", toolName: "listServices", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
    const result = await generateText({ model, prompt: "list", tools: assistantTools(staffCtx), stopWhen: stepCountIs(1) });
    expect(result.toolResults).toHaveLength(1);
    expect(result.content.some((c) => c.type === "tool-approval-request")).toBe(false);
  });
});
