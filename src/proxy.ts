import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic auth check: no session cookie → redirect to /sign-in.
 * The real check (session lookup in Postgres) happens in the dashboard layout and every API route.
 */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const url = new URL("/sign-in", request.url);
    if (request.nextUrl.pathname !== "/") url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except public pages, auth/API routes and static assets.
  matcher: ["/((?!api/|book/|sign-in|sign-up|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp|txt)$).*)"],
};
