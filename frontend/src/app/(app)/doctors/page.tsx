"use client";

import { useState } from "react";
import { useHashView } from "@/lib/useHashView";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { BarChart3, Stethoscope, TrendingUp, UserPlus, Wallet, Download } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtEur, fmtNum, fmtMoney} from "@/lib/formatters";
import { downloadCsv } from "@/lib/csv";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { BarChart } from "@/components/charts/BarChart";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/store/prefStore";

type T = (el: string, en: string) => string;

type SpecialtyRow = { specialty: string; doctors: number; rx_count: number; value: number; gross_profit: number; new_patients: number };
type DocMetric = "rx_count" | "value" | "gross_profit" | "new_patients";

type Doctor = {
  id: string;
  name: string;
  specialty: string;
  rx_count: number;
  value: number; // cents
  gross_profit: number; // cents
  new_patients: number;
};

const makeSorts = (t: T) => [
  { value: "value", label: t("Αξία (μεγαλύτερη)", "Value (highest)") },
  { value: "rx", label: t("Συνταγές (περισσότερες)", "Prescriptions (most)") },
  { value: "profit", label: t("Κερδοφορία (μεγαλύτερη)", "Profitability (highest)") },
  { value: "patients", label: t("Νέοι πελάτες (περισσότεροι)", "New patients (most)") },
  { value: "name", label: t("Όνομα (Α→Ω)", "Name (A→Z)") },
];

