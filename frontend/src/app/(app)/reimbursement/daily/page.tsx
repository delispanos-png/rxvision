"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Receipt, FileStack, Landmark, Coins } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Day = { date: string; rx: number; executions: number; claim: number; retail: number; patient: number };
type Daily = { period: string; days: Day[]; totals: { rx: number; executions: number; claim: number; retail: number; patient: number; days: number } };

export default function DailyReconciliationPage() {
  const t = useT();
  const { period } = useReimbPeriod();
  const { data, isLoading } = useQuery({ queryKey: ["reimb-daily", period], queryFn: () => api<Daily>(`/reimbursement/daily?period=${period}`) });
  const tot = data?.totals;

  const cols: Column<Day>[] = [
    { key: "date", header: t("Ημέρα", "Day"), render: (r) => <span className="font-medium">{r.date}</span> },
    { key: "rx", header: t("Συνταγές", "Rx"), align: "right", sortValue: (r) => r.rx, render: (r) => fmtNum(r.rx) },
    { key: "executions", header: t("Εκτελέσεις", "Executions"), align: "right", sortValue: (r) => r.executions, render: (r) => fmtNum(r.executions) },
    { key: "retail", header: t("Λιανική", "Retail"), align: "right", hideOnMobile: true, sortValue: (r) => r.retail, render: (r) => fmtEur(r.retail) },
    { key: "patient", header: t("Συμμετοχή", "Patient"), align: "right", hideOnMobile: true, sortValue: (r) => r.patient, render: (r) => fmtEur(r.patient) },
    { key: "claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => <b>{fmtEur(r.claim)}</b> },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">{t("Πλήθος εκτελέσεων & αιτούμενα ποσά ανά ημέρα και σύνολο μήνα — για αντιπαραβολή με το πρόγραμμα του φαρμακείου.", "Execution counts & claimed amounts per day and month total — to cross-check against the pharmacy's own program.")}</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label={t("Ημέρες", "Days")} value={fmtNum(tot?.days ?? 0)} icon={CalendarDays} accent="indigo" />
        <KpiCard label={t("Συνταγές", "Prescriptions")} value={fmtNum(tot?.rx ?? 0)} icon={Receipt} accent="violet" />
        <KpiCard label={t("Εκτελέσεις", "Executions")} value={fmtNum(tot?.executions ?? 0)} icon={FileStack} accent="sky" />
        <KpiCard label={t("Συνολική απαίτηση", "Total claim")} value={fmtEur(tot?.claim ?? 0)} icon={Landmark} accent="green" />
        <KpiCard label={t("Συμμετοχή ασφ/νων", "Patient share")} value={fmtEur(tot?.patient ?? 0)} icon={Coins} accent="amber" />
      </div>

      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Ανάλυση ανά ημέρα", "Per-day breakdown")}</h3>
      {isLoading ? <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
        <DataTable pageSize={40} columns={cols} rows={data?.days ?? []} rowKey={(r) => r.date} empty={t("Καμία εκτέλεση τον μήνα.", "No executions this month.")} />
      )}
    </div>
  );
}
