import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ADMIN_HOST = "adminpanel.rxvision.gr";

// ENFORCED Content-Security-Policy (H-1). The app's pages are statically pre-rendered, so a per-request
// nonce cannot be attached to their <script> tags — a nonce+strict-dynamic policy would white-screen the
// app. We therefore enforce the pragmatic policy: same-origin + inline scripts allowed (Next's own inline
// bootstrap), but NO external scripts, NO objects, connect/img/frame locked to self, and framing denied.
// No external origins: Inter is self-hosted via next/font/google, so the policy is fully same-origin.
// `report-uri` stays active so any missed resource still surfaces at /api/v1/security/csp-report.
// (Follow-up hardening: self-host Inter to drop the Google-Fonts exception + the Google IP leak.)
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
  "report-uri /api/v1/security/csp-report",
].join("; ");

export function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0] ?? "";
  const { pathname } = request.nextUrl;

  if (host === ADMIN_HOST) {
    const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/_next") || pathname.startsWith("/api");
    if (!isAdminPath) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin";
      return NextResponse.redirect(url);
    }
  }

  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", CSP);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons|manifest|sw.js|healthz).*)"],
};
