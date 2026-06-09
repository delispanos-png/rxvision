"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { BarChart3, Stethoscope, TrendingUp, UserPlus, Wallet } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportButton } from "@/components/export/ExportButton";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { BarChart } from "@/components/charts/BarChart";

type Doctor = {
  id: string;
  name: string;
  specialty: string;
  rx_count: number;
  value: number; // cents
  gross_profit: number; // cents
  new_patients: number;
};

export default function DoctorsPage() {
  const router = useRouter();
  const filters = useUiStore();
  const q = filtersToQuery(filters);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.doctors(q),
    queryFn: () => api<{ items: Doctor[] }>(`/doctors?${q}`),
  });

  const items = data?.items ?? [];
  const sum = (f: (d: Doctor) => number) => items.reduce((a, d) => a + (f(d) || 0), 0);
  const top = [...items].sort((a, b) => b.value - a.value).slice(0, 8);

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
        <ExportButton path="/doctors" query={`?${q}`} />
      </div>

      <div className="mb-4"><DateRangeFilter /></div>

      <QueryState isLoading={isLoading} isError={isError} onRetry={() => refetch()}>
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            <KpiCard label="Ιατροί" value={fmtNum(items.length)} icon={Stethoscope} accent="indigo" />
            <KpiCard label="Συνταγές" value={fmtNum(sum((d) => d.rx_count))} icon={BarChart3} accent="violet" />
            <KpiCard label="Αξία" value={fmtEur(sum((d) => d.value))} icon={Wallet} accent="amber" />
            <KpiCard label="Κερδοφορία" value={fmtEur(sum((d) => d.gross_profit))} icon={TrendingUp} accent="green" />
            <KpiCard label="Νέοι πελάτες" value={fmtNum(sum((d) => d.new_patients))} icon={UserPlus} accent="sky" />
          </div>

          {/* top doctors chart */}
          {top.length > 0 && (
            <PanelCard title="Top Ιατροί (αξία)">
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
    </ModuleGuard>
  );
}
