"use client";

import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanBarcode, CheckCircle2, XCircle, ListChecks, AlertTriangle, RotateCcw } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Item = { barcode: string; claim: number; fund: string; executed_at: string; checked: boolean };
type Check = { period: string; total: number; checked: number; remaining: number; extra: string[]; items: Item[] };

export default function PhysicalCheckPage() {
  const t = useT();
  const qc = useQueryClient();
  const { period } = useReimbPeriod();
  const inputRef = useRef<HTMLInputElement>(null);
  const [bc, setBc] = useState("");
  const [last, setLast] = useState<{ found: boolean; barcode: string } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["reimb-physical", period], queryFn: () => api<Check>(`/reimbursement/physical?period=${period}`) });
  const scan = useMutation({
    mutationFn: (barcode: string) => api<{ ok: boolean; found: boolean; barcode: string }>(`/reimbursement/physical/scan?period=${period}`, { method: "POST", body: JSON.stringify({ barcode }) }),
    onSuccess: (r) => { setLast({ found: r.found, barcode: r.barcode }); qc.invalidateQueries({ queryKey: ["reimb-physical", period] }); },
  });
  const reset = useMutation({
    mutationFn: () => api(`/reimbursement/physical/reset?period=${period}`, { method: "POST" }),
    onSuccess: () => { setLast(null); qc.invalidateQueries({ queryKey: ["reimb-physical", period] }); },
  });

  function submit() {
    const v = bc.trim();
    if (!v) return;
    scan.mutate(v);
    setBc("");
    inputRef.current?.focus();
  }

  const cols: Column<Item>[] = [
    { key: "checked", header: "", render: (r) => r.checked ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300" /> },
    { key: "barcode", header: "Barcode", render: (r) => <span className={`font-mono text-xs ${r.checked ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-200"}`}>{r.barcode}</span> },
    { key: "fund", header: t("Ταμείο", "Fund"), hideOnMobile: true, render: (r) => r.fund },
    { key: "executed_at", header: t("Ημ/νία", "Date"), hideOnMobile: true, render: (r) => fmtDate(r.executed_at) },
    { key: "claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => fmtEur(r.claim) },
  ];

  return (
    <div className="space-y-5">
      {/* scanner */}
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 dark:border-emerald-800 dark:bg-emerald-950/20">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><ScanBarcode className="h-5 w-5 text-emerald-600" /> {t("Σκανάρισμα συνταγών", "Scan prescriptions")}</div>
        <p className="mb-3 mt-1 text-xs text-slate-500">{t("Σκάναρε (ή πληκτρολόγησε + Enter) το barcode κάθε φυσικής συνταγής. Ταυτοποιείται με τη λίστα του μήνα.", "Scan (or type + Enter) each physical prescription barcode. It's matched against the month's list.")}</p>
        <div className="flex gap-2">
          <input ref={inputRef} autoFocus value={bc} onChange={(e) => setBc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder={t("π.χ. 2604200422266", "e.g. 2604200422266")} inputMode="numeric"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800" />
          <button onClick={submit} className="rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">{t("Έλεγχος", "Check")}</button>
        </div>
        {last && (
          <div className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${last.found ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
            {last.found ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            <span className="font-mono">{last.barcode}</span> — {last.found ? t("βρέθηκε στη λίστα ✓", "found in list ✓") : t("ΔΕΝ υπάρχει στα δεδομένα μας!", "NOT in our data!")}
          </div>
        )}
      </div>

      {/* counters */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("Σύνολο μήνα", "Month total")} value={fmtNum(data?.total ?? 0)} icon={ListChecks} accent="indigo" />
        <KpiCard label={t("Ελεγμένες", "Checked")} value={fmtNum(data?.checked ?? 0)} icon={CheckCircle2} accent="green" />
        <KpiCard label={t("Εκκρεμείς (δεν σκαναρίστηκαν)", "Remaining (unscanned)")} value={fmtNum(data?.remaining ?? 0)} icon={AlertTriangle} accent="amber" />
        <KpiCard label={t("Εκτός λίστας (ΗΔΙΚΑ)", "Not in our data")} value={fmtNum(data?.extra.length ?? 0)} icon={XCircle} accent="rose" />
      </div>

      {/* extras (scanned but not in our data) */}
      {!!data?.extra.length && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/50 dark:bg-rose-950/40">
          <div className="mb-1 text-sm font-semibold text-rose-700 dark:text-rose-300">{t("Σκαναρίστηκαν αλλά ΔΕΝ υπάρχουν στα δεδομένα μας:", "Scanned but NOT in our data:")}</div>
          <div className="flex flex-wrap gap-1.5">{data.extra.map((b) => <span key={b} className="rounded bg-white px-2 py-0.5 font-mono text-xs text-rose-700 dark:bg-slate-900">{b}</span>)}</div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Εκκρεμείς πρώτα", "Remaining first")} · {fmtNum(data?.total ?? 0)} {t("συνταγές", "Rx")}</h3>
        <button onClick={() => { if (confirm(t("Μηδενισμός ελέγχου;", "Reset check?"))) reset.mutate(); }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-3.5 w-3.5" /> {t("Μηδενισμός", "Reset")}</button>
      </div>
      {isLoading ? <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
        <DataTable pageSize={25} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.barcode} empty={t("Καμία εκτέλεση.", "No executions.")} />
      )}
    </div>
  );
}
