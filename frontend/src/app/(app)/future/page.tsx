"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, CalendarDays, CalendarRange, Pill, Download, PackageCheck, Users, ChevronDown, ChevronUp, X, HeartPulse } from "lucide-react";
import { api } from "@/lib/apiClient";
import { downloadCsv } from "@/lib/csv";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";
import { fmtNum, fmtDate, fmtEur } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { LineChart } from "@/components/charts/LineChart";

type UpcomingDay = { date: string; count: number };
type FutureRx = {
  expected_open_date: string; patient_name?: string | null; amka?: string | null;
  source_barcode?: string | null; products?: (string | null)[]; n_items?: number; confidence?: number; chronic?: boolean | null;
};
type CoverageItem = {
  product_id: string; product_name?: string | null; substance?: string | null;
  needed_qty: number; n_patients: number; prescriptions: number; avg_daily: number; est_cost: number;
};
type Coverage = {
  date: string;
  summary: { prescriptions: number; chronic: number; n_patients: number; products: number; total_units: number; est_cost: number };
  items: CoverageItem[];
};
// Calendar date n days from now in Europe/Athens (YYYY-MM-DD). MUST be Athens-local, not UTC:
// the server groups the chart and filters the list by Europe/Athens days, so a UTC date near
// midnight would point the KPI/list at the wrong bucket. (en-CA formats as YYYY-MM-DD.)
const _iso = (n: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(new Date(Date.now() + n * 86400000));
type Period = "today" | "tomorrow" | "day_after" | "week" | "custom";
function periodRange(p: Period, cf: string, ct: string): { from: string; to: string } {
  if (p === "today") return { from: _iso(0), to: _iso(0) };
  if (p === "tomorrow") return { from: _iso(1), to: _iso(1) };
  if (p === "day_after") return { from: _iso(2), to: _iso(2) };
  if (p === "week") {
    const dow = (new Date(_iso(0) + "T00:00:00").getDay() + 6) % 7;   // 0=Δευτέρα (Athens week)
    return { from: _iso(-dow), to: _iso(6 - dow) };
  }
  return { from: cf, to: ct };
}

export default function FuturePage() {
  const t = useT();
  const [minHistory] = useState("0");
  const [tab, setTab] = useState<"coverage" | "forecast">("coverage");
  const [period, setPeriod] = useState<Period>("tomorrow");
  const [cFrom, setCFrom] = useState(_iso(0));
  const [cTo, setCTo] = useState(_iso(6));
  const range = periodRange(period, cFrom, cTo);
  const [modal, setModal] = useState<{ title: string; subtitle: string; qs: string } | null>(null);
  const [expandedRx, setExpandedRx] = useState<string | null>(null);

  const coverage = useQuery({
    queryKey: ["future", "daily-coverage", range.from, range.to],
    queryFn: () => api<Coverage>(`/future/daily-coverage?from=${range.from}&to=${range.to}`),
  });
  const cov = coverage.data;
  const covCols: Column<CoverageItem>[] = [
    { key: "product_name", header: t("Φάρμακο", "Product"), render: (r) => r.product_name ?? r.product_id },
    { key: "needed_qty", header: t("Ποσότητα", "Qty"), align: "right", render: (r) => <span className="font-semibold">{fmtNum(r.needed_qty)}</span> },
    { key: "n_patients", header: t("Ασθενείς", "Patients"), align: "right", render: (r) => fmtNum(r.n_patients) },
    { key: "avg_daily", header: t("Μ.Ο./μέρα", "Avg/day"), align: "right", hideOnMobile: true, render: (r) => r.avg_daily },
    { key: "est_cost", header: t("Εκτ. κόστος", "Est. cost"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.est_cost) },
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

  const days = upcoming.data?.items ?? [];
  const total = days.reduce((s, d) => s + d.count, 0);     // 30-day total
  const todayStr = _iso(0), tomorrowStr = _iso(1), wkEnd = _iso(6);
  const todayCount = days.find((d) => d.date === todayStr)?.count ?? 0;
  const tomorrowCount = days.find((d) => d.date === tomorrowStr)?.count ?? 0;
  const next7 = days.filter((d) => d.date <= wkEnd).reduce((s, d) => s + d.count, 0);

  return (
    <ModuleGuard module="future_prescriptions">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Μελλοντικές συνταγές", "Upcoming prescriptions")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Πρόβλεψη επαναλαμβανόμενης ζήτησης τις επόμενες 30 ημέρες", "Forecast of recurring demand over the next 30 days")}</p>
        </div>
      </div>

      {/* δύο ξεχωριστές όψεις στο ίδιο κύκλωμα */}
      <div className="mb-4 inline-flex rounded-xl border border-slate-200 bg-white p-1">
        {([
          ["coverage", t("Κάλυψη περιόδου", "Period coverage")],
          ["forecast", t("Πρόβλεψη ζήτησης", "Demand forecast")],
        ] as ["coverage" | "forecast", string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${tab === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {/* TAB 1 — Κάλυψη: τι να έχεις/παραγγείλεις για τις συνταγές που ανοίγουν */}
        {tab === "coverage" && (
        <PanelCard
          title={t("Κάλυψη περιόδου — ποσότητες για τις συνταγές που ανοίγουν", "Period coverage — quantities for opening prescriptions")}
          bodyClassName="pt-2"
        >
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-wrap gap-1.5">
                {([
                  ["today", t("Σήμερα", "Today")],
                  ["tomorrow", t("Αύριο", "Tomorrow")],
                  ["day_after", t("Μεθαύριο", "Day after")],
                  ["week", t("Εβδομάδα", "This week")],
                  ["custom", t("Προσαρμοσμένο", "Custom")],
                ] as [Period, string][]).map(([p, label]) => (
                  <button key={p} onClick={() => setPeriod(p)}
                    className={`rounded-lg border px-3 py-2 text-sm ${period === p ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                    {label}
                  </button>
                ))}
              </div>
              {period === "custom" && (
                <div className="flex items-end gap-2">
                  <label className="block text-sm"><span className="mb-1 block text-slate-600">{t("Από", "From")}</span>
                    <DateInput value={cFrom} onChange={(v) => setCFrom(v || _iso(0))} /></label>
                  <label className="block text-sm"><span className="mb-1 block text-slate-600">{t("Έως", "To")}</span>
                    <DateInput value={cTo} onChange={(v) => setCTo(v || _iso(6))} /></label>
                </div>
              )}
            </div>
            {(cov?.items?.length ?? 0) > 0 && (
              <button
                onClick={() => downloadCsv(`kalypsi-${range.from}_${range.to}`, [
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
          <div className="mb-2 text-xs text-slate-500">
            {t("Περίοδος", "Period")}: <b>{fmtDate(range.from)}</b>{range.from !== range.to && <> → <b>{fmtDate(range.to)}</b></>}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard label={t("Συνταγές", "Prescriptions")} value={fmtNum(cov?.summary.prescriptions ?? 0)} icon={CalendarDays} accent="indigo" />
            <KpiCard label={t("Χρόνια αγωγή", "Chronic")} value={fmtNum(cov?.summary.chronic ?? 0)}
              sub={t(`μη χρόνιες: ${fmtNum((cov?.summary.prescriptions ?? 0) - (cov?.summary.chronic ?? 0))}`, `non-chronic: ${fmtNum((cov?.summary.prescriptions ?? 0) - (cov?.summary.chronic ?? 0))}`)}
              icon={HeartPulse} accent="rose" />
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
        )}

        {/* TAB 2 — Πρόβλεψη ζήτησης (30 ημέρες): KPIs + χάρτης + ανά σκεύασμα */}
        {tab === "forecast" && (<>
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label={t("Σήμερα", "Today")} value={fmtNum(todayCount)} sub={t(`${fmtDate(todayStr)} · δες λίστα`, `${fmtDate(todayStr)} · see list`)} icon={CalendarClock} accent="indigo"
            onClick={() => setModal({ title: t(`Σήμερα — ${fmtDate(todayStr)}`, `Today — ${fmtDate(todayStr)}`), subtitle: t(`${todayCount} συνταγές ανοίγουν σήμερα`, `${todayCount} prescriptions open today`), qs: `date=${todayStr}&min_history=${minHistory}` })} />
          <KpiCard label={t("Αύριο", "Tomorrow")} value={fmtNum(tomorrowCount)} sub={t(`${fmtDate(tomorrowStr)} · δες λίστα`, `${fmtDate(tomorrowStr)} · see list`)} icon={CalendarDays} accent="violet"
            onClick={() => setModal({ title: t(`Αύριο — ${fmtDate(tomorrowStr)}`, `Tomorrow — ${fmtDate(tomorrowStr)}`), subtitle: t(`${tomorrowCount} συνταγές ανοίγουν αύριο`, `${tomorrowCount} prescriptions open tomorrow`), qs: `date=${tomorrowStr}&min_history=${minHistory}` })} />
          <KpiCard label={t("Επόμενες 7 ημέρες", "Next 7 days")} value={fmtNum(next7)} sub={t("συνταγές · δες λίστα", "prescriptions · see list")} icon={CalendarRange} accent="amber"
            onClick={() => setModal({ title: t("Επόμενες 7 ημέρες", "Next 7 days"), subtitle: t(`${next7} συνταγές`, `${next7} prescriptions`), qs: `days=7&min_history=${minHistory}` })} />
          <KpiCard label={t("Επόμενες 30 ημέρες", "Next 30 days")} value={fmtNum(total)} sub={t("συνταγές · δες λίστα", "prescriptions · see list")} icon={Pill} accent="sky"
            onClick={() => setModal({ title: t("Επόμενες 30 ημέρες", "Next 30 days"), subtitle: t(`${total} συνταγές`, `${total} prescriptions`), qs: `days=30&min_history=${minHistory}` })} />
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

        {/* inline drill-down — η λίστα της επιλεγμένης ημέρας/περιόδου: αρ. συνταγής + πελάτης,
            κλικ σε γραμμή για να δεις τι περιλαμβάνει η συνταγή */}
        {modal && (
          <PanelCard title={modal.title} bodyClassName="pt-2">
            <div className="-mt-1 mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-500">{modal.subtitle}</p>
              <div className="flex shrink-0 items-center gap-2">
                {(list.data?.items?.length ?? 0) > 0 && (
                  <button onClick={() => downloadCsv("syntages-imeras", [
                    { key: "source_barcode", header: t("Αρ. συνταγής", "Rx number") },
                    { key: "patient_name", header: t("Πελάτης", "Patient") },
                    { key: "expected_open_date", header: t("Αναμένεται", "Expected"), value: (r: FutureRx) => fmtDate(r.expected_open_date) },
                    { key: "products", header: t("Σκευάσματα", "Products"), value: (r: FutureRx) => (r.products ?? []).filter(Boolean).join(" | ") },
                  ], list.data!.items)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                    <Download className="h-3.5 w-3.5" /> {t("Εξαγωγή CSV", "Export CSV")}
                  </button>
                )}
                <button onClick={() => setModal(null)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                  <X className="h-3.5 w-3.5" /> {t("Κλείσιμο", "Close")}
                </button>
              </div>
            </div>
            <QueryState isLoading={list.isLoading} isError={list.isError}
              isEmpty={(list.data?.items?.length ?? 0) === 0} onRetry={() => list.refetch()}
              empty={t("Καμία αναμενόμενη συνταγή.", "No expected prescriptions.")}>
              <ul className="divide-y divide-slate-200">
                {(list.data?.items ?? []).map((r, i) => {
                  const key = `${r.source_barcode}-${i}`;
                  const open = expandedRx === key;
                  const meds = (r.products ?? []).filter(Boolean);
                  return (
                    <li key={key}>
                      <button onClick={() => setExpandedRx(open ? null : key)}
                        className="flex w-full items-center justify-between gap-3 py-2.5 text-left text-sm hover:bg-slate-50">
                        <span className="flex min-w-0 items-center gap-2">
                          {r.chronic ? <Tooltip label={t("Χρόνια αγωγή", "Chronic therapy")}><HeartPulse className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label={t("Χρόνια αγωγή", "Chronic therapy")} /></Tooltip> : null}
                          <span className="font-mono font-semibold text-slate-800">#{r.source_barcode ?? "—"}</span>
                          <span className="truncate text-slate-600">{r.patient_name || "—"}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                          {fmtDate(r.expected_open_date)} · {meds.length || r.n_items || 0} {t("είδη", "items")}
                          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </span>
                      </button>
                      {open && (
                        <div className="bg-slate-50/60 px-3 pb-3 pt-1">
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("Περιλαμβάνει", "Includes")}</div>
                          {meds.length ? (
                            <ul className="space-y-1">
                              {meds.map((p, j) => (
                                <li key={j} className="flex items-center gap-2 text-sm text-slate-700">
                                  <Pill className="h-4 w-4 shrink-0 text-indigo-500" /> {p}
                                </li>
                              ))}
                            </ul>
                          ) : <div className="text-xs text-slate-400">—</div>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </QueryState>
          </PanelCard>
        )}

        </>)}
      </div>
    </ModuleGuard>
  );
}
