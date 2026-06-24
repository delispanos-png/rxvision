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
import { useT } from "@/store/prefStore";

type T = (el: string, en: string) => string;

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

const makeRxCols = (t: T): Column<RxRow>[] => [
  { key: "executed_at", header: t("Ημ/νία", "Date"), render: (r) => fmtDate(r.executed_at) },
  { key: "external_id", header: t("Κωδικός", "Code") },
  { key: "patient_name", header: t("Ασθενής", "Patient"), render: (r) => r.patient_name || "—" },
  { key: "fund_name", header: t("Ταμείο", "Fund"), hideOnMobile: true, render: (r) => r.fund_name || "—" },
  {
    key: "status", header: t("Κατάσταση", "Status"), hideOnMobile: true,
    render: (r) => (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.has_unexecuted_substances ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
        {r.has_unexecuted_substances ? t("Μερικώς", "Partial") : t("Εκτελεσμένη", "Executed")}
      </span>
    ),
  },
  { key: "icd10", header: "ICD-10", hideOnMobile: true, render: (r) => (r.icd10 ?? []).join(", ") },
  { key: "amount_total", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.amount_total) },
  { key: "amount_claimed", header: t("Από ταμείο", "From fund"), align: "right", render: (r) => fmtEur(r.amount_claimed) },
];

const makePatCols = (t: T): Column<PatRow>[] => [
  { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.patient_ref },
  { key: "amka", header: "ΑΜΚΑ", hideOnMobile: true, render: (r) => r.amka || "—" },
  { key: "age_group", header: t("Ηλικία", "Age"), hideOnMobile: true, render: (r) => r.age_group || "—" },
  { key: "rx", header: t("Συνταγές", "Prescriptions"), align: "right", render: (r) => fmtNum(r.rx) },
  { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value) },
  { key: "last", header: t("Τελευταία", "Last"), hideOnMobile: true, render: (r) => fmtDate(r.last) },
];

export default function DoctorDetailPage() {
  const t = useT();
  const rxCols = makeRxCols(t);
  const patCols = makePatCols(t);
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
        <Link href="/doctors" className="text-sm text-brand-700 hover:underline">← {t("Πίσω στους ιατρούς", "Back to doctors")}</Link>
      </div>
      <h1 className="mb-4 text-xl font-bold text-slate-900">{t("Στατιστικά ιατρού", "Doctor statistics")}</h1>
      <div className="mb-6"><DateRangeFilter /></div>

      {stats.isLoading || !d ? (
        <div className="text-slate-400">{t("Φόρτωση δεδομένων…", "Loading data…")}</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <KpiCard label={t("Συνταγές", "Prescriptions")} help={t("Πλήθος εκτελέσεων συνταγών στην περίοδο.", "Number of executions in the period.")} value={fmtNum(d.rx)} />
          <KpiCard label={t("Αξία", "Value")} help={t("Άθροισμα λιανικής αξίας των εκτελέσεων της περιόδου.", "Sum of retail value of executions.")} value={fmtEur(d.value)} />
          <KpiCard label={t("Αιτούμενα", "Claimed")} help={t("Άθροισμα του αιτούμενου ποσού προς τα ασφαλιστικά ταμεία.", "Sum of amount claimed to insurance funds.")} value={fmtEur(d.claimed)} />
          <KpiCard label={t("Κερδοφορία", "Profitability")} help={t("Μεικτό κέρδος = αιτούμενο − κόστος χονδρικής.", "Gross profit = claimed − wholesale cost.")} value={fmtEur(d.profit)} sub={fmtPct(d.margin_pct)} />
          <KpiCard label={t("Μοναδικοί πελάτες", "Unique patients")} help={t("Μοναδικοί ασθενείς με ≥1 εκτέλεση στην περίοδο.", "Unique patients with ≥1 execution.")} value={fmtNum(d.distinct_patients)} />
          <KpiCard label={t("Νέοι πελάτες", "New patients")} help={t("Ασθενείς με πρώτη εκτέλεση στην περίοδο.", "Patients with their first execution in the period.")} value={fmtNum(d.new_patients)} />
        </div>
      )}

      {/* lists for the selected period */}
      <div className="mt-6 space-y-4">
        <PanelCard title={t("Ασθενείς που συνταγογράφησε (περίοδος)", "Patients prescribed for (period)")} bodyClassName="pt-2">
          <DataTable pageSize={20} columns={patCols} rows={pats.data?.items ?? []}
            rowKey={(r) => r.patient_ref}
            onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_ref)}`)}
            empty={t("Καμία συνταγή στην περίοδο.", "No prescriptions in the period.")} />
        </PanelCard>
        <PanelCard title={t("Συνταγές του ιατρού (περίοδος)", "Doctor's prescriptions (period)")} bodyClassName="pt-2">
          <DataTable pageSize={20} columns={rxCols} rows={rx.data?.items ?? []}
            rowKey={(r) => r.external_id}
            onRowClick={(r) => router.push(`/prescriptions/${encodeURIComponent(r.external_id)}`)}
            empty={t("Καμία συνταγή στην περίοδο.", "No prescriptions in the period.")} />
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
