"use client";

/* Πύλη πελάτη — ΚΥΠΡΟΣ: «Οι συνταγές μου (ΓεΣΥ)».
   Ανοιχτές συνταγές με την επόμενη επίσκεψη + ιστορικό εκτελέσεων στο φαρμακείο. Πηγή: /patient/cy/prescriptions
   (ίδιος ορισμός αλυσίδων με την πλευρά του φαρμακείου). Τίποτα από ΗΔΥΚΑ/ΑΜΚΑ. */

import { useEffect, useState } from "react";
import { CalendarClock, FileText, Loader2 } from "lucide-react";
import { patientApi } from "@/lib/patientClient";
import { useT } from "@/store/prefStore";
import { fmtDate } from "@/lib/formatters";

type Open = { prescription_id: string; kind: string; items: string[]; instance: number; instances: number;
  next_due: string; days_to_due: number; status: "soon" | "upcoming" | "late" | "lost"; doctor: string | null };
type Hist = { dispensed_at: string; kind: string; doctor: string | null; instance: number; instances: number; paid_cents: number;
  lines: { description: string; qty_disp: number; qty_presc: number; dosage: [string | null, string | null, string | null] }[] };

const eur = (c: number) => new Intl.NumberFormat("el-CY", { style: "currency", currency: "EUR" }).format((c || 0) / 100);

export function CyPrescriptions({ forRef }: { forRef?: string } = {}) {
  const t = useT();
  const [data, setData] = useState<{ open: Open[]; history: Hist[] } | null>(null);
  const [err, setErr] = useState(false);
  // «Προβολή ως» (παιδί/εξουσιοδότηση): ο διακομιστής ελέγχει το δικαίωμα (`_view_target`)
  useEffect(() => {
    setData(null); setErr(false);
    patientApi<{ open: Open[]; history: Hist[] }>(`/patient/cy/prescriptions${forRef ? `?for=${encodeURIComponent(forRef)}` : ""}`)
      .then(setData).catch(() => setErr(true));
  }, [forRef]);
  if (err) return <p className="text-sm text-slate-500">{t("Οι συνταγές δεν είναι διαθέσιμες αυτή τη στιγμή.", "Prescriptions are not available right now.")}</p>;
  if (!data) return <Loader2 className="h-5 w-5 animate-spin text-slate-400" />;
  const when = (d: number) => d === 0 ? t("σήμερα", "today") : d > 0 ? t(`σε ${d} ημέρες`, `in ${d} days`) : t(`πριν ${-d} ημέρες`, `${-d} days ago`);
  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100"><CalendarClock className="h-5 w-5" />{t("Επόμενες επισκέψεις", "Upcoming visits")}</h2>
        {data.open.length === 0 && <p className="text-sm text-slate-500">{t("Δεν έχεις ανοιχτή συνταγή αυτή τη στιγμή.", "You have no open prescription right now.")}</p>}
        <ul className="space-y-2">
          {data.open.map((o) => (
            <li key={o.prescription_id} className="rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
              <div className="font-medium">{o.items.join(" · ")}</div>
              <div className="mt-1 text-xs text-slate-500">
                {t("Επόμενη", "Next")}: <b>{fmtDate(o.next_due)}</b> ({when(o.days_to_due)}) · {t("εκτέλεση", "dispensing")} {o.instance + 1}/{o.instances}
                {o.doctor ? ` · ${o.doctor}` : ""}
              </div>
            </li>))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100"><FileText className="h-5 w-5" />{t("Ιστορικό", "History")}</h2>
        <ul className="space-y-2">
          {data.history.map((h, i) => (
            <li key={i} className="rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
              <div className="flex justify-between gap-2"><span className="font-medium">{fmtDate(h.dispensed_at)} · {h.instance}/{h.instances}</span>
                <span className="text-slate-500">{t("πλήρωσες", "you paid")} {eur(h.paid_cents)}</span></div>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                {h.lines.map((l, j) => (
                  <li key={j} className={l.qty_disp === 0 ? "text-amber-700" : ""}>
                    {l.description} — {l.qty_disp}/{l.qty_presc}{l.qty_disp === 0 ? ` · ${t("δεν δόθηκε", "not given")}` : ""}
                    {l.dosage[0] ? ` · ${l.dosage.filter(Boolean).join(", ")}` : ""}
                  </li>))}
              </ul>
            </li>))}
        </ul>
      </section>
    </div>
  );
}
