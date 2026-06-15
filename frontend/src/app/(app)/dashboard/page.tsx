"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 as BarIcon, Receipt, TrendingUp, Users, Wallet, Download } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { QueryState } from "@/components/ui/QueryState";
import { downloadCsv } from "@/lib/csv";
import { fmtDate, fmtMoney} from "@/lib/formatters";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { LineChart } from "@/components/charts/LineChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { BarChart } from "@/components/charts/BarChart";
import { HeatmapChart, type HeatCell } from "@/components/charts/HeatmapChart";
import { CalendarHeatmap } from "@/components/charts/CalendarHeatmap";
import { useT } from "@/store/prefStore";

type Summary = { executions: number; value: number; claimed: number; gross_profit: number; patient_count: number };
type Bucket = { bucket: string; value: number };
type HeatPoint = { dow: number; hour: number; value: number };
type Top = { _id?: string; name?: string; rx?: number; value?: number };
type Rx = { external_id: string; amount_total: number; executed_at: string; source: string };

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);
const eur2 = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const num = (n: number) => new Intl.NumberFormat("el-GR").format(n || 0);

type RxRow = { external_id: string; executed_at: string; patient_name?: string | null; amka?: string | null; fund_name?: string | null; fund_general?: string | null; amount_total: number; amount_claimed: number };
type PatRow = { patient_ref?: string; full_name?: string | null; age_group?: string | null; area?: string | null; rx?: number; value?: number };

type T = (el: string, en: string) => string;
const makeRxModalCols = (t: T): Column<RxRow>[] => [
  { key: "executed_at", header: t("Ημ/νία", "Date"), render: (r) => fmtDate(r.executed_at), sortValue: (r) => r.executed_at },
  { key: "external_id", header: t("Κωδικός", "Code") },
  { key: "patient_name", header: t("Ασθενής", "Patient"), render: (r) => r.patient_name || "—" },
  { key: "fund_name", header: t("Ταμείο", "Fund"), hideOnMobile: true, render: (r) => r.fund_general || r.fund_name || "—" },
  { key: "amount_total", header: t("Αξία", "Value"), align: "right", render: (r) => eur2(r.amount_total), sortValue: (r) => r.amount_total },
  { key: "amount_claimed", header: t("Από ταμείο", "From fund"), align: "right", render: (r) => eur2(r.amount_claimed), sortValue: (r) => r.amount_claimed },
];
const makePatModalCols = (t: T): Column<PatRow>[] => [
  { key: "full_name", header: t("Ασφαλισμένος", "Patient"), render: (r) => r.full_name || r.patient_ref || "—" },
  { key: "age_group", header: t("Ηλικία", "Age"), hideOnMobile: true, render: (r) => r.age_group || "—" },
  { key: "area", header: t("Περιοχή", "Area"), hideOnMobile: true, render: (r) => r.area || "—" },
  { key: "rx", header: t("Συνταγές", "Prescriptions"), align: "right", render: (r) => num(r.rx || 0), sortValue: (r) => r.rx ?? 0 },
  { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => eur2(r.value || 0), sortValue: (r) => r.value ?? 0 },
];

const GREETING = (t: T) => {
  const h = new Date().getHours();
  return h < 12 ? t("Καλημέρα", "Good morning") : h < 18 ? t("Καλησπέρα", "Good afternoon") : t("Καλό βράδυ", "Good evening");
};

