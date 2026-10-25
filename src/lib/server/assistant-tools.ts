import "server-only";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import type { PipelineResult } from "@/lib/booking/types";
import type { OrgContext } from "./context";
import { availability, listServices, runPipeline } from "./pipeline";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD in the business's local time zone");
const time = z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM 24-hour local time");

function summarize(r: PipelineResult) {
  return {
    ok: r.ok,
    outcome: r.outcome,
    error: r.error,
    suggestion: r.suggestion,
    booking: r.booking && {
      id: r.booking.id,
      customer: r.booking.customer,
      service: r.booking.service,
      resource: r.booking.resource,
      date: r.booking.date,
      time: r.booking.time,
      durationMin: r.booking.durationMin,
      status: r.booking.status,
    },
    pipeline: r.steps.map((s) => ({ agent: s.agent, status: s.status, simulated: s.simulated, message: s.message })),
  };
}

async function findService(orgId: string, name: string) {
  const services = await listServices(orgId, true);
  const n = name.trim().toLowerCase();
  return { svc: services.find((s) => s.name.toLowerCase() === n) ?? services.find((s) => s.name.toLowerCase().includes(n)), services };
}

/** FlowAI tools — every write goes through the same 6-agent pipeline, scoped to the signed-in user's org. */
export function assistantTools(ctx: OrgContext) {
  const actor = `flowai:${ctx.user.email}`;
  return {
    listServices: tool({
      description: "List the bookable services (name, duration, resource) for this business.",
      inputSchema: z.object({}),
      execute: async () =>
        (await listServices(ctx.org.id, true)).map((s) => ({ name: s.name, durationMin: s.durationMin, resource: s.resource, category: s.category })),
    }),
    listBookings: tool({
      description: "List bookings, optionally filtered by booking ID, date range, status or customer name/email. Omit filters you don't need.",
      inputSchema: z.object({
        bookingId: z.string().optional().describe("Exact booking ID, e.g. BK-…"),
        from: date.optional(),
        to: date.optional(),
        status: z.enum(["confirmed", "cancelled", "all"]).default("confirmed"),
        customer: z.string().optional().describe("Substring match on customer name or email"),
      }),
      execute: async ({ bookingId, from, to, status, customer }) => {
        const conds = [eq(schema.booking.organizationId, ctx.org.id)];
        if (bookingId) conds.push(eq(schema.booking.id, bookingId.trim().toUpperCase()));
        if (from) conds.push(gte(schema.booking.date, from));
        if (to) conds.push(lte(schema.booking.date, to));
        if (status !== "all" && !bookingId) conds.push(eq(schema.booking.status, status));
        let rows = await getDb()
          .select()
          .from(schema.booking)
          .where(and(...conds))
          .orderBy(asc(schema.booking.date), asc(schema.booking.time))
          .limit(200);
        if (customer?.trim()) {
          const q = customer.toLowerCase();
          rows = rows.filter((b) => b.customer.toLowerCase().includes(q) || b.email.toLowerCase().includes(q));
        }
        return {
          count: rows.length,
          bookings: rows.slice(0, 50).map((b) => ({
            id: b.id,
            customer: b.customer,
            email: b.email,
            service: b.service,
            resource: b.resource,
            date: b.date,
            time: b.time,
            durationMin: b.durationMin,
            status: b.status,
            source: b.source,
          })),
        };
      },
    }),
    checkAvailability: tool({
      description: "Get free start times for a service on a date (respects business hours and existing bookings).",
      inputSchema: z.object({ service: z.string().describe("Service name"), date }),
      execute: async ({ service, date }) => {
        const { svc, services } = await findService(ctx.org.id, service);
        if (!svc) return { error: `Unknown service "${service}". Available: ${services.map((s) => s.name).join(", ")}` };
        const slots = await availability(ctx.org, { resource: svc.resource, date, durationMin: svc.durationMin });
        return { service: svc.name, resource: svc.resource, durationMin: svc.durationMin, date, slots };
      },
    }),
    createBooking: tool({
      description: "Create a booking through the FLOWOPS pipeline (Intent → Booking → Availability → Calendar → Notification → Audit).",
      inputSchema: z.object({
        customer: z.string().min(1),
        email: z.string().describe("Customer email"),
        phone: z.string().optional(),
        service: z.string().describe("Service name (see listServices)"),
        date,
        time,
        notes: z.string().optional(),
      }),
      execute: async (i) => {
        const { svc, services } = await findService(ctx.org.id, i.service);
        if (!svc) return { ok: false, error: `Unknown service "${i.service}". Available: ${services.map((s) => s.name).join(", ")}` };
        const r = await runPipeline(
          ctx.org,
          {
            action: "create",
            req: {
              customer: i.customer,
              email: i.email,
              ...(i.phone ? { phone: i.phone } : {}),
              category: svc.category,
              service: svc.name,
              resource: svc.resource,
              date: i.date,
              time: i.time,
              durationMin: svc.durationMin,
              ...(i.notes ? { notes: i.notes } : {}),
            },
          },
          { actor, source: "assistant" },
        );
        return summarize(r);
      },
    }),
    rescheduleBooking: tool({
      description: "Move an existing booking to a new date/time (conflict-checked).",
      inputSchema: z.object({ bookingId: z.string(), date, time }),
      execute: async ({ bookingId, date, time }) =>
        summarize(await runPipeline(ctx.org, { action: "reschedule", bookingId, date, time }, { actor, source: "assistant" })),
    }),
    cancelBooking: tool({
      description: "Cancel a booking. The user must confirm in the UI before this runs.",
      inputSchema: z.object({ bookingId: z.string(), reason: z.string().optional() }),
      needsApproval: true,
      execute: async ({ bookingId }) => summarize(await runPipeline(ctx.org, { action: "cancel", bookingId }, { actor, source: "assistant" })),
    }),
  };
}
