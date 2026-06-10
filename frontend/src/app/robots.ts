import type { MetadataRoute } from "next";

const BASE = "https://app.rxvision.gr";

// The app is mostly an authenticated SaaS — only the public surface is indexable; the
// tenant/admin areas and the API are disallowed.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/login", "/register", "/forgot-password", "/privacy", "/terms"],
        disallow: [
          "/dashboard", "/prescriptions", "/doctors", "/patients", "/icd10", "/profitability",
          "/future", "/orders", "/closing", "/pharmacyone", "/advisor", "/nutrition",
          "/settings", "/account", "/onboarding", "/admin", "/api",
        ],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
  };
}
