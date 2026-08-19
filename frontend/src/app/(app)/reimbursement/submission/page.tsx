"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Building2, Send, Plus, Trash2, FileText, ShieldCheck, AlertTriangle, CheckCircle2 } from "lucide-react";
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

  // ── Έλεγχος πριν την υποβολή (95% προκαταβολή — ΠΦΣ): ποσό ΗΔΥΚΑ που ελέγχει ο ΕΟΠΥΥ + checklist ──
  const eopyyExpected = (data?.batches ?? []).filter((b) => b.is_eopyy).reduce((s, b) => s + (b.expected_claim || 0), 0);
  const [invoiceAmt, setInvoiceAmt] = useState("");
  const [checks, setChecks] = useState({ clearance: false, finalized: false, ssy: false });
  useEffect(() => {   // per-period persistence (workflow aid — localStorage)
    try {
      const raw = localStorage.getItem(`reimb-precheck:${period}`);
      const s = raw ? JSON.parse(raw) : {};
      setInvoiceAmt(s.invoiceAmt || "");
      setChecks({ clearance: !!s.clearance, finalized: !!s.finalized, ssy: !!s.ssy });
    } catch { setInvoiceAmt(""); setChecks({ clearance: false, finalized: false, ssy: false }); }
  }, [period]);
  const persist = (patch: object) => {
    const next = { invoiceAmt, ...checks, ...patch };
    try { localStorage.setItem(`reimb-precheck:${period}`, JSON.stringify(next)); } catch { /* noop */ }
  };
  const enteredCents = invoiceAmt.trim() ? Math.round(parseFloat(invoiceAmt.replace(",", ".")) * 100) : null;
  const amountMatch = enteredCents == null ? null : Math.abs(enteredCents - eopyyExpected) <= 1;
  const diffCents = enteredCents == null ? 0 : enteredCents - eopyyExpected;

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
      {/* ── Έλεγχος πριν την υποβολή — 95% προκαταβολή (τα συνηθέστερα λάθη ΠΦΣ/ΚΜΕΣ) ── */}
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 dark:border-emerald-800 dark:bg-emerald-950/20">
        <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-bold text-emerald-800 dark:text-emerald-200"><ShieldCheck className="h-5 w-5" /> {t("Έλεγχος πριν την υποβολή — για να πληρωθεί το 95%", "Pre-submission check — so the 95% is paid")}</h3>

        {/* 1. Amount match — ο ΕΟΠΥΥ ελέγχει με τα ΔΙΚΑ ΤΟΥ (ΗΔΥΚΑ) ποσά */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="text-xs text-slate-500">{t("Ο ΕΟΠΥΥ αναμένει (από δεδομένα ΗΔΥΚΑ)", "ΕΟΠΥΥ expects (from ΗΔΥΚΑ data)")}</div>
            <div className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">{fmtEur(eopyyExpected)}</div>
            <div className="mt-1 text-[11px] text-slate-400">{t("Τιμολόγησε ΑΚΡΙΒΩΣ αυτό. Ο ΕΟΠΥΥ διασταυρώνει το τιμολόγιο με τα ποσά ΗΔΥΚΑ.", "Invoice EXACTLY this. ΕΟΠΥΥ cross-checks your invoice against ΗΔΥΚΑ.")}</div>
            {/* Ξεχωριστά τιμολόγια ανά κατηγορία (Φάρμακα Νο1 / Εμβόλια Νο2 / λοιπά ταμεία) — καθένα εκδίδεται & διασταυρώνεται χωριστά */}
            {(data?.batches ?? []).filter((b) => (b.expected_claim || 0) > 0).length > 1 && (
              <div className="mt-2 space-y-0.5 border-t border-slate-100 pt-2 dark:border-slate-800">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t("Ξεχωριστά τιμολόγια ανά κατηγορία", "Separate invoices per category")}</div>
                {(data?.batches ?? []).filter((b) => (b.expected_claim || 0) > 0).map((b) => (
                  <div key={b.batch_id} className="flex items-center justify-between text-[11px]">
                    <span className="truncate text-slate-500">{b.fund}</span>
                    <b className="shrink-0 text-slate-700 dark:text-slate-200">{fmtEur(b.expected_claim)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <label className="mb-1 block text-xs text-slate-500">{t("Ποσό στο τιμολόγιό μου (€)", "My invoice amount (€)")}</label>
            <input value={invoiceAmt} onChange={(e) => { setInvoiceAmt(e.target.value); persist({ invoiceAmt: e.target.value }); }} inputMode="decimal" placeholder={fmtEur(eopyyExpected).replace(" €", "")}
              className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none dark:bg-slate-800 ${amountMatch === false ? "border-rose-400" : amountMatch ? "border-emerald-400" : "border-slate-300 dark:border-slate-600"}`} />
            {amountMatch === true && <div className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-4 w-4" /> {t("Συμφωνεί με τη ΗΔΥΚΑ ✓", "Matches ΗΔΥΚΑ ✓")}</div>}
            {amountMatch === false && <div className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-rose-600"><AlertTriangle className="h-4 w-4" /> {t(`Ασυμφωνία ${fmtEur(Math.abs(diffCents))} — διόρθωσε το τιμολόγιο (αλλιώς δεν πληρώνεται το 95%).`, `Mismatch ${fmtEur(Math.abs(diffCents))} — fix the invoice (else the 95% won't be paid).`)}</div>}
          </div>
        </div>

        {/* 2. Checklist — τα υπόλοιπα συνηθέστερα λάθη */}
        <div className="mt-4 space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Λίστα ελέγχου ολοκλήρωσης", "Completion checklist")}</div>
          {([
            ["amount", t("Το ποσό τιμολογίου = ποσό ΗΔΥΚΑ (πάνω)", "Invoice amount = ΗΔΥΚΑ amount (above)"), amountMatch === true],
            ["clearance", t("Φορολογική & ασφαλιστική ενημερότητα σε ισχύ", "Tax & insurance clearance valid"), checks.clearance],
            ["finalized", t("Οριστικοποίησα την υποβολή στην ΚΜΕΣ (τελικό βήμα)", "Finalized the submission on ΚΜΕΣ (final step)"), checks.finalized],
            ["ssy", t("Επισύναψα το Συγκεντρωτικό Σημείωμα Υποβολής (ΣΣΥ)", "Attached the Aggregate Submission Note (ΣΣΥ)"), checks.ssy],
          ] as [string, string, boolean][]).map(([key, label, done]) => (
            <label key={key} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${done ? "text-emerald-700 dark:text-emerald-300" : "text-slate-600 dark:text-slate-300"} ${key === "amount" ? "cursor-default" : "cursor-pointer hover:bg-white/60 dark:hover:bg-slate-800/40"}`}>
              <input type="checkbox" checked={done} disabled={key === "amount"}
                onChange={(e) => { if (key === "amount") return; const patch = { [key]: e.target.checked }; setChecks((c) => ({ ...c, ...patch })); persist(patch); }}
                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">{t("Πηγή: ανακοίνωση ΠΦΣ — τα συνηθέστερα λάθη που μπλοκάρουν την προκαταβολή 95% (~200 φαρμακεία/μήνα).", "Source: ΠΦΣ notice — the most common errors blocking the 95% advance (~200 pharmacies/month).")}</p>
      </div>

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
