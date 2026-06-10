"use client";

import { useState, useMemo } from "react";
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
  // coverage horizon (days of needs to cover) + manual on-hand stock per product
  const [coverage, setCoverage] = useState(30);
  const [stock, setStock] = useState<Record<string, number>>({});
  const need = (r: Suggestion) => Math.ceil((r.avg_daily || 0) * coverage);          // ανάγκη για X μέρες
  const adj = (r: Suggestion) => Math.max(0, need(r) - (stock[r.product_id] || 0));   // παράγγειλε = ανάγκη − απόθεμα
  const unitCost = (r: Suggestion) => (r.suggested_qty ? (r.est_cost || 0) / r.suggested_qty : 0);
  const adjCost = (r: Suggestion) => Math.round(unitCost(r) * adj(r));

  const cols = useMemo<Column<Suggestion>[]>(() => [
    { key: "product_name", header: "Σκεύασμα", render: (r) => r.product_name || "—", sortValue: (r) => r.product_name },
    { key: "substance", header: "Δραστική", hideOnMobile: true, render: (r) => r.substance || "—" },
    { key: "avg_daily", header: "Μ.Ο./ημέρα", align: "right", render: (r) => fmtNum(r.avg_daily), sortValue: (r) => r.avg_daily, hideOnMobile: true },
    { key: "need", header: `Ανάγκη ${coverage}ημ.`, align: "right", render: (r) => fmtNum(need(r)), sortValue: (r) => need(r) },
    { key: "stock", header: "Απόθεμα", align: "right", render: (r) => (
      <input type="number" min={0} value={stock[r.product_id] ?? ""} placeholder="0"
        onChange={(e) => setStock((s) => ({ ...s, [r.product_id]: Math.max(0, parseInt(e.target.value) || 0) }))}
        onClick={(e) => e.stopPropagation()}
        className="w-16 rounded-md border border-slate-300 px-1.5 py-0.5 text-right text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" /> ) },
    { key: "adjusted", header: "Παράγγειλε", align: "right", render: (r) => <span className={`font-bold ${adj(r) > 0 ? "text-brand-700 dark:text-brand-300" : "text-slate-300"}`}>{fmtNum(adj(r))}</span>, sortValue: (r) => adj(r) },
    { key: "est_cost", header: "Εκτ. κόστος", align: "right", render: (r) => fmtEur(adjCost(r)), sortValue: (r) => adjCost(r) },
  ], [stock, coverage]);

  const totalQty = items.reduce((s, r) => s + adj(r), 0);
  const totalCost = items.reduce((s, r) => s + adjCost(r), 0);
  const substances = new Set(items.map((r) => r.substance).filter(Boolean)).size;
  const top = [...items].filter((r) => adj(r) > 0).sort((a, b) => adj(b) - adj(a)).slice(0, 10);

  return (
    <ModuleGuard module="order_suggestions">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Προτάσεις παραγγελίας</h1>
          <p className="mt-1 text-sm text-slate-500">Διάλεξε πόσων ημερών ανάγκες θες να καλύψεις — οι ποσότητες προσαρμόζονται αυτόματα.</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900">
            <span className="mr-1 text-xs font-medium text-slate-500">Κάλυψη:</span>
            {[7, 14, 30, 60].map((d) => (
              <button key={d} type="button" onClick={() => setCoverage(d)}
                className={`rounded px-2 py-0.5 text-xs font-semibold ${coverage === d ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`}>{d}ημ.</button>
            ))}
            <input type="number" min={1} value={coverage} onChange={(e) => setCoverage(Math.max(1, parseInt(e.target.value) || 1))}
              className="ml-1 w-14 rounded border border-slate-300 px-1 py-0.5 text-right text-xs dark:border-slate-600 dark:bg-slate-800" />
            <span className="text-xs text-slate-400">ημέρες</span>
          </div>
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
            { key: "stock", header: "Απόθεμα", value: (r) => String(stock[r.product_id] ?? 0) },
            { key: "adjusted", header: "Παράγγειλε", value: (r) => String(adj(r)) },
            { key: "est_cost", header: "Εκτ. κόστος (€)", value: (r) => (adjCost(r) / 100).toFixed(2) },
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
                data={top.map((r) => adj(r))}
                name="Τεμάχια"
              />
            </PanelCard>
          )}

          {/* table / cards */}
          <DataTable pageSize={20} columns={cols} rows={items} rowKey={(r) => r.product_id} />
        </div>
      </QueryState>
    </ModuleGuard>
  );
}
