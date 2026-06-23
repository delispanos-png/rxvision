"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, Users, CalendarRange, Search, Syringe } from "lucide-react";
import { api } from "@/lib/apiClient";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { useT } from "@/store/prefStore";
import { fmtNum } from "@/lib/formatters";
import { QueryState } from "@/components/ui/QueryState";
import { KpiCard } from "@/components/kpi/KpiCard";

type NC = { name?: string; group?: string; month?: string; count: number };
type Summary = {
  total: number; cancelled: number;
  by_vaccine: NC[]; by_risk_group: NC[]; by_age: NC[]; by_month: NC[];
};
type Vacc = {
  barcode?: string | null; external_id: string; executed_at?: string | null;
  vaccine_name?: string | null; status_name?: string | null; cancelled?: boolean;
  patient_name?: string | null; amka?: string | null;
  patient_age_group?: string | null; patient_sex?: string | null; high_risk_group?: string | null;
  icd10_title?: string | null; lot?: string | null;
};

function BarList({ title, rows, label }: { title: string; rows: NC[]; label: (r: NC) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
      {rows.length === 0 ? <div className="text-sm text-slate-400">—</div> : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i}>
              <div className="mb-0.5 flex items-center justify-between text-xs">
                <span className="truncate pr-2 text-slate-600 dark:text-slate-300">{label(r)}</span>
                <span className="font-semibold text-slate-700 dark:text-slate-200">{fmtNum(r.count)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div className="h-full rounded-full bg-sky-500" style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function VaccinationRegistryPage() {
  const t = useT();
  const qs = filtersToQuery(useUiStore());
  const [barcode, setBarcode] = useState("");
  useEffect(() => {  // prefill from ?barcode= when arriving from a vaccination row click
    const b = new URLSearchParams(window.location.search).get("barcode");
    if (b) setBarcode(b);
  }, []);
  const term = barcode.trim();

  const sum = useQuery({ queryKey: ["vaccinations-summary", qs], queryFn: () => api<Summary>(`/vaccinations/summary?${qs}`) });
  const list = useQuery({
    queryKey: ["vaccinations-list", qs, term],
    queryFn: () => api<{ items: Vacc[] }>(`/vaccinations?${qs}&include_cancelled=true&page_size=100${term ? `&barcode=${encodeURIComponent(term)}` : ""}`),
  });
  const d = sum.data;
  const items = list.data?.items ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateRangeFilter />
        <label className="text-xs font-medium text-slate-500">{t("Αναζήτηση barcode εμβολίου", "Vaccination barcode")}
          <div className="relative mt-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="9260212771006"
              className="w-64 rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
          </div>
        </label>
        {term && <span className="pb-2 text-xs text-slate-400">{t("Αναζήτηση σε όλη την περίοδο", "Searching all periods")}</span>}
      </div>

      {!term && (
        <QueryState isLoading={sum.isLoading} isError={sum.isError} isEmpty={!!d && !d.total} onRetry={() => sum.refetch()}>
          {d && (
            <>
              <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
                <KpiCard label={t("Σύνολο εμβολιασμών", "Total vaccinations")} value={fmtNum(d.total)} icon={Syringe} accent="sky" />
                <KpiCard label={t("Ακυρωμένοι", "Cancelled")} value={fmtNum(d.cancelled)} icon={ShieldAlert} accent={d.cancelled ? "rose" : "green"} />
                <KpiCard label={t("Διαφορετικά εμβόλια", "Distinct vaccines")} value={fmtNum(d.by_vaccine.length)} icon={CalendarRange} accent="violet" />
                <KpiCard label={t("Ομάδες κινδύνου", "Risk groups")} value={fmtNum(d.by_risk_group.length)} icon={Users} accent="amber" />
              </div>
              <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <BarList title={t("Ανά εμβόλιο", "By vaccine")} rows={d.by_vaccine} label={(r) => r.name || "—"} />
                <BarList title={t("Ανά μήνα", "By month")} rows={d.by_month} label={(r) => r.month || "—"} />
                <BarList title={t("Ανά ομάδα υψηλού κινδύνου", "By high-risk group")} rows={d.by_risk_group} label={(r) => r.name || "—"} />
                <BarList title={t("Ανά ηλικιακή ομάδα", "By age group")} rows={d.by_age} label={(r) => r.group || "—"} />
              </div>
            </>
          )}
        </QueryState>
      )}

      {/* list / search results */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-200">
          {term ? t("Αποτελέσματα αναζήτησης", "Search results") : t("Εμβολιασμοί περιόδου", "Vaccinations in period")}
          <span className="ml-2 font-normal text-slate-400">({items.length})</span>
        </div>
        <QueryState isLoading={list.isLoading} isError={list.isError} isEmpty={!items.length} onRetry={() => list.refetch()}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"><tr>
                <th className="px-4 py-2 text-left">{t("Ημ/νία", "Date")}</th>
                <th className="px-4 py-2 text-left">{t("Ασθενής", "Patient")}</th>
                <th className="px-4 py-2 text-left">ΑΜΚΑ</th>
                <th className="px-4 py-2 text-left">Barcode</th>
                <th className="px-4 py-2 text-left">{t("Εμβόλιο", "Vaccine")}</th>
                <th className="px-4 py-2 text-left">{t("Ομάδα κινδύνου", "Risk group")}</th>
                <th className="px-4 py-2 text-left">{t("Ηλικία", "Age")}</th>
                <th className="px-4 py-2 text-left">{t("Κατάσταση", "Status")}</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((v) => (
                  <tr key={v.external_id} className={v.cancelled ? "opacity-60" : ""}>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-700 dark:text-slate-200">{v.executed_at ? new Date(v.executed_at).toLocaleString("el-GR") : "—"}</td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">{v.patient_name || "—"}</td>
                    <td className="px-4 py-2 font-mono text-[11px] text-slate-500">{v.amka || "—"}</td>
                    <td className="px-4 py-2 font-mono text-[11px] text-slate-500">{v.barcode || v.external_id || "—"}</td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">{v.vaccine_name || "—"}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{v.high_risk_group || "—"}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{v.patient_age_group || "—"}</td>
                    <td className="px-4 py-2">
                      {v.cancelled
                        ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">{t("Ακυρωμένο", "Cancelled")}</span>
                        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{v.status_name || t("Εκτελεσμένο", "Done")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </div>
    </div>
  );
}
