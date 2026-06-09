"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, PackageSearch, RefreshCw, Wallet } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { BarChart } from "@/components/charts/BarChart";
import { toastError, toastSuccess } from "@/store/toastStore";

type Suggestion = {
  product_id: string;
  product_name: string;
  substance?: string | null;
  expected_demand: number;
  on_hand?: number | null;
  avg_daily: number;
  suggested_qty: number;
  est_cost: number; // cents
  supplier?: string | null;
};

const columns: Column<Suggestion>[] = [
  { key: "product_name", header: "Σκεύασμα", render: (r) => r.product_name || "—", sortValue: (r) => r.product_name },
  { key: "substance", header: "Δραστική", hideOnMobile: true, render: (r) => r.substance || "—" },
  { key: "avg_daily", header: "Μ.Ο./ημέρα", align: "right", render: (r) => fmtNum(r.avg_daily), sortValue: (r) => r.avg_daily, hideOnMobile: true },
  { key: "expected_demand", header: "Αναμ. ζήτηση", align: "right", render: (r) => fmtNum(r.expected_demand), sortValue: (r) => r.expected_demand, hideOnMobile: true },
  { key: "suggested_qty", header: "Πρόταση", align: "right", render: (r) => fmtNum(r.suggested_qty), sortValue: (r) => r.suggested_qty },
  { key: "est_cost", header: "Εκτ. κόστος", align: "right", render: (r) => fmtEur(r.est_cost), sortValue: (r) => r.est_cost },
];

export default function OrdersPage() {
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.orderSuggestions(),
    queryFn: () => api<{ items: Suggestion[] }>(`/orders/suggestions`),
  });

  const recompute = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/orders/suggestions/recompute`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orderSuggestions() });
      toastSuccess("Οι προτάσεις παραγγελίας επαναϋπολογίστηκαν.");
    },
    onError: () => toastError("Αποτυχία επανυπολογισμού — δοκιμάστε ξανά."),
  });

  const items = data?.items ?? [];
  const totalQty = items.reduce((s, r) => s + (r.suggested_qty || 0), 0);
  const totalCost = items.reduce((s, r) => s + (r.est_cost || 0), 0);
  const substances = new Set(items.map((r) => r.substance).filter(Boolean)).size;
  const top = [...items].sort((a, b) => b.suggested_qty - a.suggested_qty).slice(0, 10);

  return (
    <ModuleGuard module="order_suggestions">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Προτάσεις παραγγελίας</h1>
          <p className="mt-1 text-sm text-slate-500">Αυτόματες προτάσεις αναπλήρωσης αποθέματος</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <button
            type="button"
            onClick={() => recompute.mutate()}
            disabled={recompute.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${recompute.isPending ? "animate-spin" : ""}`} />
            {recompute.isPending ? "Υπολογισμός…" : "Επανυπολογισμός"}
          </button>
          <ExportMenu filename="protaseis-paraggelias" title="Προτάσεις παραγγελίας" label="Εξαγωγή προς φαρμακαποθήκη" rows={items} columns={[
            { key: "product_name", header: "Σκεύασμα" },
            { key: "substance", header: "Δραστική", value: (r) => r.substance || "—" },
            { key: "avg_daily", header: "Μ.Ο./ημέρα" },
            { key: "expected_demand", header: "Αναμ. ζήτηση" },
            { key: "suggested_qty", header: "Πρόταση" },
            { key: "est_cost", header: "Εκτ. κόστος (€)", value: (r) => ((r.est_cost || 0) / 100).toFixed(2) },
          ]} />
        </div>
      </div>

      <QueryState isLoading={isLoading} isError={isError} onRetry={() => refetch()}>
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <KpiCard label="Προτεινόμενα είδη" value={fmtNum(items.length)} sub="σκευάσματα" icon={PackageSearch} accent="indigo" />
            <KpiCard label="Συνολική ποσότητα" value={fmtNum(totalQty)} sub="τεμάχια προς παραγγελία" icon={Boxes} accent="violet" />
            <KpiCard label="Εκτ. κόστος" value={fmtEur(totalCost)} sub="σύνολο πρότασης" icon={Wallet} accent="amber" />
            <KpiCard label="Δραστικές ουσίες" value={fmtNum(substances)} sub="μοναδικές" icon={RefreshCw} accent="sky" />
          </div>

          {/* suggested qty chart */}
          {top.length > 0 && (
            <PanelCard title="Top προτεινόμενες ποσότητες">
              <BarChart
                horizontal
                height={Math.max(220, top.length * 38)}
                labels={top.map((r) => r.product_name)}
                data={top.map((r) => r.suggested_qty)}
                name="Τεμάχια"
              />
            </PanelCard>
          )}

          {/* table / cards */}
          <DataTable pageSize={20} columns={columns} rows={items} rowKey={(r) => r.product_id} />
        </div>
      </QueryState>
    </ModuleGuard>
  );
}
