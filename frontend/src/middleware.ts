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

// ΖΩΝΤΑΝΗ ΥΠΟΣΤΗΡΙΞΗ: η οθόνη του πελάτη που βλέπει ο supporter φορτώνει εικόνες και γραμματοσειρές
// από την εφαρμογή. Μόνο στο adminpanel, και μόνο εικόνες/γραμματοσειρές.
const APP_ASSETS = "https://app.rxvision.gr";

// ΦΩΤΟΓΡΑΦΙΕΣ ΕΙΔΩΝ ΚΥΠΡΟΥ: ο κατάλογος της PharmacyOne (services/cy/pharmacyone.py) δίνει δημόσιο
// σύνδεσμο εικόνας ανά είδος. Χωρίς αυτή την εξαίρεση ο browser τις μπλόκαρε και έβγαιναν «σπασμένες»
// (18/11/2026). ΜΟΝΟ εικόνες — κανένα script/σύνδεση από εκεί.
const PRODUCT_IMAGES = "https://image.cloudon.gr";

// REVOLUT: το παράθυρο πληρωμής φορτώνει script και iframe από τη Revolut. Χωρίς αυτές τις εξαιρέσεις ο
// browser το μπλοκάρει σιωπηλά. Μόνο σε app/my, το adminpanel δεν πληρώνει.
const REVOLUT = "https://merchant.revolut.com https://sandbox-merchant.revolut.com";

function csp(withClarity: boolean): string {
  return [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${withClarity ? ` ${CLARITY.script} ${REVOLUT}` : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${PRODUCT_IMAGES} ${withClarity ? CLARITY.img : APP_ASSETS}`,
  `font-src 'self' data:${withClarity ? "" : ` ${APP_ASSETS}`}`,
  `connect-src 'self'${withClarity ? ` ${CLARITY.connect} ${REVOLUT}` : ""}`,
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  `frame-src 'self' blob: https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com${withClarity ? ` ${REVOLUT}` : ""}`,
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

// ΠΟΛΙΤΙΚΗ ΠΡΟΣΒΑΣΗΣ (25/11/2026): AI browser / scripted browser → 403 σε ΚΑΘΕ σελίδα, πριν από οτιδήποτε
// άλλο (ακόμη και το login). Κανόνας ιδιοκτήτη: «το Claude Desktop δεν παίρνει ούτε ένα δεδομένο». Ο ΙΔΙΟΣ
// κανόνας με το backend (services/access_policy.py → AI_BROWSER_RE) — αλλαγή εδώ = αλλαγή κι εκεί.
// Το /healthz (έλεγχος υγείας LB/deploy με curl) είναι εκτός matcher.
const AI_BROWSER = /Claude\/\d|Comet\/\d|ChatGPT-Atlas|Atlas\/\d|HeadlessChrome|Playwright|Puppeteer|Selenium|PhantomJS|WebDriver|BrowserUse|Operator\/\d/i;
const BLOCKED_HTML = `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Η πρόσβαση δεν επιτρέπεται</title><meta name="robots" content="noindex"></head><body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#0f172a"><h1 style="font-size:20px">Η πρόσβαση δεν επιτρέπεται</h1><p>Η πρόσβαση μέσω AI browser ή αυτοματοποιημένου εργαλείου δεν επιτρέπεται. Το RxVision επεξεργάζεται δεδομένα υγείας.</p><p style="color:#64748b">Access through an AI browser or automated tool is not permitted. RxVision processes health data.</p><p style="color:#64748b">Ανοίξτε το RxVision σε κανονικό browser (Chrome, Edge, Firefox, Safari).</p></body></html>`;

export function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0] ?? "";
  const { pathname } = request.nextUrl;

  if (AI_BROWSER.test(request.headers.get("user-agent") ?? "")) {
    const blocked = new NextResponse(BLOCKED_HTML, { status: 403 });
    blocked.headers.set("Content-Type", "text/html; charset=utf-8");
    blocked.headers.set("Cache-Control", "no-store");
    blocked.headers.set("Content-Security-Policy", CSP);
    return blocked;
  }

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
