"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, Layers } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur, fmtMoney} from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { Tooltip } from "@/components/ui/Tooltip";

type Fund = { fund: string; is_eopyy: boolean; rx: number; retail: number; claim: number; patient: number };
type Closing = {
  period: string;
  totals: { rx: number; retail: number; claim: number; patient: number; eopyy_claim: number; other_claim: number; gross_profit: number };
  by_fund: Fund[];
  by_category: { category: string; rx: number; claim: number }[];
  by_day: { day: string; rx: number; claim: number }[];
};

const CAT: Record<string, string> = { normal: "Κανονικό", narcotic: "Ναρκωτικό", vaccine: "Εμβόλιο", high_cost: "Υψηλού κόστους", allergen: "Αλλεργιογόνο" };

export default function ClosingPage() {
  const t = useT();
  const { period } = useReimbPeriod();
  const { data, isLoading } = useQuery({ queryKey: ["reimb-closing", period], queryFn: () => api<Closing>(`/reimbursement/closing?period=${period}`) });
  const maxDay = Math.max(1, ...(data?.by_day ?? []).map((d) => d.rx));
  const maxCat = Math.max(1, ...(data?.by_category ?? []).map((c) => c.claim));

  const cols: Column<Fund>[] = [
    { key: "fund", header: t("Ταμείο", "Fund"), render: (r) => <span className="inline-flex items-center gap-1.5">{r.is_eopyy && <Building2 className="h-3.5 w-3.5 text-emerald-600" />}{r.fund}</span> },
    { key: "rx", header: t("Συνταγές", "Rx"), align: "right", sortValue: (r) => r.rx, render: (r) => fmtNum(r.rx) },
    { key: "retail", header: t("Λιανική", "Retail"), align: "right", sortValue: (r) => r.retail, render: (r) => fmtEur(r.retail) },
    { key: "claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => <b className="text-emerald-700 dark:text-emerald-400">{fmtEur(r.claim)}</b> },
    { key: "patient", header: t("Συμμετοχή", "Patient"), align: "right", hideOnMobile: true, sortValue: (r) => r.patient, render: (r) => fmtEur(r.patient) },
  ];

  return (
    <div className="space-y-5">
      {isLoading ? <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
        <>
          <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900 md:grid-cols-4">
            {[["Συνταγές", "Rx", fmtNum(data?.totals.rx ?? 0)], ["Λιανική", "Retail", fmtEur(data?.totals.retail ?? 0)], ["Απαίτηση", "Claim", fmtEur(data?.totals.claim ?? 0)], ["Συμμετοχή", "Patient", fmtEur(data?.totals.patient ?? 0)]].map(([el, en, v]) => (
              <div key={en}><div className="text-xs text-slate-400">{t(el, en)}</div><div className="text-lg font-bold text-slate-900 dark:text-slate-100">{v}</div></div>
            ))}
          </div>

          <div className="rx-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Building2 className="h-4 w-4 text-emerald-600" /> {t("Απαίτηση ανά ταμείο", "Claim per fund")}</h3>
              <ExportMenu filename={`closing-${period}`} title="Monthly Closing" rows={data?.by_fund ?? []} columns={[
                { key: "fund", header: t("Ταμείο", "Fund") },
                { key: "rx", header: "Rx" },
                { key: "claim", header: "Claim (€)", value: (r) => fmtMoney(r.claim) },
              ]} />
            </div>
            <DataTable pageSize={15} columns={cols} rows={data?.by_fund ?? []} rowKey={(r) => r.fund} empty={t("Καμία εγγραφή.", "No data.")} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rx-card p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Layers className="h-4 w-4 text-emerald-600" /> {t("Ανά κατηγορία", "By category")}</h3>
              <div className="space-y-2">
                {(data?.by_category ?? []).map((c) => (
                  <div key={c.category} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 truncate text-sm text-slate-600 dark:text-slate-300">{t(CAT[c.category] ?? c.category, c.category)}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${(c.claim / maxCat) * 100}%` }} /></div>
                    <b className="w-16 text-right text-sm text-slate-700 dark:text-slate-200">{fmtEur(c.claim)}</b>
                  </div>
                ))}
              </div>
            </div>
            <div className="rx-card p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Ανά ημέρα", "By day")}</h3>
              <div className="flex h-28 items-end gap-0.5">
                {(data?.by_day ?? []).map((d) => (
                  <Tooltip key={d.day} label={`${d.day}: ${d.rx}`}><div className="group flex flex-1 flex-col items-center justify-end">
                    <div className="w-full rounded-t bg-emerald-400 group-hover:bg-emerald-600" style={{ height: `${(d.rx / maxDay) * 100}%`, minHeight: d.rx ? "2px" : "0" }} />
                    <span className="mt-0.5 text-[8px] text-slate-400">{d.day.slice(8)}</span>
                  </div></Tooltip>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
