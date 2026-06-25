"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Building2, Send, Plus, Trash2, FileText } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Batch = {
  batch_id: string; fund: string; is_eopyy: boolean; rx: number; expected_claim: number;
  status: string; flagged: number; risk_cut: number; paid_amount?: number | null; cut_amount?: number | null;
  manual?: boolean; note?: string | null;
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
  const [mLabel, setMLabel] = useState("");
  const [mAmount, setMAmount] = useState("");
  const [mNote, setMNote] = useState("");
  const addManual = useMutation({
    mutationFn: () => api(`/reimbursement/submission/manual?period=${period}`, { method: "POST", body: JSON.stringify({ label: mLabel.trim() || "Χειροκίνητο τιμολόγιο", amount: Math.round(parseFloat(mAmount.replace(",", ".")) * 100) || 0, note: mNote.trim() || null }) }),
    onSuccess: () => { setMLabel(""); setMAmount(""); setMNote(""); qc.invalidateQueries({ queryKey: ["reimb-sub", period] }); },
  });
  const delManual = useMutation({
    mutationFn: (batch_id: string) => api(`/reimbursement/submission/manual/delete`, { method: "POST", body: JSON.stringify({ batch_id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reimb-sub", period] }),
  });

  const cols: Column<Batch>[] = [
    { key: "fund", header: t("Ταμείο / Παραστατικό", "Fund / Document"), render: (r) => (
      <span className="inline-flex items-center gap-1.5">
        {r.manual ? <FileText className="h-3.5 w-3.5 text-amber-600" /> : r.is_eopyy ? <Building2 className="h-3.5 w-3.5 text-emerald-600" /> : null}
        <span>{r.fund}</span>
        {r.manual && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800" title={r.note || undefined}>{t("χειροκίνητο", "manual")}</span>}
      </span>
    ) },
    { key: "rx", header: t("Συντ.", "Rx"), align: "right", sortValue: (r) => r.rx, render: (r) => fmtNum(r.rx) },
    { key: "expected_claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.expected_claim, render: (r) => <b>{fmtEur(r.expected_claim)}</b> },
    { key: "flagged", header: t("Ρίσκο", "Risk"), align: "right", sortValue: (r) => r.flagged, render: (r) => r.flagged ? <button onClick={(e) => { e.stopPropagation(); router.push("/reimbursement/risk"); }} className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-200">{r.flagged} ⚠</button> : <span className="text-slate-300">—</span> },
    { key: "status", header: t("Κατάσταση", "Status"), render: (r) => (
      <select value={r.status} onClick={(e) => e.stopPropagation()} onChange={(e) => setStatus.mutate({ batch_id: r.batch_id, status: e.target.value })}
        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${ST_COLOR[r.status]} border-0 focus:ring-1 focus:ring-brand-500`}>
        {STATUSES.map((s) => <option key={s} value={s}>{ST_EL[s]}</option>)}
      </select>
    ) },
    { key: "del", header: "", render: (r) => r.manual ? <button onClick={(e) => { e.stopPropagation(); delManual.mutate(r.batch_id); }} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Διαγραφή", "Delete")}><Trash2 className="h-4 w-4" /></button> : null },
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
      {/* χειροκίνητο τιμολόγιο — π.χ. Αναλώσιμα e-dapy (εκτός εκτελέσεων) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h4 className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200"><Plus className="h-4 w-4 text-amber-600" /> {t("Προσθήκη χειροκίνητου τιμολογίου", "Add manual invoice")}</h4>
        <p className="mb-3 text-xs text-slate-400">{t("Για υποβολές εκτός εκτελέσεων — π.χ. Αναλώσιμα e-dapy. Παρακολουθείται μαζί με τις υπόλοιπες (κατάσταση/πληρωμή).", "For submissions outside executions — e.g. consumables e-dapy. Tracked alongside the rest.")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[160px]">
            <label className="mb-1 block text-xs text-slate-500">{t("Περιγραφή", "Label")}</label>
            <input value={mLabel} onChange={(e) => setMLabel(e.target.value)} placeholder={t("π.χ. Αναλώσιμα e-dapy", "e.g. Consumables e-dapy")} className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
          </div>
          <div className="w-32">
            <label className="mb-1 block text-xs text-slate-500">{t("Ποσό (€)", "Amount (€)")}</label>
            <input value={mAmount} onChange={(e) => setMAmount(e.target.value)} inputMode="decimal" placeholder="0,00" className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="mb-1 block text-xs text-slate-500">{t("Σημείωση", "Note")}</label>
            <input value={mNote} onChange={(e) => setMNote(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
          </div>
          <button onClick={() => addManual.mutate()} disabled={addManual.isPending || !mAmount} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"><Plus className="h-4 w-4" /> {t("Προσθήκη", "Add")}</button>
        </div>
      </div>

      <p className="text-xs text-slate-400">{t("Διόρθωσε τα flagged πριν υποβάλεις. Άλλαξε κατάσταση από το dropdown.", "Fix flagged before submitting. Change status from the dropdown.")}</p>
    </div>
  );
}
