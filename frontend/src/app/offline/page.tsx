import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Εκτός σύνδεσης — RxVision",
  robots: { index: false },
};

// PWA offline fallback (wired via next-pwa `fallbacks.document` in next.config.js). Shown when
// a navigation request fails with no network and no cached page.
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Είστε εκτός σύνδεσης</h1>
      <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">
        Δεν υπάρχει σύνδεση στο διαδίκτυο. Ελέγξτε τη σύνδεσή σας — η εφαρμογή θα επανέλθει αυτόματα
        μόλις αποκατασταθεί.
      </p>
    </main>
  );
}
