"use client";

import { useEffect } from "react";

/** Registers the next-pwa service worker (/sw.js) AND auto-reloads once when a new
 * version takes control after a deploy. Without the reload, the browser keeps the old
 * cached chunks (CacheFirst) and a redeploy yields stale-chunk errors / unstyled pages. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Only auto-reload on an UPDATE (page already controlled by an old SW), never on the
    // very first install — so a fresh visit doesn't double-load.
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    const onControllerChange = () => {
      if (refreshing || !hadController) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => reg.update().catch(() => {})) // proactively check for a new build
        .catch(() => {});
    };
    window.addEventListener("load", onLoad);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("load", onLoad);
    };
  }, []);
  return null;
}
