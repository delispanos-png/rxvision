import type { MetadataRoute } from "next";

const BASE = "https://app.rxvision.gr";

// Public, indexable routes only (the authenticated app is excluded — see robots.ts).
export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["/", "/login", "/register", "/forgot-password", "/privacy", "/terms"];
  return routes.map((path) => ({
    url: `${BASE}${path}`,
    changeFrequency: "monthly" as const,
    priority: path === "/" ? 1 : 0.5,
  }));
}
