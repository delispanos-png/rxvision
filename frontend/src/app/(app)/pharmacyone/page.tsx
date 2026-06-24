"use client";

import { useQuery } from "@tanstack/react-query";
import { Crown, ShoppingCart, Users, XCircle } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { BarChart } from "@/components/charts/BarChart";

type SellerRow = { seller: string; orders: number; value: number };
type Unexecuted = { id: string; created_at: string; patient_ref: string; product_name: string; reason: string };

export default function PharmacyOnePage() {
  const t = useT();
  const filters = useUiStore();
  const q = filtersToQuery(filters);

  const sellerColumns: Column<SellerRow>[] = [
    { key: "seller", header: t("Πωλητής", "Seller") },
    { key: "orders", header: t("Πωλήσεις", "Sales"), align: "right", render: (r) => fmtNum(r.orders) },
    { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value) },
  ];

  const unexecutedColumns: Column<Unexecuted>[] = [
    { key: "patient_ref", header: t("Ασφαλισμένος", "Patient") },
    { key: "product_name", header: t("Σκεύασμα", "Product") },
    { key: "reason", header: t("Αιτία", "Reason") },
  ];

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
          <p className="mt-1 text-sm text-slate-500">{t("Πωλήσεις ανά πωλητή και ανεκτέλεστα", "Sales per seller and unexecuted items")}</p>
        </div>
      </div>

      <div className="mb-4">
        <DateRangeFilter />
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label={t("Πωλήσεις", "Sales")} help={t("Συνολική αξία πωλήσεων της περιόδου.", "Total sales value.")} value={fmtEur(totalSales)} sub={t("σύνολο περιόδου", "period total")} icon={ShoppingCart} accent="indigo" />
          <KpiCard label={t("Παραγγελίες", "Orders")} help={t("Προτάσεις παραγγελίας βάσει εκτελέσεων/πρόβλεψης.", "Order suggestions.")} value={fmtNum(totalOrders)} sub={t("πλήθος πωλήσεων", "number of sales")} icon={Users} accent="violet" />
          <KpiCard label={t("Ανεκτέλεστα", "Unexecuted")} help={t("Επαναλήψεις που άνοιξαν αλλά δεν εκτελέστηκαν.", "Opened but unexecuted refills.")} value={fmtNum(unexecutedItems.length)} sub={t("προς εκτέλεση", "pending execution")} icon={XCircle} accent={unexecutedItems.length ? "rose" : "green"} />
          <KpiCard label={t("Top πωλητής", "Top seller")} help={t("Το είδος με τις περισσότερες πωλήσεις.", "Top-selling item.")} value={topSeller?.seller ?? "—"} sub={topSeller ? fmtEur(topSeller.value) : "—"} icon={Crown} accent="amber" />
        </div>

        {/* sales by seller chart */}
        {chartData.length > 0 && (
          <PanelCard title={t("Πωλήσεις ανά πωλητή", "Sales per seller")}>
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
        <PanelCard title={t("Αναλυτικά ανά πωλητή", "Breakdown by seller")} bodyClassName="pt-2">
          <DataTable pageSize={20} columns={sellerColumns} rows={sellers} rowKey={(r) => r.seller} />
        </PanelCard>

        {/* unexecuted table */}
        <PanelCard title={t("Ανεκτέλεστα", "Unexecuted")} bodyClassName="pt-2">
          <QueryState
            isLoading={unexecuted.isLoading}
            isError={unexecuted.isError}
            isEmpty={unexecutedItems.length === 0}
            onRetry={() => unexecuted.refetch()}
          >
            <DataTable pageSize={20} columns={unexecutedColumns} rows={unexecutedItems} rowKey={(r) => r.id} />
          </QueryState>
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
