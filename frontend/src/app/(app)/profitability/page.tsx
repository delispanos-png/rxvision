"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Percent, Coins, AlertTriangle } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtEur, fmtPct, fmtNum, fmtMoney} from "@/lib/formatters";
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

export default function ProfitabilityPage() {
  const t = useT();
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const [dim, setDim] = useState("fund");

  const DIMS = [
    { value: "fund", label: t("Ταμείο", "Insurance fund") },
    { value: "doctor", label: t("Ιατρός", "Doctor") },
    { value: "icd10", label: "ICD-10" },
    { value: "product", label: t("Σκεύασμα", "Product") },
    { value: "category", label: t("Κατηγορία", "Category") },
  ];

  const lowMarginColumns: Column<LowMarginRow>[] = [
    { key: "product_name", header: t("Σκεύασμα", "Product") },
    { key: "units", header: t("Τεμάχια", "Units"), align: "right", render: (r) => fmtNum(r.units) },
    { key: "margin_pct", header: t("Περιθώριο", "Margin"), align: "right", render: (r) => fmtPct(r.margin_pct) },
    { key: "gross_profit", header: t("Κέρδος", "Profit"), align: "right", render: (r) => fmtEur(r.gross_profit) },
  ];

  const summary = useQuery({
    queryKey: ["profitability", "summary", q],
    queryFn: () => api<Summary>(`/profitability/summary?${q}`),
  });
  const pr = prevYearRange(filters.dateFrom, filters.dateTo);
  const prevSummary = useQuery({
    queryKey: ["profitability", "summary", "prevYear", pr?.from, pr?.to],
    queryFn: () => api<Summary>(`/profitability/summary?${filtersToQuery({ ...filters, dateFrom: pr!.from, dateTo: pr!.to })}`),
    enabled: !!pr,
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
  const p = prevSummary.data;
  const rows = byDim.data?.rows ?? [];
  const ag = aging.data;
  const lowItems = lowMargin.data?.items ?? [];

  return (
    <ModuleGuard module="profitability">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Κερδοφορία", "Profitability")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Μεικτό κέρδος, περιθώρια & ταμειακή ροή", "Gross profit, margins & cash flow")}</p>
        </div>
        <ExportMenu filename={`kerdoforia-${dim}`} title={t("Κερδοφορία ανά διάσταση", "Profitability by dimension")} rows={byDim.data?.rows ?? []} columns={[
          { key: "label", header: t("Διάσταση", "Dimension") },
          { key: "gross_profit", header: t("Μεικτό κέρδος (€)", "Gross profit (€)"), value: (r) => fmtMoney((r.gross_profit || 0)) },
          { key: "margin_pct", header: t("Περιθώριο %", "Margin %"), value: (r) => (r.margin_pct ?? 0).toFixed(1) },
        ]} />
      </div>

      <div className="mb-4"><DateRangeFilter /></div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label={t("Μεικτό κέρδος", "Gross profit")} value={s ? fmtEur(s.gross_profit) : "—"} sub={t("αιτούμενα − κόστος", "claimed − cost")} icon={TrendingUp} accent="green" trend={pctDelta(s?.gross_profit, p?.gross_profit)} />
          <KpiCard label={t("Περιθώριο", "Margin")} value={s ? fmtPct(s.margin_pct) : "—"} sub={t("μεικτό περιθώριο", "gross margin")} icon={Percent} accent="violet" trend={pctDelta(s?.margin_pct, p?.margin_pct)} />
          <KpiCard label={t("Έσοδα", "Revenue")} value={s ? fmtEur(s.revenue) : "—"} sub={t("σύνολο περιόδου", "period total")} icon={Coins} accent="amber" trend={pctDelta(s?.revenue, p?.revenue)} />
          <KpiCard
            label={t("Είδη χαμηλής κερδοφορίας", "Low-margin items")}
            value={fmtNum(lowItems.length)}
            sub={t("περιθώριο < 10%", "margin < 10%")}
            icon={AlertTriangle}
            accent="rose"
          />
        </div>

        {/* by-dimension chart */}
        <PanelCard
          title={t("Μεικτό κέρδος ανά διάσταση", "Gross profit by dimension")}
          action={
            <div className="w-44">
              <SelectFilter
                label=""
                value={dim}
                options={DIMS}
                onChange={(v) => setDim(v ?? "fund")}
                allLabel={t("Ταμείο", "Insurance fund")}
              />
            </div>
          }
        >
          <BarChart
            labels={rows.map((r) => r.label)}
            data={rows.map((r) => Math.round(r.gross_profit / 100))}
            name={t("Κέρδος", "Profit")}
            horizontal
            height={Math.max(220, rows.length * 36)}
          />
        </PanelCard>

        {/* aging chart */}
        <PanelCard
          title={t("Ταμειακή ροή — αιτούμενα ανά ηλικία απαίτησης (ημέρες)", "Cash flow — claimed by claim age (days)")}
          action={
            <div className="flex gap-4 text-sm">
              <span className="text-slate-500">
                {t("Σύνολο", "Total")}: <b className="text-slate-800">{ag ? fmtEur(ag.total_claimed) : "—"}</b>
              </span>
              <span className="text-slate-500">
                {t("Ληξιπρόθεσμα (>60ημ)", "Overdue (>60d)")}: <b className="text-amber-600">{ag ? fmtEur(ag.overdue_claimed) : "—"}</b>
              </span>
            </div>
          }
        >
          <BarChart
            labels={(ag?.buckets ?? []).map((b) => b.bucket)}
            data={(ag?.buckets ?? []).map((b) => Math.round(b.claimed / 100))}
            name={t("Αιτούμενα €", "Claimed €")}
            height={280}
          />
        </PanelCard>

        {/* low-margin table */}
        <PanelCard title={t("Είδη χαμηλής κερδοφορίας (< 10%)", "Low-margin items (< 10%)")} bodyClassName="pt-2">
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
