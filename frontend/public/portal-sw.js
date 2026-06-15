/* Push-only service worker for the patient portal (registered with scope "/portal/").
 * Intentionally has NO fetch/caching handler — it only shows push notifications, so it
 * cannot serve stale builds (the reason the app-wide caching SW was disabled). */

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || "RxVision";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/portal" },
    vibrate: [80, 40, 80],
    tag: data.tag || undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/portal";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes("/portal") && "focus" in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