export default function DashboardPage() {
  const t = useT();
  const rxModalCols = makeRxModalCols(t);
  const patModalCols = makePatModalCols(t);
  // shared global filter (date range + fund/doctor/icd10) — same across every page
  const filters = useUiStore();
  const qs = filtersToQuery(filters);
  const from = filters.dateFrom, to = filters.dateTo;
  const fromD = filters.dateFrom, toD = filters.dateTo;

  // drill-down popup (clickable KPIs)
  const [modal, setModal] = useState<{ title: string; kind: "rx" | "patients"; qs: string } | null>(null);
  const modalList = useQuery({
    queryKey: ["dash", "modal", modal?.kind, modal?.qs],
    queryFn: () => api<{ items: Record<string, unknown>[] }>(
      modal!.kind === "patients" ? `/patients/list?${modal!.qs}` : `/prescriptions?${modal!.qs}`),
    enabled: !!modal,
  });

  const summary = useQuery({ queryKey: ["dash", "summary", from, to], queryFn: () => api<Summary>(`/dashboard/summary?${qs}`) });
  // Δ vs the SAME period last year (πέρσι)
  const prevRange = prevYearRange(from, to);
  const prevQs = prevRange ? filtersToQuery({ ...filters, dateFrom: prevRange.from, dateTo: prevRange.to }) : "";
  const prevSummary = useQuery({
    queryKey: ["dash", "summary", "prevYear", prevRange?.from, prevRange?.to],
    queryFn: () => api<Summary>(`/dashboard/summary?${prevQs}`),
    enabled: !!prevRange,
  });
  const prev = prevSummary.data;
  const delta = pctDelta;
  const tsVal = useQuery({ queryKey: ["dash", "ts", "value", from, to], queryFn: () => api<Bucket[]>(`/dashboard/timeseries?metric=value&grain=day&${qs}`) });
  const tsClaim = useQuery({ queryKey: ["dash", "ts", "claimed", from, to], queryFn: () => api<Bucket[]>(`/dashboard/timeseries?metric=claimed&grain=day&${qs}`) });
  const topIcd = useQuery({ queryKey: ["dash", "icd", from, to], queryFn: () => api<Top[]>(`/dashboard/top?dim=icd10&limit=6&${qs}`) });
  const topDoc = useQuery({ queryKey: ["dash", "doc", from, to], queryFn: () => api<Top[]>(`/dashboard/top?dim=doctors&limit=6&${qs}`) });
  const recent = useQuery({ queryKey: ["dash", "recent", from, to], queryFn: () => api<{ items: Rx[] }>(`/prescriptions?${qs}&page=1&page_size=6`) });
  const heat = useQuery({ queryKey: ["dash", "heat", from, to], queryFn: () => api<HeatPoint[]>(`/dashboard/heatmap?metric=executions&${qs}`) });
  const tsExec = useQuery({ queryKey: ["dash", "ts", "exec", from, to], queryFn: () => api<Bucket[]>(`/dashboard/timeseries?metric=executions&grain=day&${qs}`) });

  // [date, executions] per calendar day for the calendar heatmap
  const calendarData: [string, number][] = (tsExec.data ?? []).map((b) => [b.bucket, b.value]);
  const calendarWeeks = Math.ceil((calendarData.length || 7) / 7) + 1;

  // {dow:1-7, hour:0-23} → [hourIdx, dowIdx(0=Δευ), value]
  const heatCells: HeatCell[] = (heat.data ?? []).map((p) => [p.hour, p.dow - 1, p.value]);

  const s = summary.data;
  const labels = (tsVal.data ?? []).map((b) => { const [, m, d] = b.bucket.split("-"); return `${d}/${m}`; }); // DD/MM
  const valSeries = (tsVal.data ?? []).map((b) => Math.round((b.value || 0) / 100));
  const claimSeries = (tsClaim.data ?? []).map((b) => Math.round((b.value || 0) / 100));

  const dateLabel = new Date().toLocaleDateString("el-GR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <ModuleGuard module="dashboard">
      {/* header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{GREETING(t)}! 👋</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Επισκόπηση φαρμακείου", "Pharmacy overview")} — {dateLabel}</p>
        </div>
        <DateRangeFilter />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard label={t("Εκτελέσεις", "Executions")} value={num(s?.executions ?? 0)} sub={t("συνταγές περιόδου · δες λίστα", "prescriptions in period · see list")} icon={Receipt} accent="indigo" trend={delta(s?.executions, prev?.executions)}
          onClick={() => setModal({ title: t("Εκτελέσεις περιόδου", "Executions in period"), kind: "rx", qs: `${qs}&page_size=300&sort=executed_at&dir=-1` })} />
        <KpiCard label={t("Αξία συνταγών", "Prescriptions value")} value={eur(s?.value ?? 0)} sub={t("σύνολο περιόδου · δες λίστα", "period total · see list")} icon={BarIcon} accent="violet" trend={delta(s?.value, prev?.value)}
          onClick={() => setModal({ title: t("Συνταγές κατά αξία (φθίνουσα)", "Prescriptions by value (descending)"), kind: "rx", qs: `${qs}&page_size=300&sort=amount_total&dir=-1` })} />
        <KpiCard label={t("Αιτούμενα ταμείων", "Funds claimed")} value={eur(s?.claimed ?? 0)} sub={t("προς ασφ. φορείς · δες λίστα", "to insurance funds · see list")} icon={Wallet} accent="amber" trend={delta(s?.claimed, prev?.claimed)}
          onClick={() => setModal({ title: t("Συνταγές κατά αιτούμενο ταμείου", "Prescriptions by fund claimed"), kind: "rx", qs: `${qs}&page_size=300&sort=amount_claimed&dir=-1` })} />
        <KpiCard label={t("Μεικτό κέρδος", "Gross profit")} value={eur(s?.gross_profit ?? 0)} sub={t("αιτούμενο − χονδρική", "claimed − wholesale")} icon={TrendingUp} accent="green" trend={delta(s?.gross_profit, prev?.gross_profit)} />
        <KpiCard label={t("Ασφαλισμένοι", "Patients")} value={num(s?.patient_count ?? 0)} sub={t("μοναδικοί · δες λίστα", "unique · see list")} icon={Users} accent="sky" trend={delta(s?.patient_count, prev?.patient_count)}
          onClick={() => setModal({ title: t("Ασφαλισμένοι περιόδου", "Patients in period"), kind: "patients", qs: `${qs}&sort=value&limit=300` })} />
      </div>

      {/* charts row */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title={t("Πορεία Αξίας & Αιτούμενων", "Value & claimed trend")} className="lg:col-span-2">
          <LineChart
            labels={labels}
            series={[
              { name: t("Αξία (€)", "Value (€)"), data: valSeries },
              { name: t("Αιτούμενα (€)", "Claimed (€)"), data: claimSeries },
            ]}
            colors={["#ef4444", "#10b981"]}
            height={300}
          />
        </PanelCard>
        <PanelCard title={t("Ανάλυση ανά ICD-10", "Breakdown by ICD-10")}>
          <DonutChart
            height={300}
            data={(topIcd.data ?? []).map((d) => ({ name: d.name ? `${d._id} · ${d.name}` : (d._id || "—"), value: d.rx || 0 }))}
          />
        </PanelCard>
      </div>

      {/* bottom row */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title={t("Top Ιατροί (αξία)", "Top Doctors (value)")} className="lg:col-span-2">
          <BarChart
            horizontal
            height={300}
            labels={(topDoc.data ?? []).map((d) => d.name || "—")}
            data={(topDoc.data ?? []).map((d) => Math.round((d.value || 0) / 100))}
            name="€"
          />
        </PanelCard>
        <PanelCard title={t("Πρόσφατες Συνταγές", "Recent Prescriptions")} bodyClassName="pt-2">
          <ul className="divide-y divide-slate-100">
            {(recent.data?.items ?? []).map((r) => (
              <li key={r.external_id} className="flex items-center justify-between py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-600">{r.source}</span>
                    <span className="truncate text-sm font-medium text-slate-700">{r.external_id}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400">{new Date(r.executed_at).toLocaleDateString("el-GR")}</div>
                </div>
                <div className="text-sm font-semibold text-slate-900">{eur2(r.amount_total)}</div>
              </li>
            ))}
            {!recent.isLoading && (recent.data?.items?.length ?? 0) === 0 && (
              <li className="py-8 text-center text-sm text-slate-400">{t("Δεν υπάρχουν", "None")}</li>
            )}
          </ul>
        </PanelCard>
      </div>

      {/* busy-hours heatmap */}
      <div className="mt-4">
        <PanelCard title={t("Ώρες αιχμής — μοτίβο εβδομάδας (όλη η περίοδος)", "Peak hours — weekly pattern (whole period)")}>
          <p className="-mt-1 mb-3 text-xs text-slate-400">
            {t("Συγκεντρωτικά για ΟΛΗ την επιλεγμένη περίοδο", "Aggregated over the WHOLE selected period")} ({fromD.split("-").reverse().join("/")} → {toD.split("-").reverse().join("/")}):
            {" "}{t("όλες οι Δευτέρες αθροίζονται μαζί, όλες οι Τρίτες μαζί κ.λπ. — δείχνει το", "all Mondays summed together, all Tuesdays together, etc. — shows the")} <b>{t("τυπικό μοτίβο", "typical pattern")}</b> {t("της εβδομάδας, ΟΧΙ μία συγκεκριμένη εβδομάδα.", "of the week, NOT one specific week.")}
          </p>
          <HeatmapChart cells={heatCells} />
        </PanelCard>
      </div>

      {/* calendar heatmap — executions per DATE */}
      <div className="mt-4">
        <PanelCard title={t("Ημερολόγιο αιχμής — εκτελέσεις ανά ημερομηνία (κάθε μέρα ξεχωριστά)", "Peak calendar — executions per date (each day separately)")}>
          <CalendarHeatmap data={calendarData} height={Math.max(180, calendarWeeks * 18 + 80)} />
        </PanelCard>
      </div>

      {/* KPI drill-down popup */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.title} size="3xl">
        {modal && (
          <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-slate-500">{num(modalList.data?.items?.length ?? 0)} {t("εγγραφές", "records")}</p>
            {(modalList.data?.items?.length ?? 0) > 0 && (
              <button
                onClick={() => {
                  const cols = modal.kind === "patients"
                    ? [{ key: "full_name", header: t("Ασφαλισμένος", "Patient") }, { key: "age_group", header: t("Ηλικία", "Age") }, { key: "area", header: t("Περιοχή", "Area") }, { key: "rx", header: t("Συνταγές", "Prescriptions") }, { key: "value", header: t("Αξία (€)", "Value (€)"), value: (r: Record<string, unknown>) => fmtMoney(((r.value as number) || 0)) }]
                    : [{ key: "executed_at", header: t("Ημ/νία", "Date"), value: (r: Record<string, unknown>) => fmtDate(r.executed_at as string) }, { key: "external_id", header: t("Κωδικός", "Code") }, { key: "patient_name", header: t("Ασθενής", "Patient") }, { key: "fund_name", header: t("Ταμείο", "Fund"), value: (r: Record<string, unknown>) => (r.fund_general as string) || (r.fund_name as string) || "" }, { key: "amount_total", header: t("Αξία (€)", "Value (€)"), value: (r: Record<string, unknown>) => fmtMoney(((r.amount_total as number) || 0)) }, { key: "amount_claimed", header: t("Από ταμείο (€)", "From fund (€)"), value: (r: Record<string, unknown>) => fmtMoney(((r.amount_claimed as number) || 0)) }];
                  downloadCsv(modal.kind === "patients" ? "asfalismenoi" : "syntages", cols, modalList.data!.items);
                }}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" /> {t("Εξαγωγή CSV", "Export CSV")}
              </button>
            )}
          </div>
        )}
        <QueryState isLoading={modalList.isLoading} isError={modalList.isError}
          isEmpty={(modalList.data?.items?.length ?? 0) === 0} onRetry={() => modalList.refetch()}
          empty={t("Καμία εγγραφή.", "No records.")}>
          {modal?.kind === "patients"
            ? <DataTable pageSize={15} columns={patModalCols} rows={(modalList.data?.items ?? []) as PatRow[]} rowKey={(r, i) => `${(r as PatRow).patient_ref ?? i}`} />
            : <DataTable pageSize={15} columns={rxModalCols} rows={(modalList.data?.items ?? []) as RxRow[]} rowKey={(r, i) => `${(r as RxRow).external_id ?? i}`} />}
        </QueryState>
      </Modal>
    </ModuleGuard>
  );
}
