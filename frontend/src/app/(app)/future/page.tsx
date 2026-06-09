"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, CalendarDays, CalendarRange, Pill } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtNum, fmtDate } from "@/lib/formatters";
import { SelectFilter } from "@/components/filters/SelectFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { LineChart } from "@/components/charts/LineChart";
import { Modal } from "@/components/ui/Modal";

type UpcomingDay = { date: string; count: number };
type ForecastRow = { product_id: string; name: string; expected_demand: number };
type FutureRx = {
  expected_open_date: string; patient_name?: string | null; amka?: string | null;
  source_barcode?: string | null; products?: (string | null)[]; n_items?: number; confidence?: number;
};

const futureCols: Column<FutureRx>[] = [
  { key: "expected_open_date", header: "Αναμένεται", render: (r) => fmtDate(r.expected_open_date) },
  { key: "patient_name", header: "Ασθενής", render: (r) => r.patient_name || "—" },
  { key: "amka", header: "ΑΜΚΑ", hideOnMobile: true, render: (r) => r.amka || "—" },
  { key: "products", header: "Σκευάσματα", render: (r) => (r.products ?? []).filter(Boolean).join(", ") || `${r.n_items ?? 0} είδη` },
  { key: "source_barcode", header: "Από συνταγή", hideOnMobile: true, render: (r) => r.source_barcode || "—" },
];

const HISTORY = [
  { value: "0", label: "Όλοι οι ασφαλισμένοι" },
  { value: "1", label: "≥ 1 προηγούμενη" },
  { value: "2", label: "≥ 2 προηγούμενες" },
  { value: "3", label: "≥ 3 προηγούμενες" },
  { value: "5", label: "≥ 5 προηγούμενες" },
];

const forecastColumns: Column<ForecastRow>[] = [
  { key: "name", header: "Σκεύασμα", render: (r) => r.name ?? r.product_id },
  { key: "expected_demand", header: "Αναμενόμενη ζήτηση", align: "right", render: (r) => fmtNum(r.expected_demand) },
];

export default function FuturePage() {
  const [minHistory, setMinHistory] = useState("0");
  const [modal, setModal] = useState<{ title: string; subtitle: string; qs: string } | null>(null);

  const list = useQuery({
    queryKey: ["future", "list", modal?.qs],
    queryFn: () => api<{ items: FutureRx[] }>(`/future/upcoming-list?${modal!.qs}`),
    enabled: !!modal,
  });

  const upcoming = useQuery({
    queryKey: ["future", "upcoming", 30, minHistory],
    queryFn: () => api<{ items: UpcomingDay[] }>(`/future/upcoming?days=30&min_history=${minHistory}`),
  });

  const forecast = useQuery({
    queryKey: ["future", "forecast", 30],
    queryFn: () => api<{ items: ForecastRow[] }>(`/future/forecast?horizon_days=30`),
  });

  const days = upcoming.data?.items ?? [];
  const total = days.reduce((s, d) => s + d.count, 0);
  const next7 = days.slice(0, 7).reduce((s, d) => s + d.count, 0);
  const next30 = total;
  const peak = days.reduce<UpcomingDay | null>((m, d) => (!m || d.count > m.count ? d : m), null);

  return (
    <ModuleGuard module="future_prescriptions">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Μελλοντικές συνταγές</h1>
          <p className="mt-1 text-sm text-slate-500">Πρόβλεψη επαναλαμβανόμενης ζήτησης τις επόμενες 30 ημέρες</p>
        </div>
      </div>

      <div className="mb-4">
        <SelectFilter
          label="Πελάτες με ιστορικό"
          value={minHistory}
          options={HISTORY}
          onChange={(v) => setMinHistory(v ?? "0")}
          allLabel="Όλοι οι ασφαλισμένοι"
        />
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label="Μελλοντικές συνταγές" value={fmtNum(total)} sub="σύνολο 30 ημερών · δες λίστα" icon={CalendarClock} accent="indigo"
            onClick={() => setModal({ title: "Μελλοντικές συνταγές — 30 ημέρες", subtitle: `${total} συνταγές αναμένονται`, qs: `days=30&min_history=${minHistory}` })} />
          <KpiCard label="Επόμενες 7 ημέρες" value={fmtNum(next7)} sub="συνταγές · δες λίστα" icon={CalendarDays} accent="violet"
            onClick={() => setModal({ title: "Επόμενες 7 ημέρες", subtitle: `${next7} συνταγές`, qs: `days=7&min_history=${minHistory}` })} />
          <KpiCard label="Επόμενες 30 ημέρες" value={fmtNum(next30)} sub="συνταγές · δες λίστα" icon={CalendarRange} accent="amber"
            onClick={() => setModal({ title: "Επόμενες 30 ημέρες", subtitle: `${next30} συνταγές`, qs: `days=30&min_history=${minHistory}` })} />
          <KpiCard
            label="Ημέρα αιχμής"
            value={peak ? fmtNum(peak.count) : "—"}
            sub={peak ? `${fmtDate(peak.date)} · δες λίστα` : "—"}
            icon={Pill}
            accent="sky"
            onClick={peak ? () => setModal({ title: `Ημέρα αιχμής — ${fmtDate(peak.date)}`, subtitle: `${peak.count} συνταγές αναμένονται`, qs: `date=${peak.date}&min_history=${minHistory}` }) : undefined}
          />
        </div>

        {/* upcoming-by-day chart */}
        <PanelCard title="Συνταγές που ανοίγουν ανά ημέρα (30 ημέρες)">
          <LineChart
            labels={days.map((d) => fmtDate(d.date))}
            data={days.map((d) => d.count)}
            name="Συνταγές"
            height={300}
          />
        </PanelCard>

        {/* forecast table */}
        <PanelCard title="Πρόβλεψη ζήτησης ανά σκεύασμα (30 ημέρες)" bodyClassName="pt-2">
          <QueryState
            isLoading={forecast.isLoading}
            isError={forecast.isError}
            isEmpty={(forecast.data?.items?.length ?? 0) === 0}
            onRetry={() => forecast.refetch()}
          >
            <DataTable pageSize={20} columns={forecastColumns} rows={forecast.data?.items ?? []} rowKey={(r) => r.product_id} />
          </QueryState>
        </PanelCard>
      </div>

      {/* drill-down popup: the individual prescriptions behind a KPI */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.title} size="3xl">
        {modal && <p className="-mt-2 mb-3 text-sm text-slate-500">{modal.subtitle}</p>}
        <QueryState
          isLoading={list.isLoading}
          isError={list.isError}
          isEmpty={(list.data?.items?.length ?? 0) === 0}
          onRetry={() => list.refetch()}
          empty="Καμία αναμενόμενη συνταγή."
        >
          <DataTable pageSize={15} columns={futureCols} rows={list.data?.items ?? []}
            rowKey={(r, i) => `${r.source_barcode}-${i}`} />
        </QueryState>
      </Modal>
    </ModuleGuard>
  );
}
