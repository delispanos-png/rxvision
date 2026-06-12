/* Kill-switch service worker.
 * Replaces the previous next-pwa caching SW which was serving stale builds after deploys
 * (broken chunks → client-side exceptions / unstyled pages). When a stuck browser fetches
 * this updated /sw.js, it clears ALL caches and reloads open windows once — recovering the
 * user automatically, with no manual cache clearing. */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await self.clients.claim();
      } catch (e) {
        /* ignore */
      }
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (e) {
        /* ignore */
      }
      // reload every open window BEFORE unregistering (an unregistered SW can't navigate them)
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((c) => {
          try {
            c.navigate(c.url);
          } catch (e) {
            /* ignore */
          }
        });
      } catch (e) {
        /* ignore */
      }
      try {
        await self.registration.unregister();
      } catch (e) {
        /* ignore */
      }
    })()
  );
});
