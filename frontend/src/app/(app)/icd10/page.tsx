"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Stethoscope, Receipt, Wallet, TrendingUp } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { SelectFilter } from "@/components/filters/SelectFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { ExportMenu } from "@/components/export/ExportMenu";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";

type Node = {
  node: string;
  title?: string | null;
  rx: number;
  value: number; // cents
  claimed: number; // cents
  profit: number; // cents
  code_count: number;
  codes: string[];
};

const LEVELS = [
  { value: "1", label: "Επίπεδο 1 — Κεφάλαιο (π.χ. E)" },
  { value: "2", label: "Επίπεδο 2 (π.χ. E1)" },
  { value: "3", label: "Επίπεδο 3 — Κατηγορία (π.χ. E11)" },
  { value: "4", label: "Επίπεδο 4 (π.χ. E119)" },
  { value: "5", label: "Επίπεδο 5 — Πλήρης κωδικός" },
];

const columns: Column<Node>[] = [
  { key: "node", header: "Κόμβος ICD-10" },
  { key: "title", header: "Περιγραφή", render: (r) => r.title || "—" },
  { key: "code_count", header: "Κωδικοί", align: "right", hideOnMobile: true, render: (r) => fmtNum(r.code_count) },
  { key: "rx", header: "Πλήθος", align: "right", render: (r) => fmtNum(r.rx) },
  { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value) },
  { key: "claimed", header: "Αιτούμενα", align: "right", hideOnMobile: true, render: (r) => fmtEur(r.claimed) },
  { key: "profit", header: "Κερδοφορία", align: "right", render: (r) => fmtEur(r.profit) },
];

export default function Icd10Page() {
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const [level, setLevel] = useState("3");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["icd10", "hierarchy", level, q],
    queryFn: () => api<{ items: Node[] }>(`/icd10/hierarchy?level=${level}&metric=value&${q}`),
  });
  const pr = prevYearRange(filters.dateFrom, filters.dateTo);
  const prevIcd = useQuery({
    queryKey: ["icd10", "hierarchy", "prevYear", level, pr?.from, pr?.to],
    queryFn: () => api<{ items: Node[] }>(`/icd10/hierarchy?level=${level}&metric=value&${filtersToQuery({ ...filters, dateFrom: pr!.from, dateTo: pr!.to })}`),
    enabled: !!pr,
  });

  const rows = data?.items ?? [];
  const top = rows.slice(0, 10);

  const totalRx = rows.reduce((a, r) => a + (r.rx || 0), 0);
  const totalValue = rows.reduce((a, r) => a + (r.value || 0), 0);
  const totalProfit = rows.reduce((a, r) => a + (r.profit || 0), 0);
  const prows = prevIcd.data?.items ?? [];
  const pRx = prows.reduce((a, r) => a + (r.rx || 0), 0), pValue = prows.reduce((a, r) => a + (r.value || 0), 0);
  const pProfit = prows.reduce((a, r) => a + (r.profit || 0), 0);
  const hasPrev = !!prevIcd.data;

  return (
    <ModuleGuard module="icd10_analytics">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">ICD-10 — Ιεραρχία διαγνώσεων</h1>
          <p className="mt-1 text-sm text-slate-500">Ανάλυση συνταγών & αξίας ανά κόμβο διάγνωσης</p>
        </div>
        <ExportMenu filename="icd10" title="Ανάλυση ανά ICD-10" rows={rows} columns={[
          { key: "node", header: "Κόμβος ICD-10" },
          { key: "title", header: "Περιγραφή", value: (r) => r.title || "—" },
          { key: "code_count", header: "Κωδικοί" },
          { key: "rx", header: "Πλήθος" },
          { key: "value", header: "Αξία (€)", value: (r) => ((r.value || 0) / 100).toFixed(2) },
          { key: "claimed", header: "Αιτούμενα (€)", value: (r) => ((r.claimed || 0) / 100).toFixed(2) },
          { key: "profit", header: "Κερδοφορία (€)", value: (r) => ((r.profit || 0) / 100).toFixed(2) },
        ]} />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <DateRangeFilter />
        <SelectFilter
          label="Επίπεδο ιεραρχίας"
          value={level}
          options={LEVELS}
          onChange={(v) => setLevel(v ?? "3")}
          allLabel="Επίπεδο 3 — Κατηγορία"
        />
      </div>

      <QueryState isLoading={isLoading} isError={isError} onRetry={() => refetch()}>
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <KpiCard label="Διαγνώσεις (κόμβοι)" value={fmtNum(rows.length)} sub="στο τρέχον επίπεδο" icon={Stethoscope} accent="indigo" />
            <KpiCard label="Σύνολο συνταγών" value={fmtNum(totalRx)} sub="πλήθος εκτελέσεων" icon={Receipt} accent="violet" trend={hasPrev ? pctDelta(totalRx, pRx) : undefined} />
            <KpiCard label="Αξία" value={fmtEur(totalValue)} sub="σύνολο περιόδου" icon={Wallet} accent="amber" trend={hasPrev ? pctDelta(totalValue, pValue) : undefined} />
            <KpiCard label="Κερδοφορία" value={fmtEur(totalProfit)} sub="μεικτό κέρδος" icon={TrendingUp} accent="green" trend={hasPrev ? pctDelta(totalProfit, pProfit) : undefined} />
          </div>

          {/* top nodes chart */}
          {top.length > 0 && (
            <PanelCard title="Top 10 κόμβοι ανά αξία">
              <BarChart
                labels={top.map((r) => r.node)}
                data={top.map((r) => Math.round(r.value / 100))}
                name="Αξία"
                horizontal
                height={Math.max(220, top.length * 38)}
              />
            </PanelCard>
          )}

          {/* table */}
          <PanelCard title="Αναλυτικά ανά κόμβο" bodyClassName="pt-2">
            <DataTable pageSize={20} columns={columns} rows={rows} rowKey={(r) => r.node} />
          </PanelCard>
        </div>
      </QueryState>
    </ModuleGuard>
  );
}
