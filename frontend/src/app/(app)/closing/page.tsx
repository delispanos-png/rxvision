"use client";

import { appAlert } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Lock, Receipt, Wallet } from "lucide-react";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { BarChart } from "@/components/charts/BarChart";

type ControlItem = { key: string; label: string; ok: boolean; detail?: string };
type Control = { period: string; locked: boolean; checks: ControlItem[] };

type Discrepancy = { id: string; type: string; description: string; amount: number };
type FundTotal = { fund_name: string; rx_count: number; value: number; claimed: number };

const CURRENT_PERIOD = new Date().toISOString().slice(0, 7);

const discrepancyColumns: Column<Discrepancy>[] = [
  { key: "type", header: "Τύπος" },
  { key: "description", header: "Περιγραφή" },
  { key: "amount", header: "Ποσό", align: "right", render: (r) => fmtEur(r.amount) },
];

const fundColumns: Column<FundTotal>[] = [
  { key: "fund_name", header: "Ταμείο" },
  { key: "rx_count", header: "Συνταγές", align: "right", render: (r) => fmtNum(r.rx_count) },
  { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value) },
  { key: "claimed", header: "Αιτούμενα", align: "right", render: (r) => fmtEur(r.claimed) },
];

export default function ClosingPage() {
  const [period] = useState(CURRENT_PERIOD);
  const qc = useQueryClient();

  const control = useQuery({
    queryKey: queryKeys.closingControl(period),
    queryFn: () => api<Control>(`/closing/${period}/control`),
  });
  const discrepancies = useQuery({
    queryKey: queryKeys.closingDiscrepancies(period),
    queryFn: () => api<{ items: Discrepancy[] }>(`/closing/${period}/discrepancies`),
  });
  const fundTotals = useQuery({
    queryKey: queryKeys.closingFundTotals(period),
    queryFn: () => api<{ rows: FundTotal[] }>(`/closing/${period}/fund-totals`),
  });

  const lock = useMutation({
    mutationFn: () => api<{ locked: boolean }>(`/closing/${period}/lock`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.closingControl(period) }),
    onError: (e) => appAlert(e instanceof ApiError ? `Αποτυχία κλειδώματος (${e.status})` : "Αποτυχία κλειδώματος"),
  });

  const checks = control.data?.checks ?? [];
  const locked = control.data?.locked ?? false;
  const allOk = checks.length > 0 && checks.every((c) => c.ok);

  const funds = fundTotals.data?.rows ?? [];
  const discrItems = discrepancies.data?.items ?? [];
  const totalRx = funds.reduce((s, f) => s + (f.rx_count || 0), 0);
  const totalClaimed = funds.reduce((s, f) => s + (f.claimed || 0), 0);
  const top = [...funds].sort((a, b) => b.claimed - a.claimed).slice(0, 10);

  return (
    <ModuleGuard module="monthly_closing">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Κλείσιμο μήνα — {period}</h1>
          <p className="mt-1 text-sm text-slate-500">Έλεγχος, ασυμφωνίες και συγκεντρωτικά ανά ταμείο</p>
        </div>
        <button
          type="button"
          onClick={() => lock.mutate()}
          disabled={locked || !allOk || lock.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Lock className="h-4 w-4" />
          {locked ? "Κλειδωμένο" : lock.isPending ? "Κλείδωμα…" : "Κλείδωμα περιόδου"}
        </button>
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Συνταγές" value={fmtNum(totalRx)} sub="περιόδου" icon={Receipt} accent="indigo" />
          <KpiCard label="Σύνολο ταμείων" value={fmtEur(totalClaimed)} sub="αιτούμενα" icon={Wallet} accent="amber" />
          <KpiCard label="Ασυμφωνίες" value={fmtNum(discrItems.length)} sub="ελλείψεις" icon={AlertTriangle} accent={discrItems.length ? "rose" : "green"} />
          <KpiCard label="Κατάσταση" value={locked ? "Κλειδωμένο" : allOk ? "Έτοιμο" : "Σε έλεγχο"} sub={`${checks.filter((c) => c.ok).length}/${checks.length} έλεγχοι ΟΚ`} icon={Lock} accent={locked ? "green" : "violet"} />
        </div>

        {/* checklist */}
        <PanelCard title="Λίστα ελέγχου" bodyClassName="space-y-2">
          {control.isLoading ? (
            <div className="text-slate-400">Φόρτωση δεδομένων…</div>
          ) : (
            checks.map((c) => (
              <div
                key={c.key}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"
              >
                <span className="text-slate-700">{c.label}</span>
                <span className={c.ok ? "font-medium text-emerald-600" : "font-medium text-rose-600"}>
                  {c.ok ? "✓ ΟΚ" : `✗ ${c.detail ?? "Πρόβλημα"}`}
                </span>
              </div>
            ))
          )}
        </PanelCard>

        {/* fund totals chart */}
        {top.length > 0 && (
          <PanelCard title="Αιτούμενα ανά ταμείο">
            <BarChart
              horizontal
              height={Math.max(220, top.length * 38)}
              labels={top.map((f) => f.fund_name)}
              data={top.map((f) => Math.round((f.claimed || 0) / 100))}
              name="€"
            />
          </PanelCard>
        )}

        {/* discrepancies */}
        <PanelCard title="Ασυμφωνίες / ελλείψεις" bodyClassName="pt-2">
          <DataTable
            columns={discrepancyColumns}
            rows={discrItems}
            rowKey={(r) => r.id}
            empty="Δεν εντοπίστηκαν ασυμφωνίες."
          />
        </PanelCard>

        {/* fund totals table */}
        <PanelCard title="Συγκεντρωτικά ανά ταμείο" bodyClassName="pt-2">
          <DataTable columns={fundColumns} rows={funds} rowKey={(r) => r.fund_name} />
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
