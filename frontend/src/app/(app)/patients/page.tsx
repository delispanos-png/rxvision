"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Users, Wallet, TrendingUp, Activity } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { BarChart } from "@/components/charts/BarChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";

type AggRow = { label: string; value: number };
type RetentionPoint = { period: string; retained_pct: number };
type PatientRow = {
  patient_ref: string;
  pseudo_id: string;
  full_name?: string | null;
  age_group: string;
  sex: string;
  area: string;
  rx: number;
  value: number; // cents
  claimed: number; // cents
  profit: number; // cents
  active_since: string;
};

const CURRENT_COHORT = new Date().toISOString().slice(0, 7);
const LIFECYCLE_EL: Record<string, string> = { active: "Ενεργοί", new: "Νέοι", inactive: "Ανενεργοί", churned: "Απωλεσθέντες" };

// Merge area spelling variants (ΑΓ.ΔΗΜΗΤΡΙΟΣ / ΑΓ ΔΗΜΗΤΡΙΟΣ / ΑΓΙΟΥ ΔΗΜΗΤΡΙΟΥ → one).
function normAreaKey(s: string) {
  return (s || "")
    .toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[.\-,]/g, " ")
    .replace(/\bΑΓΙΟΥ\b/g, "ΑΓ").replace(/\bΑΓΙΟΣ\b/g, "ΑΓ").replace(/\bΑΓ\b/g, "ΑΓ")
    .replace(/\bΠΑΛΑΙΟΥ?\b/g, "Π").replace(/\bΝΕΑΣ?\b/g, "Ν").replace(/\bΝ\b/g, "Ν")
    .replace(/ΟΥ\b/g, "ΟΣ") // crude genitive→nominative
    .replace(/\s+/g, " ").trim();
}
function mergeAreas(rows: AggRow[]) {
  const m = new Map<string, { label: string; value: number }>();
  for (const r of rows) {
    const k = normAreaKey(r.label);
    const cur = m.get(k);
    if (cur) cur.value += r.value;
    else m.set(k, { label: r.label.trim(), value: r.value });
  }
  return [...m.values()].sort((a, b) => b.value - a.value);
}

const patientColumns: Column<PatientRow>[] = [
  { key: "pseudo_id", header: "Ασφαλισμένος", render: (r) => r.full_name || r.pseudo_id || r.patient_ref },
  { key: "age_group", header: "Ηλικία" },
  { key: "sex", header: "Φύλο" },
  { key: "rx", header: "Συνταγές", align: "right", render: (r) => fmtNum(r.rx) },
  { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value) },
  { key: "claimed", header: "Αιτούμενα", align: "right", hideOnMobile: true, render: (r) => fmtEur(r.claimed) },
  { key: "profit", header: "Κερδοφορία", align: "right", render: (r) => fmtEur(r.profit) },
  { key: "active_since", header: "Ενεργός από", hideOnMobile: true, render: (r) => fmtDate(r.active_since) },
];

