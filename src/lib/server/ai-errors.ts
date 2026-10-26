/** Turns AI Gateway / AI SDK errors into short, friendly messages for the FlowAI panel. */
type ErrLike = { name?: string; message?: string; statusCode?: number; status?: number; type?: string; lastError?: unknown; errors?: unknown[]; cause?: unknown };

function chain(error: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length && out.length < 12) {
    const e = stack.pop();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const x = e as ErrLike;
    out.push(x);
    if (x.lastError) stack.push(x.lastError);
    if (Array.isArray(x.errors)) stack.push(...x.errors);
    if (x.cause) stack.push(x.cause);
  }
  return out;
}

export type AiErrorKind = "rate_limit" | "credits" | "auth" | "other";

export function classifyAiError(error: unknown): AiErrorKind {
  const errs = chain(error);
  const text = errs.map((e) => `${e.name ?? ""} ${e.type ?? ""} ${e.message ?? ""}`).join(" ") + (typeof error === "string" ? error : "");
  if (errs.some((e) => e.statusCode === 429 || e.status === 429 || e.name === "GatewayRateLimitError" || e.type === "rate_limit_exceeded") || /rate.?limit|too many requests|\b429\b/i.test(text))
    return "rate_limit";
  if (/insufficient.?funds|credit|quota|payment required|\b402\b/i.test(text)) return "credits";
  if (errs.some((e) => e.statusCode === 401 || e.name === "GatewayAuthenticationError")) return "auth";
  return "other";
}

export const AI_MESSAGES: Record<AiErrorKind, string> = {
  rate_limit: "FlowAI is getting a lot of requests right now (AI usage limit for this minute). Please wait about a minute and try again — nothing was changed.",
  credits: "FlowAI is paused because the AI usage credit has run out. Your bookings are fine; ask the workspace admin to top up AI Gateway credit.",
  auth: "FlowAI can't reach the AI service (connection not authorized). Your bookings are fine; please try again later.",
  other: "FlowAI couldn't answer right now (AI service error). Please try again.",
};

export function friendlyAiError(error: unknown) {
  return AI_MESSAGES[classifyAiError(error)];
}
