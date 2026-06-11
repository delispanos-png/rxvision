"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Stethoscope, Receipt, Wallet, TrendingUp } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtEur, fmtNum, fmtMoney} from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { SelectFilter } from "@/components/filters/SelectFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { ExportMenu } from "@/components/export/ExportMenu";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { useT } from "@/store/prefStore";

type T = (el: string, en: string) => string;

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

const makeLevels = (t: T) => [
  { value: "1", label: t("Επίπεδο 1 — Κεφάλαιο (π.χ. E)", "Level 1 — Chapter (e.g. E)") },
  { value: "2", label: t("Επίπεδο 2 (π.χ. E1)", "Level 2 (e.g. E1)") },
  { value: "3", label: t("Επίπεδο 3 — Κατηγορία (π.χ. E11)", "Level 3 — Category (e.g. E11)") },
  { value: "4", label: t("Επίπεδο 4 (π.χ. E119)", "Level 4 (e.g. E119)") },
  { value: "5", label: t("Επίπεδο 5 — Πλήρης κωδικός", "Level 5 — Full code") },
];

const makeColumns = (t: T): Column<Node>[] => [
  { key: "node", header: t("Κόμβος ICD-10", "ICD-10 node") },
  { key: "title", header: t("Περιγραφή", "Description"), render: (r) => r.title || "—" },
  { key: "code_count", header: t("Κωδικοί", "Codes"), align: "right", hideOnMobile: true, render: (r) => fmtNum(r.code_count) },
  { key: "rx", header: t("Πλήθος", "Count"), align: "right", render: (r) => fmtNum(r.rx) },
  { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value) },
  { key: "claimed", header: t("Αιτούμενα", "Claimed"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.claimed) },
  { key: "profit", header: t("Κερδοφορία", "Profitability"), align: "right", render: (r) => fmtEur(r.profit) },
];

export default function Icd10Page() {
  const t = useT();
  const LEVELS = makeLevels(t);
  const columns = makeColumns(t);
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
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("ICD-10 — Ιεραρχία διαγνώσεων", "ICD-10 — Diagnosis hierarchy")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Ανάλυση συνταγών & αξίας ανά κόμβο διάγνωσης", "Prescription & value analysis by diagnosis node")}</p>
        </div>
        <ExportMenu filename="icd10" title={t("Ανάλυση ανά ICD-10", "Breakdown by ICD-10")} rows={rows} columns={[
          { key: "node", header: t("Κόμβος ICD-10", "ICD-10 node") },
          { key: "title", header: t("Περιγραφή", "Description"), value: (r) => r.title || "—" },
          { key: "code_count", header: t("Κωδικοί", "Codes") },
          { key: "rx", header: t("Πλήθος", "Count") },
          { key: "value", header: t("Αξία (€)", "Value (€)"), value: (r) => fmtMoney((r.value || 0)) },
          { key: "claimed", header: t("Αιτούμενα (€)", "Claimed (€)"), value: (r) => fmtMoney((r.claimed || 0)) },
          { key: "profit", header: t("Κερδοφορία (€)", "Profitability (€)"), value: (r) => fmtMoney((r.profit || 0)) },
        ]} />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <DateRangeFilter />
        <SelectFilter
          label={t("Επίπεδο ιεραρχίας", "Hierarchy level")}
          value={level}
          options={LEVELS}
          onChange={(v) => setLevel(v ?? "3")}
          allLabel={t("Επίπεδο 3 — Κατηγορία", "Level 3 — Category")}
        />
      </div>

      <QueryState isLoading={isLoading} isError={isError} onRetry={() => refetch()}>
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <KpiCard label={t("Διαγνώσεις (κόμβοι)", "Diagnoses (nodes)")} value={fmtNum(rows.length)} sub={t("στο τρέχον επίπεδο", "at the current level")} icon={Stethoscope} accent="indigo" />
            <KpiCard label={t("Σύνολο συνταγών", "Total prescriptions")} value={fmtNum(totalRx)} sub={t("πλήθος εκτελέσεων", "number of executions")} icon={Receipt} accent="violet" trend={hasPrev ? pctDelta(totalRx, pRx) : undefined} />
            <KpiCard label={t("Αξία", "Value")} value={fmtEur(totalValue)} sub={t("σύνολο περιόδου", "period total")} icon={Wallet} accent="amber" trend={hasPrev ? pctDelta(totalValue, pValue) : undefined} />
            <KpiCard label={t("Κερδοφορία", "Profitability")} value={fmtEur(totalProfit)} sub={t("μεικτό κέρδος", "gross profit")} icon={TrendingUp} accent="green" trend={hasPrev ? pctDelta(totalProfit, pProfit) : undefined} />
          </div>

          {/* top nodes chart */}
          {top.length > 0 && (
            <PanelCard title={t("Top 10 κόμβοι ανά αξία", "Top 10 nodes by value")}>
              <BarChart
                labels={top.map((r) => r.node)}
                data={top.map((r) => Math.round(r.value / 100))}
                name={t("Αξία", "Value")}
                horizontal
                height={Math.max(220, top.length * 38)}
              />
            </PanelCard>
          )}

          {/* table */}
          <PanelCard title={t("Αναλυτικά ανά κόμβο", "Details by node")} bodyClassName="pt-2">
            <DataTable pageSize={20} columns={columns} rows={rows} rowKey={(r) => r.node} />
          </PanelCard>
        </div>
      </QueryState>
    </ModuleGuard>
  );
}
