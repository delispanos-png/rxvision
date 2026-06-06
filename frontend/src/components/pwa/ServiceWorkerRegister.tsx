"use client";

import { useEffect } from "react";

/** Registers the next-pwa service worker (/sw.js). next-pwa generates the file but
 * does NOT auto-inject the registration in the App Router, so we do it here — this
 * is what makes the app installable (Add to Home Screen / Install). */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    const onLoad = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);
  return null;
}
