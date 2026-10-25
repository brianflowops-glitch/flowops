import { connection } from "next/server";

/**
 * FlowAI Assistant backend.
 * - No OPENAI_API_KEY → reports "not connected" (the app still works).
 * - With a key → forwards the chat to OpenAI's Chat Completions API.
 * Optional OPENAI_MODEL overrides the default model.
 */
const DEFAULT_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You are FlowAI, the assistant inside FLOWOPS — a Unified Operations Intelligence Platform built around the "FLOWOPS Agent Matrix".
Modules: FLOWOPS Core (orchestration), FlowNet (network), FlowSec (security), FlowBiz (business/booking), FlowAI (AI engine), FlowConnect (integrations), FlowPulse (monitoring).
Booking pipeline: FLOWOPS CORE -> Intent Agent -> Booking Agent -> Availability Agent -> Calendar Agent -> Notification Agent -> Audit Agent -> BOOKING VERIFIED.
In this v1 prototype only the Booking Engine is functional; it runs in the user's browser, and the Calendar and Notification agents are SIMULATED (no real events or messages).
Network, Security, Automation and Analytics pages show sample data that is not connected to real systems — never present sample numbers as real.
Roadmap: Postgres persistence, backend API, auth/permissions, Google Calendar test calendar then live, real notifications, event bus, durable workflows.
Be concise and practical.`;

function config() {
  const key = process.env.OPENAI_API_KEY;
  return { key, model: process.env.OPENAI_MODEL || DEFAULT_MODEL };
}

export async function GET() {
  await connection();
  const { key, model } = config();
  return Response.json(key ? { configured: true, model } : { configured: false });
}

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(request: Request) {
  const { key, model } = config();
  if (!key) {
    return Response.json(
      { configured: false, error: "The AI backend isn't connected yet. Set OPENAI_API_KEY to enable FlowAI." },
      { status: 503 },
    );
  }

  let body: { messages?: Msg[]; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const messages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!messages.length) return Response.json({ error: "No messages" }, { status: 400 });

  const contextNote = body.context
    ? `\n\nCurrent in-browser booking engine state (simulated data entered by the user):\n${JSON.stringify(body.context).slice(0, 6000)}`
    : "";

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT + contextNote }, ...messages],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return Response.json({ error: `OpenAI error: ${data?.error?.message ?? res.statusText}` }, { status: 502 });
    }
    return Response.json({ reply: data.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    return Response.json({ error: `Could not reach OpenAI: ${String(e)}` }, { status: 502 });
  }
}
