"use client";

import { Tooltip } from "@/components/ui/Tooltip";
import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Day = { date: string; ratio: number | null };
type Service = { source: string; runs: number; failed: number; uptime_pct: number; status: string; daily: Day[] };
type Failure = { tenant: string; source: string; error: string; at: string };
type Health = {
  summary: { syncs_30d: number; failed_30d: number; active_tenants: number; success_rate: number };
  services: Service[];
  recent_failures: Failure[];
};

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  operational: { text: "Λειτουργικό", cls: "text-emerald-600" },
  degraded: { text: "Υποβαθμισμένο", cls: "text-amber-600" },
  partial_outage: { text: "Μερική διακοπή", cls: "text-red-600" },
};

function barColor(r: number | null) {
  if (r === null) return "bg-slate-200";
  if (r >= 1) return "bg-emerald-500";
  if (r > 0) return "bg-amber-400";
  return "bg-red-500";
}

function ServiceRow({ s }: { s: Service }) {
  const st = STATUS_LABEL[s.status] ?? STATUS_LABEL.operational;
  return (
    <div className="border-t border-slate-100 py-4 first:border-t-0">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-slate-800">{s.source}</span>
        <span className={`text-sm font-medium ${st.cls}`}>{st.text}</span>
      </div>
      <Tooltip label="30 ημέρες"><div className="flex gap-[2px]">
        {s.daily.map((d) => (
          <Tooltip key={d.date} label={`${d.date}: ${d.ratio === null ? "—" : Math.round(d.ratio * 100) + "% ok"}`}><div className={`h-8 flex-1 rounded-sm ${barColor(d.ratio)}`} /></Tooltip>
        ))}
      </div></Tooltip>
      <div className="mt-1 flex justify-between text-xs text-slate-400">
        <span>30 ημέρες πριν</span>
        <span>{s.uptime_pct}% uptime · {fmtNum(s.runs)} syncs · {fmtNum(s.failed)} σφάλματα</span>
        <span>Σήμερα</span>
      </div>
    </div>
  );
}

const failColumns: Column<Failure>[] = [
  { key: "at", header: "Ημ/νία", render: (r) => fmtDate(r.at) },
  { key: "tenant", header: "Tenant" },
  { key: "source", header: "Πηγή" },
  { key: "error", header: "Σφάλμα", render: (r) => <span className="text-red-600">{r.error}</span> },
];

export default function HealthPage() {
  const { data, isLoading } = useQuery({ queryKey: ["admin", "health"], queryFn: () => adminApi<Health>("/admin/health"), retry: false });
  const s = data?.summary;
  const services = data?.services ?? [];
  const anyDegraded = services.some((x) => x.status !== "operational");

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">Κατάσταση πλατφόρμας</h1>

      {anyDegraded && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          Κάποιες υπηρεσίες είναι υποβαθμισμένες — δες παρακάτω.
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Επιτυχία sync (30ημ)" value={`${s?.success_rate ?? 100}%`} accent={(s?.success_rate ?? 100) >= 99 ? "green" : "amber"} />
        <KpiCard label="Syncs (30ημ)" value={fmtNum(s?.syncs_30d ?? 0)} />
        <KpiCard label="Σφάλματα (30ημ)" value={fmtNum(s?.failed_30d ?? 0)} accent="rose" />
        <KpiCard label="Ενεργοί tenants" value={fmtNum(s?.active_tenants ?? 0)} accent="sky" />
      </div>

      <div className="mb-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 text-sm font-semibold text-slate-700">Υπηρεσίες συγχρονισμού — uptime 90/30 ημερών</div>
        {isLoading ? <div className="text-slate-400">Φόρτωση…</div> : services.length === 0 ? (
          <div className="py-6 text-center text-slate-400">Δεν υπάρχουν δεδομένα sync.</div>
        ) : services.map((x) => <ServiceRow key={x.source} s={x} />)}
      </div>

      <h2 className="mb-3 text-sm font-semibold text-slate-700">Πρόσφατες αποτυχίες</h2>
      <DataTable pageSize={20} columns={failColumns} rows={data?.recent_failures ?? []} rowKey={(r, i) => `${r.tenant}-${i}`} empty="Καμία αποτυχία 🎉" />
    </div>
  );
}
