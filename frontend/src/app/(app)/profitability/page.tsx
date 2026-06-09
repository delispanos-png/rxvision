"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Percent, Coins, AlertTriangle } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtPct, fmtNum } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { SelectFilter } from "@/components/filters/SelectFilter";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { ExportMenu } from "@/components/export/ExportMenu";

type Summary = {
  revenue: number; // cents
  cost: number; // cents
  gross_profit: number; // cents
  margin_pct: number;
};

type AgingBucket = { bucket: string; claimed: number; rx: number };
type Aging = { buckets: AgingBucket[]; total_claimed: number; overdue_claimed: number };

type ByRow = { label: string; gross_profit: number; margin_pct: number };
type LowMarginRow = {
  product_id: string;
  product_name: string;
  units: number;
  margin_pct: number;
  gross_profit: number; // cents
};

const DIMS = [
  { value: "fund", label: "Ταμείο" },
  { value: "doctor", label: "Ιατρός" },
  { value: "icd10", label: "ICD-10" },
  { value: "product", label: "Σκεύασμα" },
  { value: "category", label: "Κατηγορία" },
];

const lowMarginColumns: Column<LowMarginRow>[] = [
  { key: "product_name", header: "Σκεύασμα" },
  { key: "units", header: "Τεμάχια", align: "right", render: (r) => fmtNum(r.units) },
  { key: "margin_pct", header: "Περιθώριο", align: "right", render: (r) => fmtPct(r.margin_pct) },
  { key: "gross_profit", header: "Κέρδος", align: "right", render: (r) => fmtEur(r.gross_profit) },
];

export default function ProfitabilityPage() {
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const [dim, setDim] = useState("fund");

  const summary = useQuery({
    queryKey: ["profitability", "summary", q],
    queryFn: () => api<Summary>(`/profitability/summary?${q}`),
  });

  const byDim = useQuery({
    queryKey: ["profitability", "by", dim, q],
    queryFn: () => api<{ rows: ByRow[] }>(`/profitability/by?dim=${dim}&${q}`),
  });

  const lowMargin = useQuery({
    queryKey: ["profitability", "low-margin", 10],
    queryFn: () => api<{ items: LowMarginRow[] }>(`/profitability/low-margin?threshold_pct=10`),
  });

  const aging = useQuery({
    queryKey: ["profitability", "aging"],
    queryFn: () => api<Aging>(`/profitability/aging`),
  });

  const s = summary.data;
  const rows = byDim.data?.rows ?? [];
  const ag = aging.data;
  const lowItems = lowMargin.data?.items ?? [];

  return (
    <ModuleGuard module="profitability">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Κερδοφορία</h1>
          <p className="mt-1 text-sm text-slate-500">Μεικτό κέρδος, περιθώρια & ταμειακή ροή</p>
        </div>
        <ExportMenu filename={`kerdoforia-${dim}`} title="Κερδοφορία ανά διάσταση" rows={byDim.data?.rows ?? []} columns={[
          { key: "label", header: "Διάσταση" },
          { key: "gross_profit", header: "Μεικτό κέρδος (€)", value: (r) => ((r.gross_profit || 0) / 100).toFixed(2) },
          { key: "margin_pct", header: "Περιθώριο %", value: (r) => (r.margin_pct ?? 0).toFixed(1) },
        ]} />
      </div>

      <div className="mb-4"><DateRangeFilter /></div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label="Μεικτό κέρδος" value={s ? fmtEur(s.gross_profit) : "—"} sub="αιτούμενα − κόστος" icon={TrendingUp} accent="green" />
          <KpiCard label="Περιθώριο" value={s ? fmtPct(s.margin_pct) : "—"} sub="μεικτό περιθώριο" icon={Percent} accent="violet" />
          <KpiCard label="Έσοδα" value={s ? fmtEur(s.revenue) : "—"} sub="σύνολο περιόδου" icon={Coins} accent="amber" />
          <KpiCard
            label="Είδη χαμηλής κερδοφορίας"
            value={fmtNum(lowItems.length)}
            sub="περιθώριο < 10%"
            icon={AlertTriangle}
            accent="rose"
          />
        </div>

        {/* by-dimension chart */}
        <PanelCard
          title="Μεικτό κέρδος ανά διάσταση"
          action={
            <div className="w-44">
              <SelectFilter
                label=""
                value={dim}
                options={DIMS}
                onChange={(v) => setDim(v ?? "fund")}
                allLabel="Ταμείο"
              />
            </div>
          }
        >
          <BarChart
            labels={rows.map((r) => r.label)}
            data={rows.map((r) => Math.round(r.gross_profit / 100))}
            name="Κέρδος"
            horizontal
            height={Math.max(220, rows.length * 36)}
          />
        </PanelCard>

        {/* aging chart */}
        <PanelCard
          title="Ταμειακή ροή — αιτούμενα ανά ηλικία απαίτησης (ημέρες)"
          action={
            <div className="flex gap-4 text-sm">
              <span className="text-slate-500">
                Σύνολο: <b className="text-slate-800">{ag ? fmtEur(ag.total_claimed) : "—"}</b>
              </span>
              <span className="text-slate-500">
                Ληξιπρόθεσμα (&gt;60ημ): <b className="text-amber-600">{ag ? fmtEur(ag.overdue_claimed) : "—"}</b>
              </span>
            </div>
          }
        >
          <BarChart
            labels={(ag?.buckets ?? []).map((b) => b.bucket)}
            data={(ag?.buckets ?? []).map((b) => Math.round(b.claimed / 100))}
            name="Αιτούμενα €"
            height={280}
          />
        </PanelCard>

        {/* low-margin table */}
        <PanelCard title="Είδη χαμηλής κερδοφορίας (< 10%)" bodyClassName="pt-2">
          <QueryState
            isLoading={lowMargin.isLoading}
            isError={lowMargin.isError}
            isEmpty={lowItems.length === 0}
            onRetry={() => lowMargin.refetch()}
          >
            <DataTable pageSize={20} columns={lowMarginColumns} rows={lowItems} rowKey={(r) => r.product_id} />
          </QueryState>
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
