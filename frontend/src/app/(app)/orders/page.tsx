"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, PackageSearch, RefreshCw, Wallet } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
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
  const t = useT();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.orderSuggestions(),
    queryFn: () => api<{ items: Suggestion[] }>(`/orders/suggestions`),
  });

  const recompute = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/orders/suggestions/recompute`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orderSuggestions() });
      toastSuccess(t("Οι προτάσεις παραγγελίας επαναϋπολογίστηκαν.", "Order suggestions recomputed."));
    },
    onError: () => toastError(t("Αποτυχία επανυπολογισμού — δοκιμάστε ξανά.", "Recompute failed — please try again.")),
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
    { key: "product_name", header: t("Σκεύασμα", "Product"), render: (r) => r.product_name || "—", sortValue: (r) => r.product_name },
    { key: "substance", header: t("Δραστική", "Active substance"), hideOnMobile: true, render: (r) => r.substance || "—" },
    { key: "avg_daily", header: t("Μ.Ο./ημέρα", "Avg/day"), align: "right", render: (r) => fmtNum(r.avg_daily), sortValue: (r) => r.avg_daily, hideOnMobile: true },
    { key: "need", header: t(`Ανάγκη ${coverage}ημ.`, `Need ${coverage}d`), align: "right", render: (r) => fmtNum(need(r)), sortValue: (r) => need(r) },
    { key: "stock", header: t("Απόθεμα", "Stock"), align: "right", render: (r) => (
      <input type="number" min={0} value={stock[r.product_id] ?? ""} placeholder="0"
        onChange={(e) => setStock((s) => ({ ...s, [r.product_id]: Math.max(0, parseInt(e.target.value) || 0) }))}
        onClick={(e) => e.stopPropagation()}
        className="w-16 rounded-md border border-slate-300 px-1.5 py-0.5 text-right text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" /> ) },
    { key: "adjusted", header: t("Παράγγειλε", "Order"), align: "right", render: (r) => <span className={`font-bold ${adj(r) > 0 ? "text-brand-700 dark:text-brand-300" : "text-slate-300"}`}>{fmtNum(adj(r))}</span>, sortValue: (r) => adj(r) },
    { key: "est_cost", header: t("Εκτ. κόστος", "Est. cost"), align: "right", render: (r) => fmtEur(adjCost(r)), sortValue: (r) => adjCost(r) },
  ], [stock, coverage, t]);

  const totalQty = items.reduce((s, r) => s + adj(r), 0);
  const totalCost = items.reduce((s, r) => s + adjCost(r), 0);
  const substances = new Set(items.map((r) => r.substance).filter(Boolean)).size;
  const top = [...items].filter((r) => adj(r) > 0).sort((a, b) => adj(b) - adj(a)).slice(0, 10);

  return (
    <ModuleGuard module="order_suggestions">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Προτάσεις παραγγελίας", "Order suggestions")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Διάλεξε πόσων ημερών ανάγκες θες να καλύψεις — οι ποσότητες προσαρμόζονται αυτόματα.", "Choose how many days of needs to cover — quantities adjust automatically.")}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900">
            <span className="mr-1 text-xs font-medium text-slate-500">{t("Κάλυψη:", "Coverage:")}</span>
            {[7, 14, 30, 60].map((d) => (
              <button key={d} type="button" onClick={() => setCoverage(d)}
                className={`rounded px-2 py-0.5 text-xs font-semibold ${coverage === d ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`}>{t(`${d}ημ.`, `${d}d`)}</button>
            ))}
            <input type="number" min={1} value={coverage} onChange={(e) => setCoverage(Math.max(1, parseInt(e.target.value) || 1))}
              className="ml-1 w-14 rounded border border-slate-300 px-1 py-0.5 text-right text-xs dark:border-slate-600 dark:bg-slate-800" />
            <span className="text-xs text-slate-400">{t("ημέρες", "days")}</span>
          </div>
          <button
            type="button"
            onClick={() => recompute.mutate()}
            disabled={recompute.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${recompute.isPending ? "animate-spin" : ""}`} />
            {recompute.isPending ? t("Υπολογισμός…", "Computing…") : t("Επανυπολογισμός", "Recompute")}
          </button>
          <ExportMenu filename="protaseis-paraggelias" title={t("Προτάσεις παραγγελίας", "Order suggestions")} label={t("Εξαγωγή προς φαρμακαποθήκη", "Export to wholesaler")} rows={items} columns={[
            { key: "product_name", header: t("Σκεύασμα", "Product") },
            { key: "substance", header: t("Δραστική", "Active substance"), value: (r) => r.substance || "—" },
            { key: "avg_daily", header: t("Μ.Ο./ημέρα", "Avg/day") },
            { key: "expected_demand", header: t("Αναμ. ζήτηση", "Expected demand") },
            { key: "suggested_qty", header: t("Πρόταση", "Suggestion") },
            { key: "stock", header: t("Απόθεμα", "Stock"), value: (r) => String(stock[r.product_id] ?? 0) },
            { key: "adjusted", header: t("Παράγγειλε", "Order"), value: (r) => String(adj(r)) },
            { key: "est_cost", header: t("Εκτ. κόστος (€)", "Est. cost (€)"), value: (r) => (adjCost(r) / 100).toFixed(2) },
          ]} />
        </div>
      </div>

      <QueryState isLoading={isLoading} isError={isError} onRetry={() => refetch()}>
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <KpiCard label={t("Προτεινόμενα είδη", "Suggested items")} value={fmtNum(items.length)} sub={t("σκευάσματα", "products")} icon={PackageSearch} accent="indigo" />
            <KpiCard label={t("Συνολική ποσότητα", "Total quantity")} value={fmtNum(totalQty)} sub={t("τεμάχια προς παραγγελία", "units to order")} icon={Boxes} accent="violet" />
            <KpiCard label={t("Εκτ. κόστος", "Est. cost")} value={fmtEur(totalCost)} sub={t("σύνολο πρότασης", "suggestion total")} icon={Wallet} accent="amber" />
            <KpiCard label={t("Δραστικές ουσίες", "Active substances")} value={fmtNum(substances)} sub={t("μοναδικές", "unique")} icon={RefreshCw} accent="sky" />
          </div>

          {/* suggested qty chart */}
          {top.length > 0 && (
            <PanelCard title={t("Top προτεινόμενες ποσότητες", "Top suggested quantities")}>
              <BarChart
                horizontal
                height={Math.max(220, top.length * 38)}
                labels={top.map((r) => r.product_name)}
                data={top.map((r) => adj(r))}
                name={t("Τεμάχια", "Units")}
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
