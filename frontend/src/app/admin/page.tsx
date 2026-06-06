"use client";

import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Tenant = { id: string; status: string; mrr: number };
type SyncHealth = { id: string; tenant: string; source: string; last_run: string; status: string; errors: number };

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700", trial: "bg-sky-100 text-sky-700",
  past_due: "bg-red-100 text-red-700", suspended: "bg-slate-200 text-slate-600",
  success: "bg-emerald-100 text-emerald-700", failed: "bg-red-100 text-red-700", partial: "bg-amber-100 text-amber-700",
};
function Badge({ value }: { value: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-600"}`}>{value}</span>;
}

const syncColumns: Column<SyncHealth>[] = [
  { key: "tenant", header: "Tenant" },
  { key: "source", header: "Πηγή" },
  { key: "last_run", header: "Τελευταία εκτέλεση", render: (r) => fmtDate(r.last_run) },
  { key: "status", header: "Κατάσταση", render: (r) => <Badge value={r.status} /> },
  { key: "errors", header: "Σφάλματα", align: "right", render: (r) => <span className={r.errors > 0 ? "font-semibold text-red-600" : ""}>{fmtNum(r.errors)}</span> },
];

export default function AdminDashboardPage() {
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), retry: false });
  const sync = useQuery({ queryKey: ["admin", "sync-health"], queryFn: () => adminApi<{ items: SyncHealth[] }>("/admin/sync-health"), retry: false });

  const rows = tenants.data?.items ?? [];
  const active = rows.filter((t) => t.status === "active").length;
  const mrr = rows.reduce((s, t) => s + (t.mrr ?? 0), 0);

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">Πίνακας</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Tenants" value={fmtNum(rows.length)} />
        <KpiCard label="Ενεργοί" value={fmtNum(active)} accent="green" />
        <KpiCard label="Συνολικό MRR" value={fmtEur(mrr)} accent="violet" />
        <KpiCard label="Πηγές sync" value={fmtNum(sync.data?.items?.length ?? 0)} accent="sky" />
      </div>

      <h2 className="mb-3 text-sm font-semibold text-slate-700">Υγεία συγχρονισμών</h2>
      {sync.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable columns={syncColumns} rows={sync.data?.items ?? []} rowKey={(r) => r.id} />}
    </div>
  );
}
