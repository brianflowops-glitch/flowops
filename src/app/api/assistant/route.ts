import { connection } from "next/server";
import { streamText, type ModelMessage } from "ai";

/**
 * FlowAI Assistant backend — powered by Vercel AI Gateway via the AI SDK.
 * Auth: on Vercel the deployment's OIDC token is used automatically (no key stored).
 * Locally, `vercel env pull` provides VERCEL_OIDC_TOKEN, or set AI_GATEWAY_API_KEY.
 * Optional AI_GATEWAY_MODEL overrides the default model (a `provider/model` id from the gateway).
 */
const DEFAULT_MODEL = "openai/gpt-4.1-mini";

const SYSTEM_PROMPT = `You are FlowAI, the assistant inside FLOWOPS — a Unified Operations Intelligence Platform built around the "FLOWOPS Agent Matrix".
Modules: FLOWOPS Core (orchestration), FlowNet (network), FlowSec (security), FlowBiz (business/booking), FlowAI (AI engine), FlowConnect (integrations), FlowPulse (monitoring).
Booking pipeline: FLOWOPS CORE -> Intent Agent -> Booking Agent -> Availability Agent -> Calendar Agent -> Notification Agent -> Audit Agent -> BOOKING VERIFIED.
In this v1 prototype only the Booking Engine is functional; it runs in the user's browser, and the Calendar and Notification agents are SIMULATED (no real events or messages).
Network, Security, Automation and Analytics pages show sample data that is not connected to real systems — never present sample numbers as real.
Roadmap: Postgres persistence, backend API, auth/permissions, Google Calendar test calendar then live, real notifications, event bus, durable workflows.
Be concise and practical.`;

function config() {
  const configured = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);
  return { configured, model: process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL };
}

export async function GET() {
  await connection();
  const { configured, model } = config();
  return Response.json(configured ? { configured: true, model } : { configured: false });
}

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(request: Request) {
  const { configured, model } = config();
  if (!configured) {
    return Response.json(
      { configured: false, error: "The AI backend isn't connected. Run `vercel env pull` (OIDC) or set AI_GATEWAY_API_KEY." },
      { status: 503 },
    );
  }

  let body: { messages?: Msg[]; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const messages: ModelMessage[] = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!messages.length) return Response.json({ error: "No messages" }, { status: 400 });

  const contextNote = body.context
    ? `\n\nCurrent in-browser booking engine state (simulated data entered by the user):\n${JSON.stringify(body.context).slice(0, 6000)}`
    : "";

  const result = streamText({
    model,
    system: SYSTEM_PROMPT + contextNote,
    messages,
    maxOutputTokens: 1200,
  });

  // Stream plain text; surface gateway errors (auth, credits, rate limits) inline instead of an empty reply.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") controller.enqueue(encoder.encode(part.text));
          else if (part.type === "error") {
            console.error("FlowAI gateway error", part.error);
            controller.enqueue(encoder.encode("\n\n[FlowAI error: the AI service couldn't answer right now. Please try again.]"));
          }
        }
      } catch (e) {
        console.error("FlowAI stream failed", e);
        controller.enqueue(encoder.encode("\n\n[FlowAI error: the AI service couldn't answer right now. Please try again.]"));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
