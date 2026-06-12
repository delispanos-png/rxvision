"use client";

import { useEffect } from "react";

/** PWA caching is DISABLED (the old next-pwa SW served stale builds and crashed clients).
 * This now does the opposite of registering: it unregisters any leftover service worker and
 * clears its caches, so returning users recover cleanly. Pairs with the kill-switch /sw.js. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
    if (typeof caches !== "undefined") {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
  }, []);
  return null;
}
