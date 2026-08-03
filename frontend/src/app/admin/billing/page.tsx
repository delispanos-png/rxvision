"use client";

import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import Link from "next/link";

type Summary = { mrr: number; arr: number; at_risk_mrr: number; active: number; trial: number; past_due: number };
type PlanRow = { plan: string; tenants: number; mrr: number };
type TenantRow = { tenant: string; plan: string; status: string; mrr: number };

const planColumns: Column<PlanRow>[] = [
  { key: "plan", header: "Πλάνο" },
  { key: "tenants", header: "Tenants", align: "right", render: (r) => fmtNum(r.tenants) },
  { key: "mrr", header: "MRR", align: "right", render: (r) => fmtEur(r.mrr) },
];

const tenantColumns: Column<TenantRow>[] = [
  { key: "tenant", header: "Tenant" },
  { key: "plan", header: "Πλάνο" },
  { key: "status", header: "Κατάσταση" },
  { key: "mrr", header: "MRR", align: "right", render: (r) => fmtEur(r.mrr) },
];

export default function BillingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "billing"],
    queryFn: () => adminApi<{ summary: Summary; by_plan: PlanRow[]; tenants: TenantRow[] }>("/admin/billing"),
    retry: false,
  });

  const s = data?.summary;
  const plans = data?.by_plan ?? [];

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">Τιμολόγηση & Οικονομικά</h1>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <KpiCard label="MRR" value={fmtEur(s?.mrr ?? 0)} accent="violet" />
        <KpiCard label="ARR" value={fmtEur(s?.arr ?? 0)} accent="indigo" />
        <KpiCard label="MRR σε κίνδυνο" value={fmtEur(s?.at_risk_mrr ?? 0)} accent="amber" />
        <KpiCard label="Ενεργές" value={fmtNum(s?.active ?? 0)} accent="green" />
        <KpiCard label="Past due" value={fmtNum(s?.past_due ?? 0)} accent="rose" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-2 text-sm font-medium text-slate-500">MRR ανά πλάνο</div>
          <BarChart labels={plans.map((p) => p.plan)} data={plans.map((p) => p.mrr / 100)} name="MRR €" horizontal />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-2 text-sm font-medium text-slate-500">Σύνολο ανά πλάνο</div>
          <DataTable pageSize={20} columns={planColumns} rows={plans} rowKey={(r) => r.plan} />
        </div>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-slate-700">Συνεισφορά MRR ανά tenant</h2>
      {isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable pageSize={20} columns={tenantColumns} rows={data?.tenants ?? []} rowKey={(r) => r.tenant} />}

      <div className="mt-8 flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <div className="text-sm font-semibold text-slate-700">Παραστατικά</div>
          <div className="text-xs text-slate-500">Τα παραστατικά (έκδοση & ενημέρωση SoftOne/myDATA) μεταφέρθηκαν σε ξεχωριστή σελίδα.</div>
        </div>
        <Link href="/admin/invoices" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Άνοιγμα Παραστατικών →</Link>
      </div>
    </div>
  );
}
