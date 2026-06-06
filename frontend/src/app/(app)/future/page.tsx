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
import { LineChart } from "@/components/charts/LineChart";

type UpcomingDay = { date: string; count: number };
type ForecastRow = { product_id: string; name: string; expected_demand: number };

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
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Μελλοντικές συνταγές" value={fmtNum(total)} sub="σύνολο 30 ημερών" icon={CalendarClock} accent="indigo" />
          <KpiCard label="Επόμενες 7 ημέρες" value={fmtNum(next7)} sub="συνταγές" icon={CalendarDays} accent="violet" />
          <KpiCard label="Επόμενες 30 ημέρες" value={fmtNum(next30)} sub="συνταγές" icon={CalendarRange} accent="amber" />
          <KpiCard
            label="Ημέρα αιχμής"
            value={peak ? fmtNum(peak.count) : "—"}
            sub={peak ? fmtDate(peak.date) : "—"}
            icon={Pill}
            accent="sky"
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
          {forecast.isLoading ? (
            <div className="text-slate-400">Φόρτωση δεδομένων…</div>
          ) : (
            <DataTable columns={forecastColumns} rows={forecast.data?.items ?? []} rowKey={(r) => r.product_id} />
          )}
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
