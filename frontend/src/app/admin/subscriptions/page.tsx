"use client";

import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Sub = {
  tenant_id: string;
  tenant: string;
  plan: string;
  status: string;
  seats: number;
  mrr: number; // cents
  current_period_end: string | null;
  days_to_expiry: number | null;
  trial_ends_at: string | null;
  trial_days_left: number | null;
};

type Summary = {
  total: number;
  expiring_30d: number;
  expired: number;
  trials_ending_14d: number;
  past_due: number;
  mrr: number;
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700",
  trial: "bg-sky-100 text-sky-700",
  past_due: "bg-red-100 text-red-700",
  suspended: "bg-slate-200 text-slate-600",
};

function StatusBadge({ value }: { value: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-600"}`}>
      {value}
    </span>
  );
}

/** Expiry cell: red if expired, amber if ≤30d, plain otherwise. */
function Expiry({ row }: { row: Sub }) {
  const d = row.days_to_expiry;
  if (d === null) return <span className="text-slate-400">—</span>;
  const label = d < 0 ? `ληγμένη πριν ${Math.abs(d)}η` : `σε ${d}η`;
  const cls = d < 0 ? "text-red-600 font-semibold" : d <= 30 ? "text-amber-600 font-medium" : "text-slate-600";
  return (
    <span className={cls}>
      {fmtDate(row.current_period_end ?? "")} <span className="text-xs">({label})</span>
    </span>
  );
}

const columns: Column<Sub>[] = [
  { key: "tenant", header: "Tenant" },
  { key: "plan", header: "Πλάνο" },
  { key: "status", header: "Κατάσταση", render: (r) => <StatusBadge value={r.status} /> },
  { key: "seats", header: "Θέσεις", align: "right", render: (r) => fmtNum(r.seats) },
  { key: "mrr", header: "MRR", align: "right", render: (r) => fmtEur(r.mrr) },
  { key: "current_period_end", header: "Λήξη συνδρομής", render: (r) => <Expiry row={r} /> },
  {
    key: "trial_days_left",
    header: "Trial",
    render: (r) =>
      r.status === "trial" && r.trial_days_left !== null ? (
        <span className="text-sky-700">λήγει σε {r.trial_days_left}η</span>
      ) : (
        <span className="text-slate-300">—</span>
      ),
  },
];

export default function SubscriptionsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "subscriptions"],
    queryFn: () => adminApi<{ items: Sub[]; summary: Summary }>("/admin/subscriptions"),
    retry: false,
  });

  const rows = data?.items ?? [];
  const s = data?.summary;

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">Συνδρομές & λήξεις</h1>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <KpiCard label="Σύνολο" value={fmtNum(s?.total ?? 0)} />
        <KpiCard label="Λήγουν ≤30ημ" value={fmtNum(s?.expiring_30d ?? 0)} accent="amber" />
        <KpiCard label="Ληγμένες" value={fmtNum(s?.expired ?? 0)} accent="rose" />
        <KpiCard label="Trials (≤14ημ)" value={fmtNum(s?.trials_ending_14d ?? 0)} accent="sky" />
        <KpiCard label="MRR" value={fmtEur(s?.mrr ?? 0)} accent="violet" />
      </div>

      {isLoading ? (
        <div className="text-slate-400">Φόρτωση…</div>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.tenant_id} />
      )}
    </div>
  );
}
