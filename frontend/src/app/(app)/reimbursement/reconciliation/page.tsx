"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Landmark, Wallet, ScissorsLineDashed, Clock } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";

type Sub = { batches: { batch_id: string; fund: string; is_eopyy: boolean; expected_claim: number; paid_amount?: number | null; cut_amount?: number | null; status: string }[] };
type Rec = { expected: number; paid: number; cut: number; outstanding: number };

function PayInput({ batch, period, onSaved }: { batch: Sub["batches"][0]; period: string; onSaved: () => void }) {
  const [val, setVal] = useState(batch.paid_amount != null ? String(batch.paid_amount / 100) : "");
  const save = useMutation({
    mutationFn: () => api(`/reimbursement/submission/payment?period=${period}`, { method: "POST", body: JSON.stringify({ batch_id: batch.batch_id, paid_amount: Math.round(parseFloat(val || "0") * 100) }) }),
    onSuccess: onSaved,
  });
  return (
    <input type="number" value={val} onChange={(e) => setVal(e.target.value)} onBlur={() => val !== "" && save.mutate()} placeholder="€"
      className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-right text-sm dark:border-slate-600 dark:bg-slate-800" />
  );
}

export default function ReconciliationPage() {
  const t = useT();
  const qc = useQueryClient();
  const { period } = useReimbPeriod();
  const sub = useQuery({ queryKey: ["reimb-sub", period], queryFn: () => api<Sub>(`/reimbursement/submission?period=${period}`) });
  const rec = useQuery({ queryKey: ["reimb-rec", period], queryFn: () => api<Rec>(`/reimbursement/reconciliation?period=${period}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["reimb-rec", period] }); qc.invalidateQueries({ queryKey: ["reimb-sub", period] }); };

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Συμφωνία πληρωμών — αναμενόμενο vs πληρωμένο", "Reconciliation — expected vs paid")}</h3>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("Αναμενόμενο", "Expected")} help={t("Αναμενόμενο ποσό/όγκος της περιόδου με βάση τις ανοιχτές επαναλήψεις.", "Expected amount/volume for the period.")} value={fmtEur(rec.data?.expected ?? 0)} icon={Landmark} accent="indigo" />
        <KpiCard label={t("Πληρωμένο", "Paid")} help={t("Ποσά που έχουν ήδη πληρωθεί.", "Amounts already paid.")} value={fmtEur(rec.data?.paid ?? 0)} icon={Wallet} accent="green" />
        <KpiCard label={t("Περικοπές", "Cuts")} help={t("Εκτιμώμενες περικοπές ταμείων.", "Estimated fund cuts.")} value={fmtEur(rec.data?.cut ?? 0)} icon={ScissorsLineDashed} accent="rose" />
        <KpiCard label={t("Εκκρεμές", "Outstanding")} help={t("Ποσό που εκκρεμεί (δεν έχει εισπραχθεί/ολοκληρωθεί).", "Pending/uncollected amount.")} value={fmtEur(rec.data?.outstanding ?? 0)} icon={Clock} accent="amber" />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/60">
            <tr><th className="px-4 py-3">{t("Ταμείο", "Fund")}</th><th className="px-4 py-3 text-right">{t("Αναμενόμενο", "Expected")}</th><th className="px-4 py-3 text-right">{t("Πληρωμένο", "Paid")}</th><th className="px-4 py-3 text-right">{t("Περικοπή", "Cut")}</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(sub.data?.batches ?? []).map((b) => (
              <tr key={b.batch_id}>
                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{b.fund}</td>
                <td className="px-4 py-2.5 text-right">{fmtEur(b.expected_claim)}</td>
                <td className="px-4 py-2.5 text-right"><PayInput batch={b} period={period} onSaved={refresh} /></td>
                <td className="px-4 py-2.5 text-right">{b.cut_amount ? <b className="text-rose-600">{fmtEur(b.cut_amount)}</b> : <span className="text-slate-300">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">{t("Γράψε το ποσό που πληρώθηκε ανά ταμείο — υπολογίζεται αυτόματα η περικοπή & ενημερώνεται η κατάσταση.", "Enter the amount paid per fund — the cut is computed automatically and the status updates.")}</p>
    </div>
  );
}
