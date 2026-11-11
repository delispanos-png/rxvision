"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Gift } from "lucide-react";

import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { toastSuccess } from "@/store/toastStore";

type Referral = {
  code: string; link: string; promo_code?: string | null;
  offers: { name: string; public_text: string; ends_on?: string;
    gifts: { module_name: string; text: string; to: "buyer" | "referrer" | "both" }[] }[];
};

const day = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");

/** Ο μόνιμος κωδικός σύστασης του φαρμακείου και, όταν τρέχει ενέργεια, τι κερδίζει ο καθένας. */
export function ReferralCard() {
  const t = useT();
  const q = useQuery({ queryKey: ["referral"], queryFn: () => api<Referral>("/promotions/referral"), staleTime: 60_000 });
  const r = q.data;
  if (!r) return null;
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => toastSuccess(t("Αντιγράφηκε", "Copied"))).catch(() => undefined);
  };
  return (
    <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-800 dark:bg-brand-950/20">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100"><Gift className="h-4 w-4 text-brand-600" /> {t("Σύστησε το RxVision", "Recommend RxVision")}</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t("Δώσε τον κωδικό σου σε συνάδελφο. Τον γράφει στην εγγραφή του ή ανοίγει απευθείας τον σύνδεσμο.", "Give your code to a colleague. They enter it when signing up, or open the link directly.")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-base font-semibold tracking-wider text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white">{r.code}</span>
        <button type="button" onClick={() => copy(r.code)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"><Copy className="h-4 w-4" /> {t("Κωδικός", "Code")}</button>
        <button type="button" onClick={() => copy(r.link)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"><Copy className="h-4 w-4" /> {t("Σύνδεσμος", "Link")}</button>
      </div>
      {r.promo_code && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t(`Ο σύνδεσμος και ο κωδικός σου περιλαμβάνουν ήδη την προσφορά ${r.promo_code}: ο συνάδελφός σου δεν χρειάζεται άλλον κωδικό.`, `Your link and code already include offer ${r.promo_code}: your colleague needs no other code.`)}</p>
      )}
      {r.offers.map((o) => (
        <div key={o.name} className="mt-3 rounded-lg bg-white p-3 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <b>{o.name}</b>{o.ends_on ? ` · ${t("έως", "until")} ${day(o.ends_on)}` : ""}{o.public_text ? ` · ${o.public_text}` : ""}
          <ul className="mt-1 list-disc pl-5">
            {o.gifts.map((g, i) => (
              <li key={i}><b>{g.to === "buyer" ? t("Ο συνάδελφός σου", "Your colleague") : g.to === "referrer" ? t("Εσύ", "You") : t("Εσύ και ο συνάδελφός σου", "You and your colleague")}:</b> {g.text}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
