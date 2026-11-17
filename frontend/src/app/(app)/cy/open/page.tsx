"use client";

/* RxVision Κύπρος — Ανοιχτές συνταγές & αναμενόμενες επισκέψεις.
   Ποιος πρέπει να έρθει για την επόμενη φάση και πότε. Οι καταστάσεις έρχονται από τον ΕΝΑ
   ορισμό του backend (services/cy/chains.py) — ίδιοι αριθμοί με την Επισκόπηση. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtDate, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";
import { ageOf, STATUS_STYLE, type ChainStatus } from "@/lib/cy";

type Item = {
  prescription_id: string; patient_ref: string; kind: "drug" | "consumable"; patient_name: string | null; patient_dob: string | null;
  doctor: string | null; last_at: string; next_due: string; days_to_due: number; instance: number; instances: number;
  remaining: number; items: string[]; value_at_stake_cents: number; status: ChainStatus;
};
type Resp = { counts: Record<ChainStatus, number>; total: number; items: Item[] };

const ORDER: ChainStatus[] = ["late", "soon", "upcoming", "lost"];

export default function CyOpenPrescriptionsPage() {
  const t = useT();
  const [status, setStatus] = useState<ChainStatus | "">("");
  // ?status=lost (σύνδεσμος από την Επισκόπηση) — χωρίς useSearchParams (θέλει Suspense στο build)
  useEffect(() => {
    const s0 = new URLSearchParams(window.location.search).get("status");
    if (s0 && s0 in STATUS_STYLE) setStatus(s0 as ChainStatus);
  }, []);
  const q = useQuery({
    queryKey: ["cy", "open", status],
    queryFn: () => api<Resp>(`/cy/open-prescriptions${status ? `?status=${status}` : ""}`),
  });
  const counts = q.data?.counts;
  const when = (d: number) => d === 0 ? t("σήμερα", "today")
    : d > 0 ? t(`σε ${d} ημ.`, `in ${d} d`) : t(`πριν ${-d} ημ.`, `${-d} d ago`);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Ανοιχτές συνταγές", "Open prescriptions")}</h1>
        <p className="text-sm text-slate-500">
          {t("Συνταγές που έχουν κι άλλες εκτελέσεις μπροστά: ποιος πρέπει να έρθει και πότε. Η επόμενη επίσκεψη υπολογίζεται από την τελευταία εκτέλεση και τη διάρκεια θεραπείας (συνήθως 28 ημέρες).",
             "Prescriptions with dispensings still ahead: who should come and when. The next visit is computed from the last dispensing and the treatment duration (usually 28 days).")}
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setStatus("")}
          className={`rounded-full border px-3 py-1 text-sm ${status === "" ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-300 text-slate-600"}`}>
          {t("Όλες", "All")}{q.data && !status ? ` · ${fmtNum(q.data.total)}` : ""}
        </button>
        {ORDER.map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-sm ${status === s ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-300 text-slate-600"}`}>
            {t(STATUS_STYLE[s].el, STATUS_STYLE[s].en)}{counts ? ` · ${fmtNum(counts[s] ?? 0)}` : ""}
          </button>
        ))}
      </div>

      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="px-4 py-2">{t("Πελάτης", "Customer")}</th>
              <th className="px-4 py-2">{t("Θεραπεία", "Treatment")}</th>
              <th className="px-4 py-2">{t("Φάση", "Step")}</th>
              <th className="px-4 py-2">{t("Τελευταία εκτέλεση", "Last dispensing")}</th>
              <th className="px-4 py-2">{t("Επόμενη επίσκεψη", "Next visit")}</th>
              <th className="px-4 py-2">{t("Κατάσταση", "Status")}</th>
              <th className="px-4 py-2 text-right">{t("Αξία που απομένει", "Remaining value")}</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((r) => {
              const age = ageOf(r.patient_dob);
              return (
                <tr key={r.prescription_id} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="px-4 py-2">
                    <Link href={`/cy/patients/${encodeURIComponent(r.patient_ref)}`} className="font-medium text-slate-800 hover:text-indigo-600 dark:text-slate-100">{r.patient_name || "—"}</Link>
                    <div className="text-xs text-slate-400">{age != null ? `${age} ${t("ετών", "yrs")}` : ""}{r.doctor ? ` · ${r.doctor}` : ""}</div>
                  </td>
                  <td className="max-w-xs px-4 py-2 text-xs text-slate-600 dark:text-slate-300">
                    {r.kind === "consumable" && <span className="mr-1 rounded bg-sky-100 px-1 text-sky-700">{t("αναλώσιμα", "consumables")}</span>}
                    {r.items.slice(0, 3).join(" · ")}{r.items.length > 3 ? ` +${r.items.length - 3}` : ""}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{r.instance}/{r.instances}</td>
                  <td className="whitespace-nowrap px-4 py-2">{fmtDate(r.last_at)}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {fmtDate(r.next_due)} <span className="text-xs text-slate-400">({when(r.days_to_due)})</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status].cls}`}>{t(STATUS_STYLE[r.status].el, STATUS_STYLE[r.status].en)}</span>
                  </td>
                  <td className="px-4 py-2 text-right">{fmtEur(r.value_at_stake_cents)}</td>
                </tr>
              );
            })}
            {q.data && q.data.items.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">{t("Καμία συνταγή σε αυτή την κατάσταση.", "No prescriptions in this state.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