export default function PatientsPage() {
  const router = useRouter();
  const [showAllAreas, setShowAllAreas] = useState(false);
  const filters = useUiStore();
  const q = filtersToQuery(filters);

  const byAge = useQuery({
    queryKey: queryKeys.patientsAggregate("age_group", q),
    queryFn: () => api<{ rows: AggRow[] }>(`/patients/aggregate?by=age_group&${q}`),
  });
  const bySex = useQuery({
    queryKey: queryKeys.patientsAggregate("sex", q),
    queryFn: () => api<{ rows: AggRow[] }>(`/patients/aggregate?by=sex&${q}`),
  });
  const byArea = useQuery({
    queryKey: queryKeys.patientsAggregate("area", q),
    queryFn: () => api<{ rows: AggRow[] }>(`/patients/aggregate?by=area&${q}`),
  });
  const retention = useQuery({
    queryKey: queryKeys.patientsRetention(CURRENT_COHORT),
    queryFn: () => api<{ points: RetentionPoint[] }>(`/patients/retention?cohort=${CURRENT_COHORT}`),
  });
  const perPatient = useQuery({
    queryKey: ["patients", "list", q],
    queryFn: () => api<{ items: PatientRow[] }>(`/patients/list?sort=value&${q}`),
  });

  const age = byAge.data?.rows ?? [];
  const sex = bySex.data?.rows ?? [];
  const area = byArea.data?.rows ?? [];
  const areaMerged = mergeAreas(area);
  const areaShown = showAllAreas ? areaMerged : areaMerged.slice(0, 20);
  const ret = retention.data?.points ?? [];
  const patients = perPatient.data?.items ?? [];

  const totalInsured = sex.reduce((a, r) => a + (r.value || 0), 0) || age.reduce((a, r) => a + (r.value || 0), 0);
  const totalValue = patients.reduce((a, r) => a + (r.value || 0), 0);
  const totalProfit = patients.reduce((a, r) => a + (r.profit || 0), 0);
  const lastRetention = ret.length ? ret[ret.length - 1].retained_pct : 0;

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Ασφαλισμένοι</h1>
        <p className="mt-1 text-sm text-slate-500">Κατανομές, διατήρηση & αξία ανά ασφαλισμένο</p>
      </div>

      <div className="mb-4">
        <DateRangeFilter />
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Ασφαλισμένοι" value={fmtNum(totalInsured)} sub="σύνολο κατανομών" icon={Users} accent="indigo" />
          <KpiCard label="Αξία (top 100)" value={fmtEur(totalValue)} sub="κορυφαίοι ασφαλισμένοι" icon={Wallet} accent="violet" />
          <KpiCard label="Κερδοφορία (top 100)" value={fmtEur(totalProfit)} sub="μεικτό κέρδος" icon={TrendingUp} accent="green" />
          <KpiCard
            label="Διατήρηση"
            value={`${fmtNum(Math.round(lastRetention))}%`}
            sub={`cohort ${CURRENT_COHORT}`}
            icon={Activity}
            accent="sky"
          />
        </div>

        {/* distribution charts */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PanelCard title="Κατανομή ανά ηλικιακή ομάδα">
            <BarChart labels={age.map((r) => r.label)} data={age.map((r) => r.value)} name="Ασφαλισμένοι" height={280} />
          </PanelCard>
          <PanelCard title="Κατανομή ανά φύλο">
            <DonutChart data={sex.map((r) => ({ name: r.label, value: r.value }))} height={280} />
          </PanelCard>
          <PanelCard
            title="Κατανομή ανά περιοχή"
            action={areaMerged.length > 20 ? (
              <button onClick={() => setShowAllAreas((v) => !v)} className="text-xs font-medium text-brand-600 hover:underline">
                {showAllAreas ? "Λιγότερα" : `Δες περισσότερα (${areaMerged.length - 20})`}
              </button>
            ) : undefined}
          >
            <BarChart
              labels={areaShown.map((r) => r.label)}
              data={areaShown.map((r) => r.value)}
              name="Ασφαλισμένοι"
              horizontal
              height={Math.max(220, areaShown.length * 32)}
            />
          </PanelCard>
          <PanelCard title={`Διατήρηση — cohort ${CURRENT_COHORT}`}>
            <BarChart
              labels={ret.map((p) => LIFECYCLE_EL[p.period] || p.period)}
              data={ret.map((p) => p.retained_pct)}
              name="% Ασθενών"
              height={280}
            />
          </PanelCard>
        </div>

        {/* per-patient table */}
        <PanelCard title="Ανά ασφαλισμένο — αξία, αιτούμενα & κερδοφορία (top 100)" bodyClassName="pt-2">
          {perPatient.isLoading ? (
            <div className="text-slate-400">Φόρτωση δεδομένων…</div>
          ) : (
            <DataTable columns={patientColumns} rows={patients} rowKey={(r) => r.patient_ref}
              onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_ref)}`)} />
          )}
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
