"use client";

import { useQuery } from "@tanstack/react-query";
import { Receipt, Wallet, Pill, AlertTriangle } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { ExportButton } from "@/components/export/ExportButton";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";

type Prescription = {
  external_id: string;
  executed_at: string;
  source: string;
  icd10: string[];
  amount_total: number; // cents
  amount_claimed: number; // cents
  has_unexecuted_substances: boolean;
};

type UnexecutedRow = {
  product_id: string;
  name: string;
  category: string;
  occurrences: number;
  qty: number;
  lost_value: number; // cents
};

const columns: Column<Prescription>[] = [
  { key: "executed_at", header: "Ημ/νία", render: (r) => fmtDate(r.executed_at) },
  { key: "external_id", header: "Κωδικός" },
  { key: "source", header: "Πηγή" },
  { key: "icd10", header: "ICD-10", hideOnMobile: true, render: (r) => (r.icd10 ?? []).join(", ") },
  { key: "amount_total", header: "Αξία", align: "right", render: (r) => fmtEur(r.amount_total) },
  { key: "amount_claimed", header: "Αιτούμενα", align: "right", render: (r) => fmtEur(r.amount_claimed) },
  {
    key: "has_unexecuted_substances",
    header: "Ανεκτέλεστα",
    align: "center",
    render: (r) =>
      r.has_unexecuted_substances ? <span className="text-amber-600">●</span> : <span className="text-slate-300">—</span>,
  },
];

const unexecutedColumns: Column<UnexecutedRow>[] = [
  { key: "name", header: "Σκεύασμα", render: (r) => r.name ?? r.product_id },
  { key: "category", header: "Κατηγορία", hideOnMobile: true },
  { key: "occurrences", header: "Φορές", align: "right", render: (r) => fmtNum(r.occurrences) },
  { key: "lost_value", header: "Χαμένη αξία", align: "right", render: (r) => fmtEur(r.lost_value) },
];

export default function PrescriptionsPage() {
  const filters = useUiStore();
  const q = filtersToQuery(filters);

  const list = useQuery({
    queryKey: ["prescriptions", "list", q],
    queryFn: () => api<{ items: Prescription[] }>(`/prescriptions?${q}&page=1&page_size=50`),
  });

  const unexecuted = useQuery({
    queryKey: ["prescriptions", "unexecuted", q],
    queryFn: () =>
      api<{ items: UnexecutedRow[]; total_occurrences: number; total_lost_value: number }>(
        `/prescriptions/unexecuted?${q}`,
      ),
  });

  const items = list.data?.items ?? [];
  const un = unexecuted.data;
  const unRows = un?.items ?? [];

  const totalValue = items.reduce((a, r) => a + (r.amount_total || 0), 0);
  const totalClaimed = items.reduce((a, r) => a + (r.amount_claimed || 0), 0);
  const unexecutedCount = items.filter((r) => r.has_unexecuted_substances).length;

  return (
    <ModuleGuard module="prescription_analytics">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Συνταγές</h1>
          <p className="mt-1 text-sm text-slate-500">Εκτελέσεις & ανεκτέλεστες δραστικές της περιόδου</p>
        </div>
        <ExportButton path="/prescriptions" query={`?${q}`} />
      </div>

      <div className="mb-4">
        <DateRangeFilter />
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Συνταγές" value={fmtNum(items.length)} sub="πρόσφατες εκτελέσεις" icon={Receipt} accent="indigo" />
          <KpiCard label="Αξία συνταγών" value={fmtEur(totalValue)} sub="σύνολο περιόδου" icon={Wallet} accent="violet" />
          <KpiCard label="Αιτούμενα ταμείων" value={fmtEur(totalClaimed)} sub="προς ασφ. φορείς" icon={Pill} accent="amber" />
          <KpiCard
            label="Με ανεκτέλεστα"
            value={fmtNum(unexecutedCount)}
            sub={`χαμένη αξία ${fmtEur(un?.total_lost_value ?? 0)}`}
            icon={AlertTriangle}
            accent="rose"
          />
        </div>

        {/* unexecuted chart */}
        {unRows.length > 0 && (
          <PanelCard
            title="Ανεκτέλεστες δραστικές"
            action={
              <div className="flex gap-4 text-sm">
                <span className="text-slate-500">
                  Σύνολο: <b className="text-slate-800">{fmtNum(un?.total_occurrences ?? 0)}</b>
                </span>
                <span className="text-slate-500">
                  Χαμένη αξία: <b className="text-amber-600">{fmtEur(un?.total_lost_value ?? 0)}</b>
                </span>
              </div>
            }
          >
            <BarChart
              labels={unRows.slice(0, 10).map((r) => r.name ?? r.product_id)}
              data={unRows.slice(0, 10).map((r) => r.occurrences)}
              name="Φορές"
              horizontal
              height={Math.max(220, unRows.slice(0, 10).length * 38)}
            />
          </PanelCard>
        )}

        {/* unexecuted table */}
        <PanelCard title="Ανεκτέλεστες δραστικές — αναλυτικά" bodyClassName="pt-2">
          <DataTable
            columns={unexecutedColumns}
            rows={unRows}
            rowKey={(r) => r.product_id}
            empty="Καμία ανεκτέλεστη δραστική στην περίοδο."
          />
        </PanelCard>

        {/* recent prescriptions table */}
        <PanelCard title="Πρόσφατες εκτελέσεις" bodyClassName="pt-2">
          {list.isLoading ? (
            <div className="text-slate-400">Φόρτωση δεδομένων…</div>
          ) : (
            <DataTable columns={columns} rows={items} rowKey={(r) => r.external_id} />
          )}
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
