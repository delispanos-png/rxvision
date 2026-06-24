"use client";

import { appAlert } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Lock, Receipt, Wallet } from "lucide-react";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { BarChart } from "@/components/charts/BarChart";

type ControlItem = { key: string; label: string; ok: boolean; detail?: string };
type Control = { period: string; locked: boolean; checks: ControlItem[] };

type Discrepancy = { id: string; type: string; description: string; amount: number };
type FundTotal = { fund_name: string; rx_count: number; value: number; claimed: number };

const CURRENT_PERIOD = new Date().toISOString().slice(0, 7);

type T = (el: string, en: string) => string;
const makeDiscrepancyColumns = (t: T): Column<Discrepancy>[] => [
  { key: "type", header: t("Τύπος", "Type") },
  { key: "description", header: t("Περιγραφή", "Description") },
  { key: "amount", header: t("Ποσό", "Amount"), align: "right", render: (r) => fmtEur(r.amount) },
];

const makeFundColumns = (t: T): Column<FundTotal>[] => [
  { key: "fund_name", header: t("Ταμείο", "Insurance fund") },
  { key: "rx_count", header: t("Συνταγές", "Prescriptions"), align: "right", render: (r) => fmtNum(r.rx_count) },
  { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value) },
  { key: "claimed", header: t("Αιτούμενα", "Claimed"), align: "right", render: (r) => fmtEur(r.claimed) },
];

export default function ClosingPage() {
  const t = useT();
  const discrepancyColumns = makeDiscrepancyColumns(t);
  const fundColumns = makeFundColumns(t);
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
    onError: (e) => appAlert(e instanceof ApiError ? t(`Αποτυχία κλειδώματος (${e.status})`, `Lock failed (${e.status})`) : t("Αποτυχία κλειδώματος", "Lock failed")),
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
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Κλείσιμο μήνα", "Month closing")} — {period}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Έλεγχος, ασυμφωνίες και συγκεντρωτικά ανά ταμείο", "Control, discrepancies and totals per fund")}</p>
        </div>
        <button
          type="button"
          onClick={() => lock.mutate()}
          disabled={locked || !allOk || lock.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Lock className="h-4 w-4" />
          {locked ? t("Κλειδωμένο", "Locked") : lock.isPending ? t("Κλείδωμα…", "Locking…") : t("Κλείδωμα περιόδου", "Lock period")}
        </button>
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label={t("Συνταγές", "Prescriptions")} help={t("Πλήθος εκτελέσεων συνταγών στην περίοδο.", "Number of executions in the period.")} value={fmtNum(totalRx)} sub={t("περιόδου", "for period")} icon={Receipt} accent="indigo" />
          <KpiCard label={t("Σύνολο ταμείων", "Funds total")} help={t("Πλήθος διακριτών ταμείων.", "Number of distinct funds.")} value={fmtEur(totalClaimed)} sub={t("αιτούμενα", "claimed")} icon={Wallet} accent="amber" />
          <KpiCard label={t("Ασυμφωνίες", "Discrepancies")} help={t("Συνταγές με ασυμφωνία ποσών (ταμείο+συμμετοχή ≠ λιανική).", "Prescriptions with amount mismatch.")} value={fmtNum(discrItems.length)} sub={t("ελλείψεις", "missing")} icon={AlertTriangle} accent={discrItems.length ? "rose" : "green"} />
          <KpiCard label={t("Κατάσταση", "Status")} help={t("Κατάσταση συνδρομής (active/trial κ.λπ.).", "Subscription status.")} value={locked ? t("Κλειδωμένο", "Locked") : allOk ? t("Έτοιμο", "Ready") : t("Σε έλεγχο", "In review")} sub={t(`${checks.filter((c) => c.ok).length}/${checks.length} έλεγχοι ΟΚ`, `${checks.filter((c) => c.ok).length}/${checks.length} checks OK`)} icon={Lock} accent={locked ? "green" : "violet"} />
        </div>

        {/* checklist */}
        <PanelCard title={t("Λίστα ελέγχου", "Checklist")} bodyClassName="space-y-2">
          <QueryState isLoading={control.isLoading} isError={control.isError} onRetry={() => control.refetch()}>
            {checks.map((c) => (
              <div
                key={c.key}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"
              >
                <span className="text-slate-700">{c.label}</span>
                <span className={c.ok ? "font-medium text-emerald-600" : "font-medium text-rose-600"}>
                  {c.ok ? t("✓ ΟΚ", "✓ OK") : `✗ ${c.detail ?? t("Πρόβλημα", "Problem")}`}
                </span>
              </div>
            ))}
          </QueryState>
        </PanelCard>

        {/* fund totals chart */}
        {top.length > 0 && (
          <PanelCard title={t("Αιτούμενα ανά ταμείο", "Claimed per fund")}>
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
        <PanelCard title={t("Ασυμφωνίες / ελλείψεις", "Discrepancies / missing")} bodyClassName="pt-2">
          <DataTable pageSize={20}
            columns={discrepancyColumns}
            rows={discrItems}
            rowKey={(r) => r.id}
            empty={t("Δεν εντοπίστηκαν ασυμφωνίες.", "No discrepancies found.")}
          />
        </PanelCard>

        {/* fund totals table */}
        <PanelCard title={t("Συγκεντρωτικά ανά ταμείο", "Totals per fund")} bodyClassName="pt-2">
          <DataTable pageSize={20} columns={fundColumns} rows={funds} rowKey={(r) => r.fund_name} />
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
