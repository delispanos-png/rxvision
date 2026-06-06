"use client";

import { useQuery } from "@tanstack/react-query";
import { Crown, ShoppingCart, Users, XCircle } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { BarChart } from "@/components/charts/BarChart";

type SellerRow = { seller: string; orders: number; value: number };
type Unexecuted = { id: string; created_at: string; patient_ref: string; product_name: string; reason: string };

const sellerColumns: Column<SellerRow>[] = [
  { key: "seller", header: "Πωλητής" },
  { key: "orders", header: "Πωλήσεις", align: "right", render: (r) => fmtNum(r.orders) },
  { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value) },
];

const unexecutedColumns: Column<Unexecuted>[] = [
  { key: "patient_ref", header: "Ασφαλισμένος" },
  { key: "product_name", header: "Σκεύασμα" },
  { key: "reason", header: "Αιτία" },
];

export default function PharmacyOnePage() {
  const filters = useUiStore();
  const q = filtersToQuery(filters);

  const bySeller = useQuery({
    queryKey: queryKeys.pharmacyoneBySeller(q),
    queryFn: () => api<{ rows: SellerRow[] }>(`/pharmacyone/by-seller?${q}`),
  });
  const unexecuted = useQuery({
    queryKey: queryKeys.pharmacyoneUnexecuted(),
    queryFn: () => api<{ items: Unexecuted[] }>(`/pharmacyone/unexecuted`),
  });

  const sellers = bySeller.data?.rows ?? [];
  const unexecutedItems = unexecuted.data?.items ?? [];
  const totalSales = sellers.reduce((s, r) => s + (r.value || 0), 0);
  const totalOrders = sellers.reduce((s, r) => s + (r.orders || 0), 0);
  const topSeller = sellers.reduce<SellerRow | null>((m, r) => (!m || r.value > m.value ? r : m), null);
  const chartData = [...sellers].sort((a, b) => b.value - a.value).slice(0, 12);

  return (
    <ModuleGuard module="pharmacyone">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">PharmacyOne</h1>
          <p className="mt-1 text-sm text-slate-500">Πωλήσεις ανά πωλητή και ανεκτέλεστα</p>
        </div>
      </div>

      <div className="mb-4">
        <DateRangeFilter />
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Πωλήσεις" value={fmtEur(totalSales)} sub="σύνολο περιόδου" icon={ShoppingCart} accent="indigo" />
          <KpiCard label="Παραγγελίες" value={fmtNum(totalOrders)} sub="πλήθος πωλήσεων" icon={Users} accent="violet" />
          <KpiCard label="Ανεκτέλεστα" value={fmtNum(unexecutedItems.length)} sub="προς εκτέλεση" icon={XCircle} accent={unexecutedItems.length ? "rose" : "green"} />
          <KpiCard label="Top πωλητής" value={topSeller?.seller ?? "—"} sub={topSeller ? fmtEur(topSeller.value) : "—"} icon={Crown} accent="amber" />
        </div>

        {/* sales by seller chart */}
        {chartData.length > 0 && (
          <PanelCard title="Πωλήσεις ανά πωλητή">
            <BarChart
              horizontal
              height={Math.max(220, chartData.length * 38)}
              labels={chartData.map((s) => s.seller)}
              data={chartData.map((s) => Math.round((s.value || 0) / 100))}
              name="€"
            />
          </PanelCard>
        )}

        {/* sellers table */}
        <PanelCard title="Αναλυτικά ανά πωλητή" bodyClassName="pt-2">
          <DataTable columns={sellerColumns} rows={sellers} rowKey={(r) => r.seller} />
        </PanelCard>

        {/* unexecuted table */}
        <PanelCard title="Ανεκτέλεστα" bodyClassName="pt-2">
          {unexecuted.isLoading ? (
            <div className="text-slate-400">Φόρτωση δεδομένων…</div>
          ) : (
            <DataTable columns={unexecutedColumns} rows={unexecutedItems} rowKey={(r) => r.id} />
          )}
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
