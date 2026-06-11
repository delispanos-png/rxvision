"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Building2, Send } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Batch = {
  batch_id: string; fund: string; is_eopyy: boolean; rx: number; expected_claim: number;
  status: string; flagged: number; risk_cut: number; paid_amount?: number | null; cut_amount?: number | null;
};
type Sub = { period: string; batches: Batch[]; status_counts: Record<string, number> };

const STATUSES = ["draft", "ready_for_review", "ready_for_submission", "submitted", "received", "approved", "paid", "cut", "rejected"];
const ST_EL: Record<string, string> = { draft: "Πρόχειρο", ready_for_review: "Προς έλεγχο", ready_for_submission: "Έτοιμο υποβολής", submitted: "Υποβλήθηκε", received: "Παρελήφθη", approved: "Εγκρίθηκε", paid: "Πληρώθηκε", cut: "Περικοπή", rejected: "Απορρίφθηκε" };
const ST_COLOR: Record<string, string> = { draft: "bg-slate-100 text-slate-600", ready_for_review: "bg-amber-100 text-amber-700", ready_for_submission: "bg-sky-100 text-sky-700", submitted: "bg-violet-100 text-violet-700", received: "bg-indigo-100 text-indigo-700", approved: "bg-emerald-100 text-emerald-700", paid: "bg-emerald-100 text-emerald-700", cut: "bg-rose-100 text-rose-700", rejected: "bg-rose-100 text-rose-700" };
export default function SubmissionPage() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { period } = useReimbPeriod();
  const { data, isLoading } = useQuery({ queryKey: ["reimb-sub", period], queryFn: () => api<Sub>(`/reimbursement/submission?period=${period}`) });
  const setStatus = useMutation({
    mutationFn: (v: { batch_id: string; status: string }) => api(`/reimbursement/submission/status?period=${period}`, { method: "POST", body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reimb-sub", period] }),
  });

  const cols: Column<Batch>[] = [
    { key: "fund", header: t("Ταμείο", "Fund"), render: (r) => <span className="inline-flex items-center gap-1.5">{r.is_eopyy && <Building2 className="h-3.5 w-3.5 text-emerald-600" />}{r.fund}</span> },
    { key: "rx", header: t("Συντ.", "Rx"), align: "right", sortValue: (r) => r.rx, render: (r) => fmtNum(r.rx) },
    { key: "expected_claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.expected_claim, render: (r) => <b>{fmtEur(r.expected_claim)}</b> },
    { key: "flagged", header: t("Ρίσκο", "Risk"), align: "right", sortValue: (r) => r.flagged, render: (r) => r.flagged ? <button onClick={(e) => { e.stopPropagation(); router.push("/reimbursement/risk"); }} className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-200">{r.flagged} ⚠</button> : <span className="text-slate-300">—</span> },
    { key: "status", header: t("Κατάσταση", "Status"), render: (r) => (
      <select value={r.status} onClick={(e) => e.stopPropagation()} onChange={(e) => setStatus.mutate({ batch_id: r.batch_id, status: e.target.value })}
        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${ST_COLOR[r.status]} border-0 focus:ring-1 focus:ring-brand-500`}>
        {STATUSES.map((s) => <option key={s} value={s}>{ST_EL[s]}</option>)}
      </select>
    ) },
  ];

  return (
    <div className="space-y-5">
      <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Send className="h-4 w-4 text-emerald-600" /> {t("Κέντρο υποβολής — δέσμες ανά ομάδα ταμείων", "Submission center — per-group batches")}</h3>

      {/* status funnel */}
      <div className="flex flex-wrap gap-2">
        {STATUSES.filter((s) => (data?.status_counts[s] ?? 0) > 0).map((s) => (
          <span key={s} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${ST_COLOR[s]}`}>{ST_EL[s]}: {data?.status_counts[s]}</span>
        ))}
      </div>

      {isLoading ? <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
        <DataTable pageSize={25} columns={cols} rows={data?.batches ?? []} rowKey={(r) => r.batch_id} empty={t("Καμία δέσμη.", "No batches.")} />
      )}
      <p className="text-xs text-slate-400">{t("Διόρθωσε τα flagged πριν υποβάλεις. Άλλαξε κατάσταση από το dropdown. Μετά την πληρωμή → καρτέλα «Συμφωνία».", "Fix flagged before submitting. Change status from the dropdown. After payment → 'Reconciliation' tab.")}</p>
    </div>
  );
}
