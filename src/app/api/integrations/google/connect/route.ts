import { requireApi } from "@/lib/server/context";
import { sign } from "@/lib/server/integrations/crypto";
import { GOOGLE_SCOPES, googleConfigured, googleRedirectUri } from "@/lib/server/integrations/google";

/** Owner starts the per-organization Google Calendar OAuth connection. */
export async function GET(req: Request) {
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return ctx;
  const origin = new URL(req.url).origin;
  if (!googleConfigured()) return Response.redirect(`${origin}/admin?google=not-configured`, 303);
  const state = sign(`${ctx.org.id}:${ctx.user.id}:${Date.now()}`);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(origin),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return Response.redirect(url.toString(), 303);
}
