/** @type {import('next').NextConfig} */
const withPWA = require("next-pwa")({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
  runtimeCaching: [
    {
      // Analytics GETs: fast, refreshed in background.
      urlPattern: /\/api\/v1\/(dashboard|prescriptions|doctors|icd10|profitability).*/,
      handler: "StaleWhileRevalidate",
      options: { cacheName: "analytics", expiration: { maxAgeSeconds: 900 } },
    },
    {
      urlPattern: /\/api\/v1\/auth\/me/,
      handler: "NetworkFirst",
      options: { cacheName: "session" },
    },
    {
      urlPattern: /\.(?:js|css|woff2|png|svg)$/,
      handler: "CacheFirst",
      options: { cacheName: "static-assets" },
    },
  ],
});

module.exports = withPWA({
  reactStrictMode: true,
  output: "standalone",
  // Both gates ENABLED (2026-06-08): `tsc --noEmit` and `next lint`
  // (eslint-config-next core-web-vitals) are clean, so the build fails on type OR lint errors.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
});
