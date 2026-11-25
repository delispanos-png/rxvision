"use client";

import { useEffect } from "react";

/** ΠΟΛΙΤΙΚΗ ΠΡΟΣΒΑΣΗΣ (25/11/2026) — browser που οδηγείται από script/agent (`navigator.webdriver === true`).
 *
 * Οι AI browsers με αναγνωρίσιμο user agent κόβονται ήδη πριν φορτώσει η σελίδα (middleware.ts + backend).
 * Αυτό πιάνει όσους «κρύβουν» τον user agent αλλά τρέχουν μέσω WebDriver/CDP: μόλις υπάρχει token
 * χρήστη, στέλνει beacon → ο server κλειδώνει τον λογαριασμό 24 ώρες και ακυρώνει τις συνεδρίες. Εδώ
 * σβήνουμε τα tokens και ξαναφορτώνουμε → ο χρήστης βλέπει το login (που αρνείται με «κλειδώθηκε»).
 * Ελέγχει ανά 15″, ώστε να πιάσει και τη σύνδεση που γίνεται ΜΕΤΑ το άνοιγμα της σελίδας. */
const SURFACES: { access: string; refresh: string }[] = [
  { access: "access_token", refresh: "refresh_token" },
  { access: "patient_access_token", refresh: "patient_refresh_token" },
  { access: "padmin_access_token", refresh: "padmin_refresh_token" },
];

export function AutomationBeacon() {
  useEffect(() => {
    if (typeof navigator === "undefined" || navigator.webdriver !== true) return;
    const sent = new Set<string>();
    const check = () => {
      for (const s of SURFACES) {
        let tok: string | null = null;
        try { tok = window.localStorage.getItem(s.access); } catch { tok = null; }
        if (!tok || sent.has(tok)) continue;
        sent.add(tok);
        fetch("/api/v1/access/beacon", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ signal: "webdriver" }),
          keepalive: true,
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.locked) {
              try {
                window.localStorage.removeItem(s.access);
                window.localStorage.removeItem(s.refresh);
              } catch { /* ignore */ }
              window.location.reload();
            }
          })
          .catch(() => {});
      }
    };
    check();
    const id = window.setInterval(check, 15000);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
