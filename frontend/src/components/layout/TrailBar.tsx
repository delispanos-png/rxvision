"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CornerUpLeft, X } from "lucide-react";

import { useT } from "@/store/prefStore";
import { currentHref, useTrail } from "@/store/trailStore";

/**
 * Μπάρα επιστροφής: «↩ Εικόνα Πελάτη · ΔΡΟΣΑΚΗ ΚΥΡΑΤΣΩ › Εικόνα Πελάτη · ΤΣΟΥΛΟΥΒΗΣ».
 *
 * Εμφανίζεται ΜΟΝΟ όταν ήρθες μέσω συνδέσμου που άφησε σημείο επιστροφής. Ο τελευταίος σταθμός
 * είναι το μεγάλο κουμπί· οι προηγούμενοι μικρότεροι, για να γυρίσεις και πιο πίσω με ένα κλικ.
 *
 * Αν γυρίσεις με το «πίσω» του browser σε έναν σταθμό, ο σταθμός και ό,τι μετά από αυτόν σβήνονται —
 * αλλιώς η μπάρα θα σου πρότεινε να γυρίσεις εκεί που ήδη είσαι.
 */
export function TrailBar() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const { steps, hydrate, cutAt, clear } = useTrail();

  useEffect(() => { hydrate(); }, [hydrate]);

  // Είμαι ήδη σε κάποιον σταθμό (π.χ. «πίσω» του browser) → κόψε από εκεί και μετά.
  useEffect(() => {
    const sync = () => {
      const here = currentHref();
      const i = useTrail.getState().steps.findIndex((s) => s.href === here);
      if (i >= 0) useTrail.getState().cutAt(i);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [pathname]);

  if (!steps.length) return null;

  const go = (i: number) => {
    const target = steps[i];
    cutAt(i);
    const url = new URL(target.href, window.location.origin);
    if (url.pathname === window.location.pathname) {
      // ΙΔΙΑ σελίδα, άλλος πελάτης: το router δεν ξαναφορτώνει τη σελίδα, οπότε της το λέμε με
      // το ίδιο σήμα που στέλνει το «πίσω» του browser.
      window.history.pushState(null, "", target.href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } else {
      router.push(target.href);
    }
  };

  const last = steps.length - 1;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-sky-200 bg-sky-50 px-3 py-1.5 text-sm dark:border-sky-900/50 dark:bg-sky-950/30">
      {steps.slice(Math.max(0, last - 2), last).map((s, k) => {
        const i = Math.max(0, last - 2) + k;
        return (
          <span key={s.href} className="flex items-center gap-1.5">
            <button type="button" onClick={() => go(i)}
              className="max-w-[14rem] truncate text-xs text-sky-700 hover:underline dark:text-sky-300">
              {s.label}
            </button>
            <span className="text-sky-300">›</span>
          </span>
        );
      })}
      <button type="button" onClick={() => go(last)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-700">
        <CornerUpLeft className="h-3.5 w-3.5" />
        <span className="max-w-[32rem] truncate" title={steps[last].label}>{t("Επιστροφή:", "Back to:")} {steps[last].label}</span>
      </button>
      <button type="button" onClick={clear} title={t("Κλείσιμο", "Dismiss")}
        className="ml-auto rounded p-1 text-sky-500 hover:bg-sky-100 dark:hover:bg-sky-900/40">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
