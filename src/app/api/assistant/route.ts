import { connection } from "next/server";
import { createHash } from "node:crypto";
import { convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { requireApi } from "@/lib/server/context";
import { assistantTools } from "@/lib/server/assistant-tools";
import { listServices, orgToday } from "@/lib/server/pipeline";

/**
 * FlowAI Assistant backend — Vercel AI Gateway via the AI SDK, with booking tools.
 * Auth: on Vercel the deployment's OIDC token is used automatically (no key stored).
 * Locally, `vercel env pull` provides VERCEL_OIDC_TOKEN, or set AI_GATEWAY_API_KEY.
 * Optional AI_GATEWAY_MODEL overrides the default model.
 */
const DEFAULT_MODEL = "openai/gpt-4.1-mini";
export const maxDuration = 60;

function config() {
  const configured = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);
  return { configured, model: process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL };
}

export async function GET() {
  await connection();
  const { configured, model } = config();
  return Response.json(configured ? { configured: true, model } : { configured: false });
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function POST(req: Request) {
  const ctx = await requireApi(req);
  if (ctx instanceof Response) return ctx;
  const { configured, model } = config();
  if (!configured) {
    return Response.json({ error: "The AI backend isn't connected. Run `vercel env pull` (OIDC) or set AI_GATEWAY_API_KEY." }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { messages?: unknown } | null;
  const tools = assistantTools(ctx);
  const validated = await safeValidateUIMessages<UIMessage>({ messages: Array.isArray(body?.messages) ? body!.messages.slice(-30) : [],
    tools: tools as unknown as NonNullable<Parameters<typeof safeValidateUIMessages>[0]["tools"]>,
  });
  if (!validated.success) return Response.json({ error: "Invalid messages" }, { status: 400 });

  const today = orgToday(ctx.org);
  const dow = DAYS[new Date(`${today.date}T12:00:00Z`).getUTCDay()];
  const hours = DAYS.map((d, i) => {
    const h = ctx.org.hours[String(i) as "0"];
    return `${d} ${h ? `${h.open}–${h.close}` : "closed"}`;
  }).join(", ");
  const services = (await listServices(ctx.org.id, true)).map((s) => `${s.name} (${s.durationMin}m, ${s.resource})`).join("; ");

  const system = `You are FlowAI, the assistant inside FLOWOPS for the business "${ctx.org.name}". You are talking to ${ctx.user.name} (${ctx.role}).
Today is ${dow} ${today.date}, local time ${today.time} (${ctx.org.timeZone}). Interpret relative dates ("tomorrow", "next Tuesday") from this.
Business hours: ${hours}. Services: ${services || "none configured yet"}.
You can list services and bookings, check availability, and create, reschedule or cancel bookings with your tools. Every change runs through the FLOWOPS pipeline (Intent → Booking → Availability → Calendar → Notification → Audit) and is audit-logged.
Rules: Use checkAvailability before proposing times. Never invent booking IDs: if the user gives one, use it as-is; otherwise find it with listBookings (search by customer, without a date filter unless one was given). To create a booking you need customer name, email, service, date and time; ask for anything missing. If a pipeline step is marked simulated, say so (e.g. "calendar event simulated, no email actually sent").
Cancelling requires the user's confirmation in the UI; if a cancellation is not approved, do not retry it.
Other FLOWOPS pages (Network, Security, Automation, Analytics samples) show sample data — never present sample numbers as real. Be concise.`;

  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(validated.data, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: stepCountIs(8),
    maxOutputTokens: 1500,
    experimental_toolApprovalSecret: createHash("sha256").update(`flowops:approval:${process.env.BETTER_AUTH_SECRET ?? ""}`).digest(),
    onError: ({ error }) => console.error("FlowAI error", error),
  });
  return result.toUIMessageStreamResponse({
    originalMessages: validated.data,
    onError: (error) =>
      /rate limit/i.test(String((error as Error)?.message ?? error))
        ? "FlowAI is busy (AI usage limit reached for this minute). Please wait about a minute and try again."
        : "FlowAI couldn't answer right now (AI service error). Please try again.",
  });
}