export default function DoctorsPage() {
  const t = useT();
  const SORTS = makeSorts(t);
  const router = useRouter();
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const [sort, setSort] = useState("value");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.doctors(`${q}&sort=${sort}`),
    queryFn: () => api<{ items: Doctor[] }>(`/doctors?${q}&sort=${sort}`),
  });
  const pr = prevYearRange(filters.dateFrom, filters.dateTo);
  const prevDoc = useQuery({
    queryKey: ["doctors", "prevYear", pr?.from, pr?.to],
    queryFn: () => api<{ items: Doctor[] }>(`/doctors?${filtersToQuery({...filters, dateFrom: pr!.from, dateTo: pr!.to })}&sort=value`),
    enabled: !!pr,
  });

  const items = data?.items ?? [];
  const sum = (f: (d: Doctor) => number) => items.reduce((a, d) => a + (f(d) || 0), 0);
  const pItems = prevDoc.data?.items ?? [];
  const psum = (f: (d: Doctor) => number) => pItems.reduce((a, d) => a + (f(d) || 0), 0);
  const hasPrev = !!prevDoc.data;
  const top = [...items].sort((a, b) => b.value - a.value).slice(0, 8);

  const view = useHashView();              // #list → μόνο λίστα · #kpi → μόνο δείκτες · κενό → όλα
  const showKpi = view !== "list", showList = view !== "kpi";
  // KPI drill-down popup (client-side — all doctors+stats are already loaded)
  const [modal, setModal] = useState<{ title: string; view: "doctor" | "specialty"; metric: DocMetric } | null>(null);
  const doctorRows = modal ? [...items].sort((a, b) => (b[modal.metric] as number) - (a[modal.metric] as number)) : [];
  const specialtyRows: SpecialtyRow[] = (() => {
    const m = new Map<string, SpecialtyRow>();
    for (const d of items) {
      const s = d.specialty || t("— (χωρίς ειδικότητα)", "— (no specialty)");
      const g = m.get(s) ?? { specialty: s, doctors: 0, rx_count: 0, value: 0, gross_profit: 0, new_patients: 0 };
      g.doctors += 1; g.rx_count += d.rx_count || 0; g.value += d.value || 0;
      g.gross_profit += d.gross_profit || 0; g.new_patients += d.new_patients || 0;
      m.set(s, g);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  })();

  const docModalCols: Column<Doctor>[] = [
    { key: "name", header: t("Ιατρός", "Doctor") },
    { key: "specialty", header: t("Ειδικότητα", "Specialty"), render: (r) => r.specialty || "—" },
    { key: "rx_count", header: t("Συνταγές", "Prescriptions"), align: "right", render: (r) => fmtNum(r.rx_count), sortValue: (r) => r.rx_count },
    { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value), sortValue: (r) => r.value },
    { key: "gross_profit", header: t("Κερδοφορία", "Profitability"), align: "right", render: (r) => fmtEur(r.gross_profit), sortValue: (r) => r.gross_profit },
    { key: "new_patients", header: t("Νέοι", "New"), align: "right", render: (r) => fmtNum(r.new_patients), sortValue: (r) => r.new_patients },
  ];
  const specModalCols: Column<SpecialtyRow>[] = [
    { key: "specialty", header: t("Ειδικότητα", "Specialty") },
    { key: "doctors", header: t("Ιατροί", "Doctors"), align: "right", render: (r) => fmtNum(r.doctors), sortValue: (r) => r.doctors },
    { key: "rx_count", header: t("Συνταγές", "Prescriptions"), align: "right", render: (r) => fmtNum(r.rx_count), sortValue: (r) => r.rx_count },
    { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value), sortValue: (r) => r.value },
    { key: "gross_profit", header: t("Κερδοφορία", "Profitability"), align: "right", render: (r) => fmtEur(r.gross_profit), sortValue: (r) => r.gross_profit },
    { key: "new_patients", header: t("Νέοι", "New"), align: "right", render: (r) => fmtNum(r.new_patients), sortValue: (r) => r.new_patients },
  ];

  const columns: Column<Doctor>[] = [
    { key: "name", header: t("Ιατρός", "Doctor") },
    { key: "specialty", header: t("Ειδικότητα", "Specialty") },
    { key: "rx_count", header: t("Συνταγές", "Prescriptions"), align: "right", render: (r) => fmtNum(r.rx_count) },
    { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value) },
    { key: "gross_profit", header: t("Κερδοφορία", "Profitability"), align: "right", render: (r) => fmtEur(r.gross_profit) },
    { key: "new_patients", header: t("Νέοι πελάτες", "New patients"), align: "right", render: (r) => fmtNum(r.new_patients) },
  ];

  return (
    <ModuleGuard module="doctor_analytics">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Ιατροί", "Doctors")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Στατιστικά συνταγογράφησης ανά ιατρό", "Prescribing statistics by doctor")}</p>
        </div>
        <ExportMenu filename="iatroi" title={t("Ιατροί — στατιστικά συνταγογράφησης", "Doctors — prescribing statistics")} rows={items} columns={[
          { key: "name", header: t("Ιατρός", "Doctor") },
          { key: "specialty", header: t("Ειδικότητα", "Specialty"), value: (r) => r.specialty || "—" },
          { key: "rx_count", header: t("Συνταγές", "Prescriptions") },
          { key: "value", header: t("Αξία (€)", "Value (€)"), value: (r) => fmtMoney(r.value) },
          { key: "gross_profit", header: t("Κερδοφορία (€)", "Profitability (€)"), value: (r) => fmtMoney(r.gross_profit) },
          { key: "new_patients", header: t("Νέοι πελάτες", "New patients") },
        ]} />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <DateRangeFilter />
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">{t("Ταξινόμηση κατά", "Sort by")}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none">
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>

      <QueryState isLoading={isLoading} isError={isError} onRetry={() => refetch()}>
        <div className="space-y-4">
          {showKpi && (<>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            <KpiCard label={t("Ιατροί", "Doctors")} help={t("Πλήθος ιατρών που συνταγογράφησαν στην περίοδο.", "Doctors who prescribed in the period.")} value={fmtNum(items.length)} sub={t("ανά ειδικότητα →", "by specialty →")} icon={Stethoscope} accent="indigo" trend={hasPrev ? pctDelta(items.length, pItems.length) : undefined}
              onClick={() => setModal({ title: t("Ιατροί ανά ειδικότητα", "Doctors by specialty"), view: "specialty", metric: "value" })} />
            <KpiCard label={t("Συνταγές", "Prescriptions")} help={t("Πλήθος εκτελέσεων συνταγών στην περίοδο.", "Number of executions in the period.")} value={fmtNum(sum((d) => d.rx_count))} sub={t("ανά ιατρό →", "by doctor →")} icon={BarChart3} accent="violet" trend={hasPrev ? pctDelta(sum((d) => d.rx_count), psum((d) => d.rx_count)) : undefined}
              onClick={() => setModal({ title: t("Συνταγές ανά ιατρό", "Prescriptions by doctor"), view: "doctor", metric: "rx_count" })} />
            <KpiCard label={t("Αξία", "Value")} help={t("Άθροισμα λιανικής αξίας των εκτελέσεων της περιόδου.", "Sum of retail value of executions.")} value={fmtEur(sum((d) => d.value))} sub={t("ανά ιατρό & ειδικότητα →", "by doctor & specialty →")} icon={Wallet} accent="amber" trend={hasPrev ? pctDelta(sum((d) => d.value), psum((d) => d.value)) : undefined}
              onClick={() => setModal({ title: t("Αξία ανά ιατρό & ειδικότητα", "Value by doctor & specialty"), view: "doctor", metric: "value" })} />
            <KpiCard label={t("Κερδοφορία", "Profitability")} help={t("Μεικτό κέρδος = αιτούμενο − κόστος χονδρικής.", "Gross profit = claimed − wholesale cost.")} value={fmtEur(sum((d) => d.gross_profit))} sub={t("ανά ιατρό & ειδικότητα →", "by doctor & specialty →")} icon={TrendingUp} accent="green" trend={hasPrev ? pctDelta(sum((d) => d.gross_profit), psum((d) => d.gross_profit)) : undefined}
              onClick={() => setModal({ title: t("Κερδοφορία ανά ιατρό & ειδικότητα", "Profitability by doctor & specialty"), view: "doctor", metric: "gross_profit" })} />
            <KpiCard label={t("Νέοι πελάτες", "New patients")} help={t("Ασθενείς με πρώτη εκτέλεση στην περίοδο.", "Patients with their first execution in the period.")} value={fmtNum(sum((d) => d.new_patients))} sub={t("ανά ιατρό & ειδικότητα →", "by doctor & specialty →")} icon={UserPlus} accent="sky" trend={hasPrev ? pctDelta(sum((d) => d.new_patients), psum((d) => d.new_patients)) : undefined}
              onClick={() => setModal({ title: t("Νέοι πελάτες ανά ιατρό & ειδικότητα", "New patients by doctor & specialty"), view: "doctor", metric: "new_patients" })} />
          </div>

          {/* top doctors chart — auto-open στο view «Δείκτες» (#kpi)· key→remount ανά view */}
          {top.length > 0 && (
            <PanelCard key={view} collapsible defaultOpen={view === "kpi"} title={t("Top Ιατροί (αξία)", "Top Doctors (value)")}>
              <BarChart
                horizontal
                height={Math.max(220, top.length * 38)}
                labels={top.map((d) => d.name)}
                data={top.map((d) => Math.round(d.value / 100))}
                name="€"
              />
            </PanelCard>
          )}
          </>)}

          {/* table / cards */}
          {showList && (
          <DataTable pageSize={20}
            columns={columns}
            rows={items}
            rowKey={(r) => r.id}
            onRowClick={(r) => router.push(`/doctors/${r.id}`)}
          />
          )}
        </div>
      </QueryState>

      {/* KPI drill-down popup */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.title} size="3xl">
        {modal && (
          <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-slate-500">{modal.view === "specialty" ? t(`${specialtyRows.length} ειδικότητες`, `${specialtyRows.length} specialties`) : t(`${doctorRows.length} ιατροί`, `${doctorRows.length} doctors`)}</p>
            <button
              onClick={() => {
                if (modal.view === "specialty") {
                  downloadCsv("iatroi-ana-eidikotita", [
                    { key: "specialty", header: t("Ειδικότητα", "Specialty") }, { key: "doctors", header: t("Ιατροί", "Doctors") },
                    { key: "rx_count", header: t("Συνταγές", "Prescriptions") },
                    { key: "value", header: t("Αξία (€)", "Value (€)"), value: (r: SpecialtyRow) => fmtMoney(r.value) },
                    { key: "gross_profit", header: t("Κερδοφορία (€)", "Profitability (€)"), value: (r: SpecialtyRow) => fmtMoney(r.gross_profit) },
                    { key: "new_patients", header: t("Νέοι", "New") },
                  ], specialtyRows);
                } else {
                  downloadCsv("ana-iatro", [
                    { key: "name", header: t("Ιατρός", "Doctor") }, { key: "specialty", header: t("Ειδικότητα", "Specialty") },
                    { key: "rx_count", header: t("Συνταγές", "Prescriptions") },
                    { key: "value", header: t("Αξία (€)", "Value (€)"), value: (r: Doctor) => fmtMoney(r.value) },
                    { key: "gross_profit", header: t("Κερδοφορία (€)", "Profitability (€)"), value: (r: Doctor) => fmtMoney(r.gross_profit) },
                    { key: "new_patients", header: t("Νέοι", "New") },
                  ], doctorRows);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> {t("Εξαγωγή CSV", "Export CSV")}
            </button>
          </div>
        )}
        {modal?.view === "specialty"
          ? <DataTable pageSize={15} columns={specModalCols} rows={specialtyRows} rowKey={(r) => r.specialty} />
          : <DataTable pageSize={15} columns={docModalCols} rows={doctorRows} rowKey={(r) => r.id}
              onRowClick={(r) => router.push(`/doctors/${r.id}`)} />}
      </Modal>
    </ModuleGuard>
  );
}
