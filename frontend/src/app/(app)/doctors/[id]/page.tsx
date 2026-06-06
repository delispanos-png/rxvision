"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtNum, fmtPct } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";

type DoctorStats = {
  rx: number;
  value: number; // cents
  claimed: number; // cents
  cost: number; // cents
  profit: number; // cents
  margin_pct: number;
  distinct_patients: number;
  new_patients: number;
};

export default function DoctorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const filters = useUiStore();
  const q = filtersToQuery(filters);

  const { data, isLoading } = useQuery({
    queryKey: ["doctors", "stats", id, q],
    queryFn: () => api<DoctorStats>(`/doctors/${id}/stats?${q}`),
  });

  return (
    <ModuleGuard module="doctor_analytics">
      <div className="mb-6">
        <Link href="/doctors" className="text-sm text-brand-700 hover:underline">
          ← Πίσω στους ιατρούς
        </Link>
      </div>

      <h1 className="mb-4 text-xl font-bold text-slate-900">Στατιστικά ιατρού</h1>

      <div className="mb-6">
        <DateRangeFilter />
      </div>

      {isLoading || !data ? (
        <div className="text-slate-400">Φόρτωση δεδομένων…</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="Συνταγές" value={fmtNum(data.rx)} />
          <KpiCard label="Αξία" value={fmtEur(data.value)} />
          <KpiCard label="Αιτούμενα" value={fmtEur(data.claimed)} />
          <KpiCard label="Κερδοφορία" value={fmtEur(data.profit)} sub={fmtPct(data.margin_pct)} />
          <KpiCard label="Μοναδικοί πελάτες" value={fmtNum(data.distinct_patients)} />
          <KpiCard label="Νέοι πελάτες" value={fmtNum(data.new_patients)} />
        </div>
      )}
    </ModuleGuard>
  );
}
