import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireApi } from "@/lib/server/context";
import { encrypt, verify } from "@/lib/server/integrations/crypto";
import { exchangeCode, googleConfigured, googleRedirectUri } from "@/lib/server/integrations/google";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => Response.redirect(`${url.origin}/admin?google=${q}`, 303);
  if (!googleConfigured()) return back("not-configured");
  const ctx = await requireApi(req, { owner: true });
  if (ctx instanceof Response) return back("sign-in-required");
  if (url.searchParams.get("error")) return back("denied");
  const raw = verify(url.searchParams.get("state") ?? "");
  const [orgId, userId, ts] = raw?.split(":") ?? [];
  if (!raw || orgId !== ctx.org.id || userId !== ctx.user.id || Date.now() - Number(ts) > 15 * 60_000) return back("bad-state");
  try {
    const tokens = await exchangeCode(url.searchParams.get("code") ?? "", googleRedirectUri(url.origin));
    if (!tokens.refresh_token) return back("no-refresh-token");
    let email: string | null = null;
    if (tokens.id_token) {
      try {
        email = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()).email ?? null;
      } catch {}
    }
    await getDb()
      .update(schema.organization)
      .set({ googleRefreshTokenEnc: encrypt(tokens.refresh_token), googleAccountEmail: email })
      .where(eq(schema.organization.id, ctx.org.id));
    return back("connected");
  } catch {
    return back("error");
  }
}
