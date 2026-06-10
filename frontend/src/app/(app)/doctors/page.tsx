"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { BarChart3, Stethoscope, TrendingUp, UserPlus, Wallet, Download } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { downloadCsv } from "@/lib/csv";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { BarChart } from "@/components/charts/BarChart";
import { Modal } from "@/components/ui/Modal";

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

const SORTS = [
  { value: "value", label: "Αξία (μεγαλύτερη)" },
  { value: "rx", label: "Συνταγές (περισσότερες)" },
  { value: "profit", label: "Κερδοφορία (μεγαλύτερη)" },
  { value: "patients", label: "Νέοι πελάτες (περισσότεροι)" },
  { value: "name", label: "Όνομα (Α→Ω)" },
];

export default function DoctorsPage() {
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
    queryFn: () => api<{ items: Doctor[] }>(`/doctors?${filtersToQuery({ ...filters, dateFrom: pr!.from, dateTo: pr!.to })}&sort=value`),
    enabled: !!pr,
  });

  const items = data?.items ?? [];
  const sum = (f: (d: Doctor) => number) => items.reduce((a, d) => a + (f(d) || 0), 0);
  const pItems = prevDoc.data?.items ?? [];
  const psum = (f: (d: Doctor) => number) => pItems.reduce((a, d) => a + (f(d) || 0), 0);
  const hasPrev = !!prevDoc.data;
  const top = [...items].sort((a, b) => b.value - a.value).slice(0, 8);

  // KPI drill-down popup (client-side — all doctors+stats are already loaded)
  const [modal, setModal] = useState<{ title: string; view: "doctor" | "specialty"; metric: DocMetric } | null>(null);
  const doctorRows = modal ? [...items].sort((a, b) => (b[modal.metric] as number) - (a[modal.metric] as number)) : [];
  const specialtyRows: SpecialtyRow[] = (() => {
    const m = new Map<string, SpecialtyRow>();
    for (const d of items) {
      const s = d.specialty || "— (χωρίς ειδικότητα)";
      const g = m.get(s) ?? { specialty: s, doctors: 0, rx_count: 0, value: 0, gross_profit: 0, new_patients: 0 };
      g.doctors += 1; g.rx_count += d.rx_count || 0; g.value += d.value || 0;
      g.gross_profit += d.gross_profit || 0; g.new_patients += d.new_patients || 0;
      m.set(s, g);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  })();

  const docModalCols: Column<Doctor>[] = [
    { key: "name", header: "Ιατρός" },
    { key: "specialty", header: "Ειδικότητα", render: (r) => r.specialty || "—" },
    { key: "rx_count", header: "Συνταγές", align: "right", render: (r) => fmtNum(r.rx_count), sortValue: (r) => r.rx_count },
    { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value), sortValue: (r) => r.value },
    { key: "gross_profit", header: "Κερδοφορία", align: "right", render: (r) => fmtEur(r.gross_profit), sortValue: (r) => r.gross_profit },
    { key: "new_patients", header: "Νέοι", align: "right", render: (r) => fmtNum(r.new_patients), sortValue: (r) => r.new_patients },
  ];
  const specModalCols: Column<SpecialtyRow>[] = [
    { key: "specialty", header: "Ειδικότητα" },
    { key: "doctors", header: "Ιατροί", align: "right", render: (r) => fmtNum(r.doctors), sortValue: (r) => r.doctors },
    { key: "rx_count", header: "Συνταγές", align: "right", render: (r) => fmtNum(r.rx_count), sortValue: (r) => r.rx_count },
    { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value), sortValue: (r) => r.value },
    { key: "gross_profit", header: "Κερδοφορία", align: "right", render: (r) => fmtEur(r.gross_profit), sortValue: (r) => r.gross_profit },
    { key: "new_patients", header: "Νέοι", align: "right", render: (r) => fmtNum(r.new_patients), sortValue: (r) => r.new_patients },
  ];

  const columns: Column<Doctor>[] = [
    { key: "name", header: "Ιατρός" },
    { key: "specialty", header: "Ειδικότητα" },
    { key: "rx_count", header: "Συνταγές", align: "right", render: (r) => fmtNum(r.rx_count) },
    { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value) },
    { key: "gross_profit", header: "Κερδοφορία", align: "right", render: (r) => fmtEur(r.gross_profit) },
    { key: "new_patients", header: "Νέοι πελάτες", align: "right", render: (r) => fmtNum(r.new_patients) },
  ];

  return (
    <ModuleGuard module="doctor_analytics">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Ιατροί</h1>
          <p className="mt-1 text-sm text-slate-500">Στατιστικά συνταγογράφησης ανά ιατρό</p>
        </div>
        <ExportMenu filename="iatroi" title="Ιατροί — στατιστικά συνταγογράφησης" rows={items} columns={[
          { key: "name", header: "Ιατρός" },
          { key: "specialty", header: "Ειδικότητα", value: (r) => r.specialty || "—" },
          { key: "rx_count", header: "Συνταγές" },
          { key: "value", header: "Αξία (€)", value: (r) => (r.value / 100).toFixed(2) },
          { key: "gross_profit", header: "Κερδοφορία (€)", value: (r) => (r.gross_profit / 100).toFixed(2) },
          { key: "new_patients", header: "Νέοι πελάτες" },
        ]} />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <DateRangeFilter />
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">Ταξινόμηση κατά</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none">
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>

      <QueryState isLoading={isLoading} isError={isError} onRetry={() => refetch()}>
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            <KpiCard label="Ιατροί" value={fmtNum(items.length)} sub="ανά ειδικότητα →" icon={Stethoscope} accent="indigo" trend={hasPrev ? pctDelta(items.length, pItems.length) : undefined}
              onClick={() => setModal({ title: "Ιατροί ανά ειδικότητα", view: "specialty", metric: "value" })} />
            <KpiCard label="Συνταγές" value={fmtNum(sum((d) => d.rx_count))} sub="ανά ιατρό →" icon={BarChart3} accent="violet" trend={hasPrev ? pctDelta(sum((d) => d.rx_count), psum((d) => d.rx_count)) : undefined}
              onClick={() => setModal({ title: "Συνταγές ανά ιατρό", view: "doctor", metric: "rx_count" })} />
            <KpiCard label="Αξία" value={fmtEur(sum((d) => d.value))} sub="ανά ιατρό & ειδικότητα →" icon={Wallet} accent="amber" trend={hasPrev ? pctDelta(sum((d) => d.value), psum((d) => d.value)) : undefined}
              onClick={() => setModal({ title: "Αξία ανά ιατρό & ειδικότητα", view: "doctor", metric: "value" })} />
            <KpiCard label="Κερδοφορία" value={fmtEur(sum((d) => d.gross_profit))} sub="ανά ιατρό & ειδικότητα →" icon={TrendingUp} accent="green" trend={hasPrev ? pctDelta(sum((d) => d.gross_profit), psum((d) => d.gross_profit)) : undefined}
              onClick={() => setModal({ title: "Κερδοφορία ανά ιατρό & ειδικότητα", view: "doctor", metric: "gross_profit" })} />
            <KpiCard label="Νέοι πελάτες" value={fmtNum(sum((d) => d.new_patients))} sub="ανά ιατρό & ειδικότητα →" icon={UserPlus} accent="sky" trend={hasPrev ? pctDelta(sum((d) => d.new_patients), psum((d) => d.new_patients)) : undefined}
              onClick={() => setModal({ title: "Νέοι πελάτες ανά ιατρό & ειδικότητα", view: "doctor", metric: "new_patients" })} />
          </div>

          {/* top doctors chart */}
          {top.length > 0 && (
            <PanelCard collapsible defaultOpen={false} title="Top Ιατροί (αξία)">
              <BarChart
                horizontal
                height={Math.max(220, top.length * 38)}
                labels={top.map((d) => d.name)}
                data={top.map((d) => Math.round(d.value / 100))}
                name="€"
              />
            </PanelCard>
          )}

          {/* table / cards */}
          <DataTable pageSize={20}
            columns={columns}
            rows={items}
            rowKey={(r) => r.id}
            onRowClick={(r) => router.push(`/doctors/${r.id}`)}
          />
        </div>
      </QueryState>

      {/* KPI drill-down popup */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.title} size="3xl">
        {modal && (
          <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-slate-500">{modal.view === "specialty" ? `${specialtyRows.length} ειδικότητες` : `${doctorRows.length} ιατροί`}</p>
            <button
              onClick={() => {
                if (modal.view === "specialty") {
                  downloadCsv("iatroi-ana-eidikotita", [
                    { key: "specialty", header: "Ειδικότητα" }, { key: "doctors", header: "Ιατροί" },
                    { key: "rx_count", header: "Συνταγές" },
                    { key: "value", header: "Αξία (€)", value: (r: SpecialtyRow) => (r.value / 100).toFixed(2) },
                    { key: "gross_profit", header: "Κερδοφορία (€)", value: (r: SpecialtyRow) => (r.gross_profit / 100).toFixed(2) },
                    { key: "new_patients", header: "Νέοι" },
                  ], specialtyRows);
                } else {
                  downloadCsv("ana-iatro", [
                    { key: "name", header: "Ιατρός" }, { key: "specialty", header: "Ειδικότητα" },
                    { key: "rx_count", header: "Συνταγές" },
                    { key: "value", header: "Αξία (€)", value: (r: Doctor) => (r.value / 100).toFixed(2) },
                    { key: "gross_profit", header: "Κερδοφορία (€)", value: (r: Doctor) => (r.gross_profit / 100).toFixed(2) },
                    { key: "new_patients", header: "Νέοι" },
                  ], doctorRows);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> Εξαγωγή CSV
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
