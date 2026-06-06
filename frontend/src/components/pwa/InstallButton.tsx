"use client";

import { useEffect, useState } from "react";
import { Download, Share } from "lucide-react";

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** "Install app" affordance. Android/Chrome: fires the native install prompt via the
 * captured beforeinstallprompt event. iOS Safari: no such event → show Add-to-Home
 * instructions. Hidden when already running installed (standalone). */
export function InstallButton() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || (navigator as any).standalone === true;
    if (standalone) { setInstalled(true); return; }
    const onBIP = (e: Event) => { e.preventDefault(); setDeferred(e as BIPEvent); };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const isIOS = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);

  async function onClick() {
    if (deferred) { await deferred.prompt(); setDeferred(null); return; }
    if (isIOS) setIosHint((v) => !v);
  }

  // Show only when installable (Android event captured) or on iOS (manual flow).
  if (!deferred && !isIOS) return null;

  return (
    <div className="relative">
      <button
        onClick={onClick}
        className="flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100"
      >
        <Download className="h-4 w-4" /> <span className="hidden sm:inline">Εγκατάσταση</span>
      </button>
      {iosHint && (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-pop">
          <div className="mb-1 font-semibold text-slate-800">Εγκατάσταση στο iPhone</div>
          Πατήστε <Share className="inline h-3.5 w-3.5" /> <b>Κοινή χρήση</b> και μετά
          <b> «Προσθήκη στην οθόνη Αφετηρίας»</b>.
        </div>
      )}
    </div>
  );
}
