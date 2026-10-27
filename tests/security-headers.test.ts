import { describe, expect, it } from "vitest";
import nextConfig, { NO_FRAMING_HEADERS, SECURITY_HEADERS } from "../next.config";

describe("security headers", () => {
  it("sets baseline headers on every path and blocks framing everywhere except /book/*", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    expect(all.headers).toEqual(SECURITY_HEADERS);
    const noFrame = rules.find((r) => r.headers === NO_FRAMING_HEADERS)!;
    const re = new RegExp(`^${noFrame.source.replace("/(", "/(").replace(/^\//, "\\/")}$`);
    for (const p of ["/", "/admin", "/sign-in", "/invite/abc", "/api/state", "/booking"]) expect(re.test(p), p).toBe(true);
    for (const p of ["/book/acme", "/book/acme/x"]) expect(re.test(p), p).toBe(false);
    expect(NO_FRAMING_HEADERS.find((h) => h.key === "Content-Security-Policy")!.value).toBe("frame-ancestors 'none'");
  });
});
