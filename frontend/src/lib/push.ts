// Web Push helper for the patient portal. Registers a push-only service worker scoped to
// "/portal/" (so it never touches the rest of the app) and manages the subscription.

import { patientApi } from "@/lib/patientClient";

const SW_URL = "/portal-sw.js";
const SCOPE = "/portal/";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SCOPE);
    if (!reg) return false;
    return !!(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}

export type PushResult = "ok" | "denied" | "unsupported" | "error";

export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) return "unsupported";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return "denied";
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE });
    // ensure there's an active worker before subscribing
    if (!reg.active) await new Promise((r) => setTimeout(r, 600));
    const { public_key } = await patientApi<{ public_key: string; enabled: boolean }>("/patient/push/key");
    if (!public_key) return "error";
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(public_key) as BufferSource,
      });
    }
    const j = sub.toJSON();
    await patientApi("/patient/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
    });
    return "ok";
  } catch {
    return "error";
  }
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration(SCOPE);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await patientApi("/patient/push/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {
    /* ignore */
  }
}
