import { z } from "zod";

export const CATEGORY = z.enum(["appointment", "travel", "restaurant", "workforce"]);
export const AGENT = z.enum(["IntentAgent", "BookingAgent", "AvailabilityAgent", "CalendarAgent", "NotificationAgent", "AuditAgent"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const time = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM");

export const bookingRequest = z.object({
  customer: z.string().trim().min(1).max(120),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(40).optional(),
  smsConsent: z.boolean().optional(),
  category: CATEGORY,
  service: z.string().trim().min(1).max(120),
  resource: z.string().trim().min(1).max(120),
  date,
  time,
  durationMin: z.coerce.number().int().min(15).max(480),
  notes: z.string().max(1000).optional(),
});

export const bookingAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), req: bookingRequest, failAgent: AGENT.optional() }),
  z.object({ action: z.literal("reschedule"), bookingId: z.string().min(1), date, time, failAgent: AGENT.optional() }),
  z.object({ action: z.literal("cancel"), bookingId: z.string().min(1), failAgent: AGENT.optional() }),
]);

const dayHours = z.object({ open: time, close: time }).nullable();
export const weekHours = z.object({ "0": dayHours, "1": dayHours, "2": dayHours, "3": dayHours, "4": dayHours, "5": dayHours, "6": dayHours });

export const orgPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3–40 chars: a–z, 0–9, dashes")
    .optional(),
  timeZone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown time zone")
    .optional(),
  hours: weekHours.optional(),
  publicBooking: z.boolean().optional(),
  googleCalendarId: z.string().trim().max(200).nullable().optional(),
});

export const serviceInput = z.object({
  name: z.string().trim().min(1).max(120),
  category: CATEGORY.default("appointment"),
  durationMin: z.coerce.number().int().min(15).max(480),
  resource: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

// For PATCH: every field optional and no defaults, so a partial update
// (e.g. toggling `active`) never resets category or sortOrder.
// (zod v4 still applies .default() inside .partial().)
export const serviceUpdate = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: CATEGORY,
    durationMin: z.coerce.number().int().min(15).max(480),
    resource: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable(),
    active: z.boolean(),
    sortOrder: z.coerce.number().int(),
  })
  .partial();

export const publicBook = z.object({
  serviceId: z.string().min(1),
  date,
  time,
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  smsConsent: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
  website: z.string().optional(), // honeypot
});

export function badRequest(err: z.ZodError | string) {
  const message = typeof err === "string" ? err : err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  return Response.json({ error: message }, { status: 400 });
}

export async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
