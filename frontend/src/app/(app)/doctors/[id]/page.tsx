"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtNum, fmtPct, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { PanelCard } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/tables/DataTable";

type DoctorStats = {
  rx: number; value: number; claimed: number; cost: number;
  profit: number; margin_pct: number; distinct_patients: number; new_patients: number;
};
type RxRow = {
  external_id: string; executed_at: string; icd10: string[];
  amount_total: number; amount_claimed: number; status?: string;
  has_unexecuted_substances?: boolean;
  patient_name?: string | null; amka?: string | null; fund_name?: string | null;
};
type PatRow = {
  patient_ref: string; name?: string | null; amka?: string | null;
  age_group?: string; sex?: string; rx: number; value: number; last: string;
};

const rxCols: Column<RxRow>[] = [
  { key: "executed_at", header: "Ημ/νία", render: (r) => fmtDate(r.executed_at) },
  { key: "external_id", header: "Κωδικός" },
  { key: "patient_name", header: "Ασθενής", render: (r) => r.patient_name || "—" },
  { key: "fund_name", header: "Ταμείο", hideOnMobile: true, render: (r) => r.fund_name || "—" },
  {
    key: "status", header: "Κατάσταση", hideOnMobile: true,
    render: (r) => (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.has_unexecuted_substances ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
        {r.has_unexecuted_substances ? "Μερικώς" : "Εκτελεσμένη"}
      </span>
    ),
  },
  { key: "icd10", header: "ICD-10", hideOnMobile: true, render: (r) => (r.icd10 ?? []).join(", ") },
  { key: "amount_total", header: "Αξία", align: "right", render: (r) => fmtEur(r.amount_total) },
  { key: "amount_claimed", header: "Από ταμείο", align: "right", render: (r) => fmtEur(r.amount_claimed) },
];

const patCols: Column<PatRow>[] = [
  { key: "name", header: "Ασθενής", render: (r) => r.name || r.patient_ref },
  { key: "amka", header: "ΑΜΚΑ", hideOnMobile: true, render: (r) => r.amka || "—" },
  { key: "age_group", header: "Ηλικία", hideOnMobile: true, render: (r) => r.age_group || "—" },
  { key: "rx", header: "Συνταγές", align: "right", render: (r) => fmtNum(r.rx) },
  { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value) },
  { key: "last", header: "Τελευταία", hideOnMobile: true, render: (r) => fmtDate(r.last) },
];

export default function DoctorDetailPage() {
  const id = useParams<{ id: string }>().id;
  const router = useRouter();
  const filters = useUiStore();
  const q = filtersToQuery(filters);

  const stats = useQuery({
    queryKey: ["doctors", "stats", id, q],
    queryFn: () => api<DoctorStats>(`/doctors/${id}/stats?${q}`),
  });
  const rx = useQuery({
    queryKey: ["doctors", "rx", id, q],
    queryFn: () => api<{ items: RxRow[] }>(`/doctors/${id}/prescriptions?${q}`),
  });
  const pats = useQuery({
    queryKey: ["doctors", "pats", id, q],
    queryFn: () => api<{ items: PatRow[] }>(`/doctors/${id}/patients?${q}`),
  });

  const d = stats.data;

  return (
    <ModuleGuard module="doctor_analytics">
      <div className="mb-6">
        <Link href="/doctors" className="text-sm text-brand-700 hover:underline">← Πίσω στους ιατρούς</Link>
      </div>
      <h1 className="mb-4 text-xl font-bold text-slate-900">Στατιστικά ιατρού</h1>
      <div className="mb-6"><DateRangeFilter /></div>

      {stats.isLoading || !d ? (
        <div className="text-slate-400">Φόρτωση δεδομένων…</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="Συνταγές" value={fmtNum(d.rx)} />
          <KpiCard label="Αξία" value={fmtEur(d.value)} />
          <KpiCard label="Αιτούμενα" value={fmtEur(d.claimed)} />
          <KpiCard label="Κερδοφορία" value={fmtEur(d.profit)} sub={fmtPct(d.margin_pct)} />
          <KpiCard label="Μοναδικοί πελάτες" value={fmtNum(d.distinct_patients)} />
          <KpiCard label="Νέοι πελάτες" value={fmtNum(d.new_patients)} />
        </div>
      )}

      {/* lists for the selected period */}
      <div className="mt-6 space-y-4">
        <PanelCard title="Ασθενείς που συνταγογράφησε (περίοδος)" bodyClassName="pt-2">
          <DataTable pageSize={20} columns={patCols} rows={pats.data?.items ?? []}
            rowKey={(r) => r.patient_ref}
            onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_ref)}`)}
            empty="Καμία συνταγή στην περίοδο." />
        </PanelCard>
        <PanelCard title="Συνταγές του ιατρού (περίοδος)" bodyClassName="pt-2">
          <DataTable pageSize={20} columns={rxCols} rows={rx.data?.items ?? []}
            rowKey={(r) => r.external_id}
            onRowClick={(r) => router.push(`/prescriptions/${encodeURIComponent(r.external_id)}`)}
            empty="Καμία συνταγή στην περίοδο." />
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
