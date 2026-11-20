"use client";

/* RxVision Κύπρος — Χαμένοι πελάτες.
   «Χάθηκε»: δεν ξαναήρθε καθόλου μετά την ημέρα που τον περιμέναμε.
   «Διαρροή»: έρχεται ακόμη για άλλες συνταγές, αλλά αυτή εκτελείται αλλού ή σταμάτησε.
   Ορισμός: backend services/cy/chains.py (ίδιος με Επισκόπηση και Ανοιχτές συνταγές). */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtDate, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";
import { ageOf } from "@/lib/cy";

type Item = {
  patient_ref: string; patient_name: string | null; patient_dob: string | null; kind: "lost" | "leak";
  last_visit: string; days_since_visit: number; lost_prescriptions: number;
  value_at_stake_cents: number; monthly_value_cents: number; doctors: string[]; items: string[];
  maybe_deceased?: boolean;   // υπόδειξη (80+, τακτικός, δεν ξαναήρθε) — ΠΟΤΕ αυτόματη σήμανση
};
type Resp = { summary: { lost: number; leak: number; monthly_value_cents: number; value_at_stake_cents: number };
  items: Item[]; lost_after_days: number };

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export default function CyLostCustomersPage() {
  const t = useT();
  const q = useQuery({ queryKey: ["cy", "lost"], queryFn: () => api<Resp>("/cy/lost-customers") });
  const s = q.data?.summary;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Χαμένοι πελάτες", "Lost customers")}</h1>
        <p className="text-sm text-slate-500">
          {t(`Πελάτες με συνταγή που έπρεπε να συνεχιστεί και δεν ήρθαν για περισσότερες από ${q.data?.lost_after_days ?? 14} ημέρες μετά την αναμενόμενη επίσκεψη.`,
             `Customers with a prescription that should have continued and did not come for more than ${q.data?.lost_after_days ?? 14} days after the expected visit.`)}
        </p>
      </header>

      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {s && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Tile label={t("Χάθηκαν", "Lost")} value={fmtNum(s.lost)} hint={t("δεν ξαναήρθαν καθόλου", "never came back")} />
          <Tile label={t("Διαρροή", "Leaking")} value={fmtNum(s.leak)} hint={t("έρχονται, αλλά μια συνταγή πάει αλλού", "still come, but one prescription goes elsewhere")} />
          <Tile label={t("Αξία ανά μήνα", "Value per month")} value={fmtEur(s.monthly_value_cents)} hint={t("όσο φέρνουν αυτές οι συνταγές σε κάθε εκτέλεση", "what these prescriptions bring per dispensing")} />
          <Tile label={t("Αξία υπόλοιπων φάσεων", "Value of remaining steps")} value={fmtEur(s.value_at_stake_cents)} hint={t("αν είχαν ολοκληρωθεί εδώ", "had they been completed here")} />
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="px-4 py-2">{t("Πελάτης", "Customer")}</th>
              <th className="px-4 py-2">{t("Τι συμβαίνει", "What happened")}</th>
              <th className="px-4 py-2">{t("Τελευταία επίσκεψη", "Last visit")}</th>
              <th className="px-4 py-2">{t("Θεραπεία που χάθηκε", "Lost treatment")}</th>
              <th className="px-4 py-2 text-right">{t("Αξία/μήνα", "Value/month")}</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((r) => {
              const age = ageOf(r.patient_dob);
              return (
                <tr key={r.patient_ref} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="px-4 py-2">
                    <Link href={`/cy/patients/${encodeURIComponent(r.patient_ref)}`} className="font-medium text-slate-800 hover:text-indigo-600 dark:text-slate-100">{r.patient_name || "—"}</Link>
                    <div className="text-xs text-slate-400">{age != null ? `${age} ${t("ετών", "yrs")}` : ""}{r.doctors.length ? ` · ${r.doctors.join(", ")}` : ""}</div>
                    {r.maybe_deceased && <div className="mt-1 text-[11px] text-slate-500" title={t("Τακτικός πελάτης 80+ που δεν ξαναήρθε. Το σύστημα δεν το συμπεραίνει — σημείωσέ το μόνο αν το γνωρίζεις.", "A regular customer aged 80+ who has not returned. The system never assumes it — mark it only if you know.")}>🕊 {t("Αν γνωρίζεις ότι απεβίωσε, σημείωσέ το στην καρτέλα.", "If you know they passed away, mark it on the card.")}</div>}
                  </td>
                  <td className="px-4 py-2">
                    {r.kind === "lost"
                      ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-900/40 dark:text-rose-300">{t("Χάθηκε", "Lost")}</span>
                      : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{t("Διαρροή", "Leaking")}</span>}
                    <div className="mt-1 text-xs text-slate-400">{fmtNum(r.lost_prescriptions)} {t("συνταγές", "prescriptions")}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {fmtDate(r.last_visit)} <span className="text-xs text-slate-400">({t(`πριν ${r.days_since_visit} ημ.`, `${r.days_since_visit} d ago`)})</span>
                  </td>
                  <td className="max-w-sm px-4 py-2 text-xs text-slate-600 dark:text-slate-300">{r.items.slice(0, 3).join(" · ")}{r.items.length > 3 ? ` +${r.items.length - 3}` : ""}</td>
                  <td className="px-4 py-2 text-right">{fmtEur(r.monthly_value_cents)}</td>
                </tr>
              );
            })}
            {q.data && q.data.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">{t("Κανένας χαμένος πελάτης.", "No lost customers.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
