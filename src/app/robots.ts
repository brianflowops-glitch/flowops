import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/terms", "/privacy", "/sms-consent"], disallow: ["/api/", "/admin", "/booking", "/invite/", "/reset-password", "/verify-email"] },
    sitemap: "https://flowopsagent.ai/sitemap.xml",
  };
}
