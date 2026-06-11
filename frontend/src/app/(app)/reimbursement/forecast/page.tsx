"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, TrendingUp } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Row = { fund: string; is_eopyy: boolean; expected_monthly: number };
type FC = { months_used: string[]; by_fund: Row[]; expected_total: number };

export default function ForecastPage() {
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: ["reimb-forecast"], queryFn: () => api<FC>("/reimbursement/forecast") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Υπολογισμός πρόβλεψης…", "Forecasting…")}</div>;

  const cols: Column<Row>[] = [
    { key: "fund", header: t("Ταμείο", "Fund"), render: (r) => <span className="inline-flex items-center gap-1.5">{r.is_eopyy && <Building2 className="h-3.5 w-3.5 text-emerald-600" />}{r.fund}</span> },
    { key: "expected_monthly", header: t("Αναμενόμενη μηνιαία είσπραξη", "Expected monthly receipt"), align: "right", sortValue: (r) => r.expected_monthly, render: (r) => <b className="text-emerald-700 dark:text-emerald-400">{fmtEur(r.expected_monthly)}</b> },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KpiCard label={t("Αναμενόμενη μηνιαία είσπραξη", "Expected monthly receipt")} value={fmtEur(data?.expected_total ?? 0)} icon={TrendingUp} accent="green" sub={t(`μ.ο. ${data?.months_used.length ?? 0} μηνών`, `${data?.months_used.length ?? 0}-month avg`)} />
      </div>
      <p className="text-sm text-slate-500">{t("Πρόβλεψη βάσει μέσου όρου των τελευταίων κλεισμένων μηνών, ανά ταμείο.", "Forecast from the recent closed months' average, per fund.")}</p>
      <DataTable pageSize={20} columns={cols} rows={data?.by_fund ?? []} rowKey={(r) => r.fund} empty={t("Καμία εγγραφή.", "No data.")} />
    </div>
  );
}
