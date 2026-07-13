"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Percent, Coins, AlertTriangle, Layers } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtDec, fmtEur, fmtPct, fmtNum, fmtMoney} from "@/lib/formatters";
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
type CategoryRow = {
  label: string;
  units: number;
  value: number;        // cents — έσοδα (λιανική)
  gross_profit: number; // cents
  margin_pct: number;
};
type LowMarginRow = {
  product_id: string;
  product_name: string;
  units: number;
  margin_pct: number;
  gross_profit: number; // cents
  retail_price?: number;      // cents — λιανική/τεμάχιο
  wholesale_price?: number;   // cents — χονδρική/τεμάχιο
  wholesale_source?: string;  // real | masterdata | estimated | unavailable
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
    { key: "wholesale_price", header: t("Χονδρική", "Wholesale"), align: "right", render: (r) => r.wholesale_price ? `${fmtEur(r.wholesale_price)}${r.wholesale_source === "estimated" ? " ~" : ""}` : "—" },
    { key: "retail_price", header: t("Λιανική", "Retail"), align: "right", render: (r) => r.retail_price ? fmtEur(r.retail_price) : "—" },
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
    queryFn: () => api<Summary>(`/profitability/summary?${filtersToQuery({...filters, dateFrom: pr!.from, dateTo: pr!.to })}`),
    enabled: !!pr,
  });

  const byDim = useQuery({
    queryKey: ["profitability", "by", dim, q],
    queryFn: () => api<{ rows: ByRow[] }>(`/profitability/by?dim=${dim}&${q}`),
  });

  const byCategory = useQuery({
    queryKey: ["profitability", "by-category", q],
    queryFn: () => api<{ rows: CategoryRow[] }>(`/profitability/by-category?${q}`),
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
  const catRows = byCategory.data?.rows ?? [];
  const topCat = catRows[0];

  const categoryColumns: Column<CategoryRow>[] = [
    { key: "label", header: t("Κατηγορία", "Category") },
    { key: "units", header: t("Τεμάχια", "Units"), align: "right", render: (r) => fmtNum(r.units) },
    { key: "value", header: t("Έσοδα", "Revenue"), align: "right", render: (r) => fmtEur(r.value) },
    { key: "gross_profit", header: t("Κέρδος", "Profit"), align: "right", render: (r) => fmtEur(r.gross_profit) },
    { key: "margin_pct", header: t("Περιθώριο", "Margin"), align: "right", render: (r) => fmtPct(r.margin_pct) },
  ];

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
          { key: "margin_pct", header: t("Περιθώριο %", "Margin %"), value: (r) => fmtDec(r.margin_pct ?? 0, 1) },
        ]} />
      </div>

      <div className="mb-4"><DateRangeFilter /></div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <KpiCard label={t("Μεικτό κέρδος", "Gross profit")} help={t("Αιτούμενο/αξία − κόστος χονδρικής των φαρμάκων.", "Claimed/value − wholesale cost.")} value={s ? fmtEur(s.gross_profit) : "—"} sub={t("αιτούμενα − κόστος", "claimed − cost")} icon={TrendingUp} accent="green" trend={pctDelta(s?.gross_profit, p?.gross_profit)} />
          <KpiCard label={t("Περιθώριο", "Margin")} help={t("Περιθώριο κέρδους = μεικτό κέρδος / λιανική αξία.", "Margin = gross profit / retail value.")} value={s ? fmtPct(s.margin_pct) : "—"} sub={t("μεικτό περιθώριο", "gross margin")} icon={Percent} accent="violet" trend={pctDelta(s?.margin_pct, p?.margin_pct)} />
          <KpiCard label={t("Έσοδα", "Revenue")} help={t("Συνολικά έσοδα της περιόδου.", "Total revenue for the period.")} value={s ? fmtEur(s.revenue) : "—"} sub={t("σύνολο περιόδου", "period total")} icon={Coins} accent="amber" trend={pctDelta(s?.revenue, p?.revenue)} />
          <KpiCard
            label={t("Κορυφαία κατηγορία", "Top category")}
            help={t("Θεραπευτική κατηγορία (βάσει ATC) με το μεγαλύτερο μεικτό κέρδος στην περίοδο.", "Therapeutic category (by ATC) with the highest gross profit in the period.")}
            value={topCat ? fmtEur(topCat.gross_profit) : "—"}
            sub={topCat ? topCat.label : t("κέρδος ανά κατηγορία", "profit by category")}
            icon={Layers}
            accent="sky"
          />
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

        {/* profit by therapeutic category */}
        <PanelCard
          title={t("Κέρδος ανά κατηγορία", "Profit by category")}
          action={
            <div className="flex items-center gap-3">
              {topCat && (
                <span className="text-sm text-slate-500">
                  {t("Κορυφαία", "Top")}: <b className="text-slate-800 dark:text-slate-200">{topCat.label}</b> · <b className="text-emerald-600 dark:text-emerald-400">{fmtEur(topCat.gross_profit)}</b>
                </span>
              )}
              <ExportMenu filename="kerdos-ana-katigoria" title={t("Κέρδος ανά κατηγορία", "Profit by category")} rows={catRows} columns={[
                { key: "label", header: t("Κατηγορία", "Category") },
                { key: "units", header: t("Τεμάχια", "Units"), value: (r) => fmtNum(r.units) },
                { key: "value", header: t("Έσοδα (€)", "Revenue (€)"), value: (r) => fmtMoney(r.value || 0) },
                { key: "gross_profit", header: t("Κέρδος (€)", "Profit (€)"), value: (r) => fmtMoney(r.gross_profit || 0) },
                { key: "margin_pct", header: t("Περιθώριο %", "Margin %"), value: (r) => fmtDec(r.margin_pct ?? 0, 1) },
              ]} />
            </div>
          }
        >
          <QueryState
            isLoading={byCategory.isLoading}
            isError={byCategory.isError}
            isEmpty={catRows.length === 0}
            onRetry={() => byCategory.refetch()}
          >
            <BarChart
              labels={catRows.map((r) => r.label)}
              data={catRows.map((r) => Math.round(r.gross_profit / 100))}
              name={t("Κέρδος", "Profit")}
              horizontal
              height={Math.max(240, catRows.length * 34)}
            />
            <div className="mt-4">
              <DataTable pageSize={20} columns={categoryColumns} rows={catRows} rowKey={(r) => r.label} />
            </div>
          </QueryState>
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
