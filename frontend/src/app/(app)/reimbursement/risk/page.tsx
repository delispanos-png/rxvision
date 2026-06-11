"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScissorsLineDashed } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Item = { external_id: string; executed_at: string; fund: string; claim: number; score: number; band: string; flags: string[]; expected_cut: number };
type Risk = { distribution: { band: string; count: number }[]; items: Item[]; total_at_risk: number };
type Cuts = { total: number; by_reason: { reason: string; count: number; cut: number }[]; by_fund: { fund: string; count: number; cut: number }[] };

const BAND: Record<string, string> = { low: "bg-emerald-500", medium: "bg-amber-500", high: "bg-orange-500", critical: "bg-rose-500" };
const BAND_TXT: Record<string, string> = { low: "bg-emerald-100 text-emerald-700", medium: "bg-amber-100 text-amber-700", high: "bg-orange-100 text-orange-700", critical: "bg-rose-100 text-rose-700" };
const FLAG: Record<string, { el: string; en: string }> = {
  partial_execution: { el: "Μερική εκτέλεση", en: "Partial execution" },
  amount_mismatch: { el: "Ασυμφωνία ποσών", en: "Amount mismatch" },
  missing_fund: { el: "Λείπει ταμείο", en: "Missing fund" },
  high_cost: { el: "Υψηλού κόστους", en: "High cost" },
};
function curMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }

export default function RiskPage() {
  const t = useT();
  const [period, setPeriod] = useState(curMonth());
  const risk = useQuery({ queryKey: ["reimb-risk", period], queryFn: () => api<Risk>(`/reimbursement/risk?period=${period}`) });
  const cuts = useQuery({ queryKey: ["reimb-cuts", period], queryFn: () => api<Cuts>(`/reimbursement/cuts?period=${period}`) });
  const total = (risk.data?.distribution ?? []).reduce((s, b) => s + b.count, 0) || 1;

  const cols: Column<Item>[] = [
    { key: "external_id", header: "Barcode", render: (r) => <span className="font-mono text-xs">{(r.external_id || "").split(":")[0]}</span> },
    { key: "executed_at", header: t("Ημ/νία", "Date"), hideOnMobile: true, render: (r) => fmtDate(r.executed_at) },
    { key: "fund", header: t("Ταμείο", "Fund"), hideOnMobile: true, render: (r) => r.fund },
    { key: "flags", header: t("Ευρήματα", "Findings"), render: (r) => <span className="flex flex-wrap gap-1">{r.flags.map((f) => <span key={f} className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">{t(FLAG[f]?.el ?? f, FLAG[f]?.en ?? f)}</span>)}</span> },
    { key: "score", header: "Risk", align: "right", sortValue: (r) => r.score, render: (r) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${BAND_TXT[r.band]}`}>{r.score}</span> },
    { key: "expected_cut", header: t("Πιθανή περικοπή", "Likely cut"), align: "right", sortValue: (r) => r.expected_cut, render: (r) => <b className="text-rose-600">{fmtEur(r.expected_cut)}</b> },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200"><ScissorsLineDashed className="h-4 w-4 text-rose-600" /> {t("Συνολική πιθανή απώλεια", "Total likely loss")}: <b className="text-rose-600">{fmtEur(risk.data?.total_at_risk ?? 0)}</b></span>
        <input type="month" value={period} max={curMonth()} onChange={(e) => setPeriod(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
      </div>

      <div className="rx-card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Κατανομή κινδύνου συνταγών", "Prescription risk distribution")}</h3>
        <div className="mb-2 flex h-5 overflow-hidden rounded-full">
          {(risk.data?.distribution ?? []).map((b) => b.count > 0 && <div key={b.band} className={BAND[b.band]} style={{ width: `${(b.count / total) * 100}%` }} title={`${b.band}: ${b.count}`} />)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {(risk.data?.distribution ?? []).map((b) => <span key={b.band} className="inline-flex items-center gap-1.5 capitalize text-slate-500"><span className={`h-2.5 w-2.5 rounded-full ${BAND[b.band]}`} /> {b.band}: <b className="text-slate-700 dark:text-slate-200">{b.count}</b></span>)}
        </div>
      </div>

      {!!cuts.data?.by_reason.length && (
        <div className="rx-card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Πιθανές περικοπές ανά αιτία", "Likely cuts by reason")}</h3>
          <div className="space-y-2">
            {cuts.data.by_reason.map((r) => (
              <div key={r.reason} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
                <span className="text-sm text-slate-700 dark:text-slate-200">{t(FLAG[r.reason]?.el ?? r.reason, FLAG[r.reason]?.en ?? r.reason)}</span>
                <span className="text-xs text-slate-500">{fmtNum(r.count)} {t("συνταγές", "Rx")}</span>
                <b className="ml-auto text-sm text-rose-600">{fmtEur(r.cut)}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      <DataTable pageSize={20} columns={cols} rows={risk.data?.items ?? []} rowKey={(r) => r.external_id} empty={t("Καμία συνταγή σε κίνδυνο. 👍", "No prescriptions at risk. 👍")} />
    </div>
  );
}
