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
// MICROSOFT CLARITY (παρακολούθηση συμπεριφοράς, adminpanel → Ενσωματώσεις). Χωρίς αυτές τις
// εξαιρέσεις ο browser ΜΠΛΟΚΑΡΕ σιωπηλά το script: 140 από 151 αναφορές CSP (28/09/2026) ήταν ακριβώς
// `script-src-elem https://www.clarity.ms/tag/…` — και το Clarity έμενε στο «Almost there!» χωρίς
// ούτε μία επίσκεψη. Οι origins είναι αυτές που δίνει η Microsoft για CSP: το script από
// www/scripts.clarity.ms, η αποστολή δεδομένων σε *.clarity.ms και c.bing.com.
// ΜΟΝΟ σε app/my — ΠΟΤΕ στο adminpanel, που σκόπιμα δεν παρακολουθείται.
const CLARITY = {
  script: "https://www.clarity.ms https://*.clarity.ms",
  connect: "https://*.clarity.ms https://c.bing.com",
  img: "https://*.clarity.ms https://c.bing.com",
};

function csp(withClarity: boolean): string {
  return [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${withClarity ? ` ${CLARITY.script}` : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${withClarity ? ` ${CLARITY.img}` : ""}`,
  "font-src 'self' data:",
  `connect-src 'self'${withClarity ? ` ${CLARITY.connect}` : ""}`,
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
}

const CSP = csp(false);                 // adminpanel & 404
const CSP_TRACKED = csp(true);          // app.rxvision.gr, my.rxvision.gr

export function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0] ?? "";
  const { pathname } = request.nextUrl;

  // HOST-PINNING (ασφάλεια): το back-office (/admin) επιτρέπεται ΜΟΝΟ στο adminpanel host. Σε app/my
  // επιστρέφουμε 404 ώστε το admin login/bundle να μην είναι ούτε ανακαλύψιμο ούτε επιτεύξιμο από λάθος
  // origin (τα /platform APIs απαιτούν ούτως ή άλλως padmin token — αυτό κλείνει την επιφάνεια στο UI).
  if (pathname.startsWith("/admin") && host !== ADMIN_HOST) {
    const notFound = new NextResponse(null, { status: 404 });
    notFound.headers.set("Content-Security-Policy", CSP);
    return notFound;
  }

  if (host === ADMIN_HOST) {
    const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/_next") || pathname.startsWith("/api");
    if (!isAdminPath) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin";
      return NextResponse.redirect(url);
    }
  }

  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", host === ADMIN_HOST ? CSP : CSP_TRACKED);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons|manifest|sw.js|healthz).*)"],
};
