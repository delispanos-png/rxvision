"use client";

import { useEffect } from "react";

/** PWA caching is DISABLED (the old next-pwa SW served stale builds and crashed clients).
 * This now does the opposite of registering: it unregisters any leftover service worker and
 * clears its caches, so returning users recover cleanly. Pairs with the kill-switch /sw.js.
 *
 * ⚠ ΕΞΑΙΡΕΣΗ (24/11/2026): ο service worker των ειδοποιήσεων της πύλης (`/portal-sw.js`, scope `/portal/`,
 * βλ. lib/push.ts) ΔΕΝ είναι cache — είναι η συνδρομή push. Το «σβήσε όλους» τον ξήλωνε σε ΚΑΘΕ φόρτωση
 * σελίδας → η συνδρομή χανόταν, οι ειδοποιήσεις δεν έφταναν ποτέ μετά την επόμενη σελίδα και η πύλη ζητούσε
 * ξανά «Ενεργοποίηση» σε κάθε σύνδεση (Ελλάδα & Κύπρος). */
const isPortalPush = (r: ServiceWorkerRegistration) =>
  [r.active, r.waiting, r.installing].some((w) => w?.scriptURL.endsWith("/portal-sw.js"));

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.filter((r) => !isPortalPush(r)).forEach((r) => r.unregister()))
        .catch(() => {});
    }
    if (typeof caches !== "undefined") {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
  }, []);
  return null;
}
