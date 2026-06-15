"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, CalendarDays, CalendarRange, Pill, Download, PackageCheck, Users } from "lucide-react";
import { api } from "@/lib/apiClient";
import { downloadCsv } from "@/lib/csv";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DateInput } from "@/components/ui/DateInput";
import { fmtNum, fmtDate, fmtEur } from "@/lib/formatters";
import { SelectFilter } from "@/components/filters/SelectFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { LineChart } from "@/components/charts/LineChart";
import { Modal } from "@/components/ui/Modal";

type UpcomingDay = { date: string; count: number };
type ForecastRow = { product_id: string; name: string; expected_demand: number };
type FutureRx = {
  expected_open_date: string; patient_name?: string | null; amka?: string | null;
  source_barcode?: string | null; products?: (string | null)[]; n_items?: number; confidence?: number;
};
type CoverageItem = {
  product_id: string; product_name?: string | null; substance?: string | null;
  needed_qty: number; n_patients: number; prescriptions: number; avg_daily: number; est_cost: number;
};
type Coverage = {
  date: string;
  summary: { prescriptions: number; n_patients: number; products: number; total_units: number; est_cost: number };
  items: CoverageItem[];
};
const _tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

export default function FuturePage() {
  const t = useT();
  const [minHistory, setMinHistory] = useState("0");
  const [covDate, setCovDate] = useState(_tomorrow());
  const [modal, setModal] = useState<{ title: string; subtitle: string; qs: string } | null>(null);

  const coverage = useQuery({
    queryKey: ["future", "daily-coverage", covDate],
    queryFn: () => api<Coverage>(`/future/daily-coverage?date=${covDate}`),
  });
  const cov = coverage.data;
  const covCols: Column<CoverageItem>[] = [
    { key: "product_name", header: t("Φάρμακο", "Product"), render: (r) => r.product_name ?? r.product_id },
    { key: "needed_qty", header: t("Ποσότητα", "Qty"), align: "right", render: (r) => <span className="font-semibold">{fmtNum(r.needed_qty)}</span> },
    { key: "n_patients", header: t("Ασθενείς", "Patients"), align: "right", render: (r) => fmtNum(r.n_patients) },
    { key: "avg_daily", header: t("Μ.Ο./μέρα", "Avg/day"), align: "right", hideOnMobile: true, render: (r) => r.avg_daily },
    { key: "est_cost", header: t("Εκτ. κόστος", "Est. cost"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.est_cost) },
  ];

  const futureCols: Column<FutureRx>[] = [
    { key: "expected_open_date", header: t("Αναμένεται", "Expected"), render: (r) => fmtDate(r.expected_open_date) },
    { key: "patient_name", header: t("Ασθενής", "Patient"), render: (r) => r.patient_name || "—" },
    { key: "amka", header: "ΑΜΚΑ", hideOnMobile: true, render: (r) => r.amka || "—" },
    { key: "products", header: t("Σκευάσματα", "Products"), render: (r) => (r.products ?? []).filter(Boolean).join(", ") || t(`${r.n_items ?? 0} είδη`, `${r.n_items ?? 0} items`) },
    { key: "source_barcode", header: t("Από συνταγή", "From prescription"), hideOnMobile: true, render: (r) => r.source_barcode || "—" },
  ];

  const HISTORY = [
    { value: "0", label: t("Όλοι οι ασφαλισμένοι", "All patients") },
    { value: "1", label: t("≥ 1 προηγούμενη", "≥ 1 previous") },
    { value: "2", label: t("≥ 2 προηγούμενες", "≥ 2 previous") },
    { value: "3", label: t("≥ 3 προηγούμενες", "≥ 3 previous") },
    { value: "5", label: t("≥ 5 προηγούμενες", "≥ 5 previous") },
  ];

  const forecastColumns: Column<ForecastRow>[] = [
    { key: "name", header: t("Σκεύασμα", "Product"), render: (r) => r.name ?? r.product_id },
    { key: "expected_demand", header: t("Αναμενόμενη ζήτηση", "Expected demand"), align: "right", render: (r) => fmtNum(r.expected_demand) },
  ];

  const list = useQuery({
    queryKey: ["future", "list", modal?.qs],
    queryFn: () => api<{ items: FutureRx[] }>(`/future/upcoming-list?${modal!.qs}`),
    enabled: !!modal,
  });

  const upcoming = useQuery({
    queryKey: ["future", "upcoming", 30, minHistory],
    queryFn: () => api<{ items: UpcomingDay[] }>(`/future/upcoming?days=30&min_history=${minHistory}`),
  });

  const forecast = useQuery({
    queryKey: ["future", "forecast", 30],
    queryFn: () => api<{ items: ForecastRow[] }>(`/future/forecast?horizon_days=30`),
  });

  const days = upcoming.data?.items ?? [];
  const total = days.reduce((s, d) => s + d.count, 0);
  const next7 = days.slice(0, 7).reduce((s, d) => s + d.count, 0);
  const next30 = total;
  const peak = days.reduce<UpcomingDay | null>((m, d) => (!m || d.count > m.count ? d : m), null);

  return (
    <ModuleGuard module="future_prescriptions">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Μελλοντικές συνταγές", "Upcoming prescriptions")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Πρόβλεψη επαναλαμβανόμενης ζήτησης τις επόμενες 30 ημέρες", "Forecast of recurring demand over the next 30 days")}</p>
        </div>
      </div>

      <div className="mb-4">
        <SelectFilter
          label={t("Πελάτες με ιστορικό", "Customers with history")}
          value={minHistory}
          options={HISTORY}
          onChange={(v) => setMinHistory(v ?? "0")}
          allLabel={t("Όλοι οι ασφαλισμένοι", "All patients")}
        />
      </div>

      <div className="space-y-4">
        {/* Κάλυψη ημέρας — τι να έχεις/παραγγείλεις για τις συνταγές που ανοίγουν */}
        <PanelCard
          title={t("Κάλυψη ημέρας — ποσότητες για τις συνταγές που ανοίγουν", "Daily coverage — quantities for opening prescriptions")}
          bodyClassName="pt-2"
        >
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-end gap-2">
              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">{t("Ημέρα", "Day")}</span>
                <DateInput value={covDate} onChange={(v) => setCovDate(v || _tomorrow())} />
              </label>
              <button onClick={() => setCovDate(_tomorrow())} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">{t("Αύριο", "Tomorrow")}</button>
            </div>
            {(cov?.items?.length ?? 0) > 0 && (
              <button
                onClick={() => downloadCsv(`kalypsi-imeras-${covDate}`, [
                  { key: "product_name", header: t("Φάρμακο", "Product") },
                  { key: "substance", header: t("Δραστική", "Substance") },
                  { key: "needed_qty", header: t("Ποσότητα", "Qty") },
                  { key: "n_patients", header: t("Ασθενείς", "Patients") },
                  { key: "prescriptions", header: t("Συνταγές", "Prescriptions") },
                  { key: "avg_daily", header: t("Μ.Ο./μέρα", "Avg/day") },
                  { key: "est_cost", header: t("Εκτ. κόστος (€)", "Est. cost (€)"), value: (r: CoverageItem) => (r.est_cost / 100).toFixed(2) },
                ], cov!.items)}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" /> {t("Εξαγωγή για παραγγελία", "Export for ordering")}
              </button>
            )}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label={t("Συνταγές", "Prescriptions")} value={fmtNum(cov?.summary.prescriptions ?? 0)} icon={CalendarDays} accent="indigo" />
            <KpiCard label={t("Σταθεροί ασθενείς", "Stable patients")} value={fmtNum(cov?.summary.n_patients ?? 0)} icon={Users} accent="violet" />
            <KpiCard label={t("Φάρμακα / τεμάχια", "Products / units")} value={`${fmtNum(cov?.summary.products ?? 0)} / ${fmtNum(cov?.summary.total_units ?? 0)}`} icon={PackageCheck} accent="amber" />
            <KpiCard label={t("Εκτ. κόστος", "Est. cost")} value={fmtEur(cov?.summary.est_cost ?? 0)} icon={Pill} accent="sky" />
          </div>
          <QueryState
            isLoading={coverage.isLoading}
            isError={coverage.isError}
            isEmpty={(cov?.items?.length ?? 0) === 0}
            empty={t("Καμία επαναλαμβανόμενη συνταγή δεν ανοίγει αυτή τη μέρα.", "No recurring prescriptions open on this day.")}
            onRetry={() => coverage.refetch()}
          >
            <DataTable pageSize={50} columns={covCols} rows={cov?.items ?? []} rowKey={(r) => r.product_id} />
          </QueryState>
        </PanelCard>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label={t("Μελλοντικές συνταγές", "Upcoming prescriptions")} value={fmtNum(total)} sub={t("σύνολο 30 ημερών · δες λίστα", "30-day total · see list")} icon={CalendarClock} accent="indigo"
            onClick={() => setModal({ title: t("Μελλοντικές συνταγές — 30 ημέρες", "Upcoming prescriptions — 30 days"), subtitle: t(`${total} συνταγές αναμένονται`, `${total} prescriptions expected`), qs: `days=30&min_history=${minHistory}` })} />
          <KpiCard label={t("Επόμενες 7 ημέρες", "Next 7 days")} value={fmtNum(next7)} sub={t("συνταγές · δες λίστα", "prescriptions · see list")} icon={CalendarDays} accent="violet"
            onClick={() => setModal({ title: t("Επόμενες 7 ημέρες", "Next 7 days"), subtitle: t(`${next7} συνταγές`, `${next7} prescriptions`), qs: `days=7&min_history=${minHistory}` })} />
          <KpiCard label={t("Επόμενες 30 ημέρες", "Next 30 days")} value={fmtNum(next30)} sub={t("συνταγές · δες λίστα", "prescriptions · see list")} icon={CalendarRange} accent="amber"
            onClick={() => setModal({ title: t("Επόμενες 30 ημέρες", "Next 30 days"), subtitle: t(`${next30} συνταγές`, `${next30} prescriptions`), qs: `days=30&min_history=${minHistory}` })} />
          <KpiCard
            label={t("Ημέρα αιχμής", "Peak day")}
            value={peak ? fmtNum(peak.count) : "—"}
            sub={peak ? t(`${fmtDate(peak.date)} · δες λίστα`, `${fmtDate(peak.date)} · see list`) : "—"}
            icon={Pill}
            accent="sky"
            onClick={peak ? () => setModal({ title: t(`Ημέρα αιχμής — ${fmtDate(peak.date)}`, `Peak day — ${fmtDate(peak.date)}`), subtitle: t(`${peak.count} συνταγές αναμένονται`, `${peak.count} prescriptions expected`), qs: `date=${peak.date}&min_history=${minHistory}` }) : undefined}
          />
        </div>

        {/* upcoming-by-day chart — click a day to see its prescriptions */}
        <PanelCard title={t("Συνταγές που ανοίγουν ανά ημέρα (30 ημέρες) — κλικ σε ημέρα για λίστα", "Prescriptions opening per day (30 days) — click a day for the list")}>
          <LineChart
            labels={days.map((d) => fmtDate(d.date))}
            data={days.map((d) => d.count)}
            name={t("Συνταγές", "Prescriptions")}
            height={300}
            onPointClick={(i) => {
              const d = days[i];
              if (d) setModal({ title: t(`Συνταγές — ${fmtDate(d.date)}`, `Prescriptions — ${fmtDate(d.date)}`), subtitle: t(`${d.count} συνταγές αναμένονται`, `${d.count} prescriptions expected`), qs: `date=${d.date}&min_history=${minHistory}` });
            }}
          />
        </PanelCard>

        {/* forecast table */}
        <PanelCard title={t("Πρόβλεψη ζήτησης ανά σκεύασμα (30 ημέρες)", "Demand forecast by product (30 days)")} bodyClassName="pt-2">
          <QueryState
            isLoading={forecast.isLoading}
            isError={forecast.isError}
            isEmpty={(forecast.data?.items?.length ?? 0) === 0}
            onRetry={() => forecast.refetch()}
          >
            <DataTable pageSize={20} columns={forecastColumns} rows={forecast.data?.items ?? []} rowKey={(r) => r.product_id} />
          </QueryState>
        </PanelCard>
      </div>

      {/* drill-down popup: the individual prescriptions behind a KPI */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.title} size="3xl">
        <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
          {modal && <p className="text-sm text-slate-500">{modal.subtitle}</p>}
          {(list.data?.items?.length ?? 0) > 0 && (
            <button
              onClick={() => downloadCsv("mellontikes-syntages", [
                { key: "expected_open_date", header: t("Αναμένεται", "Expected"), value: (r: FutureRx) => fmtDate(r.expected_open_date) },
                { key: "patient_name", header: t("Ασθενής", "Patient") },
                { key: "amka", header: "ΑΜΚΑ" },
                { key: "products", header: t("Σκευάσματα", "Products"), value: (r: FutureRx) => (r.products ?? []).filter(Boolean).join(" | ") },
                { key: "source_barcode", header: t("Από συνταγή", "From prescription") },
              ], list.data!.items)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> {t("Εξαγωγή CSV", "Export CSV")}
            </button>
          )}
        </div>
        <QueryState
          isLoading={list.isLoading}
          isError={list.isError}
          isEmpty={(list.data?.items?.length ?? 0) === 0}
          onRetry={() => list.refetch()}
          empty={t("Καμία αναμενόμενη συνταγή.", "No expected prescriptions.")}
        >
          <DataTable pageSize={15} columns={futureCols} rows={list.data?.items ?? []}
            rowKey={(r, i) => `${r.source_barcode}-${i}`} />
        </QueryState>
      </Modal>
    </ModuleGuard>
  );
}
