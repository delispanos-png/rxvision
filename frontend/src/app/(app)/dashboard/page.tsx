"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 as BarIcon, Receipt, TrendingUp, Users, Wallet } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { DateInput } from "@/components/ui/DateInput";
import { LineChart } from "@/components/charts/LineChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { BarChart } from "@/components/charts/BarChart";
import { HeatmapChart, type HeatCell } from "@/components/charts/HeatmapChart";

type Summary = { executions: number; value: number; claimed: number; gross_profit: number; patient_count: number };
type Bucket = { bucket: string; value: number };
type HeatPoint = { dow: number; hour: number; value: number };
type Top = { _id?: string; name?: string; rx?: number; value?: number };
type Rx = { external_id: string; amount_total: number; executed_at: string; source: string };

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);
const eur2 = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const num = (n: number) => new Intl.NumberFormat("el-GR").format(n || 0);

const GREETING = () => {
  const h = new Date().getHours();
  return h < 12 ? "Καλημέρα" : h < 18 ? "Καλησπέρα" : "Καλό βράδυ";
};

export default function DashboardPage() {
  // Date range filter — defaults to year-to-date so the full year's data is visible.
  const [fromD, setFromD] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [toD, setToD] = useState(() => new Date().toISOString().slice(0, 10));
  const from = new Date(`${fromD}T00:00:00.000Z`).toISOString();
  const to = new Date(`${toD}T23:59:59.999Z`).toISOString();
  const qs = `date_from=${from}&date_to=${to}`;

  const summary = useQuery({ queryKey: ["dash", "summary", from, to], queryFn: () => api<Summary>(`/dashboard/summary?${qs}`) });
  const tsVal = useQuery({ queryKey: ["dash", "ts", "value", from, to], queryFn: () => api<Bucket[]>(`/dashboard/timeseries?metric=value&grain=day&${qs}`) });
  const tsClaim = useQuery({ queryKey: ["dash", "ts", "claimed", from, to], queryFn: () => api<Bucket[]>(`/dashboard/timeseries?metric=claimed&grain=day&${qs}`) });
  const topIcd = useQuery({ queryKey: ["dash", "icd", from, to], queryFn: () => api<Top[]>(`/dashboard/top?dim=icd10&limit=6&${qs}`) });
  const topDoc = useQuery({ queryKey: ["dash", "doc", from, to], queryFn: () => api<Top[]>(`/dashboard/top?dim=doctors&limit=6&${qs}`) });
  const recent = useQuery({ queryKey: ["dash", "recent", from, to], queryFn: () => api<{ items: Rx[] }>(`/prescriptions?${qs}&page=1&page_size=6`) });
  const heat = useQuery({ queryKey: ["dash", "heat", from, to], queryFn: () => api<HeatPoint[]>(`/dashboard/heatmap?metric=executions&${qs}`) });

  // {dow:1-7, hour:0-23} → [hourIdx, dowIdx(0=Δευ), value]
  const heatCells: HeatCell[] = (heat.data ?? []).map((p) => [p.hour, p.dow - 1, p.value]);

  const s = summary.data;
  const labels = (tsVal.data ?? []).map((b) => b.bucket.slice(5)); // MM-DD
  const valSeries = (tsVal.data ?? []).map((b) => Math.round((b.value || 0) / 100));
  const claimSeries = (tsClaim.data ?? []).map((b) => Math.round((b.value || 0) / 100));

  const dateLabel = new Date().toLocaleDateString("el-GR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <ModuleGuard module="dashboard">
      {/* header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{GREETING()}! 👋</h1>
          <p className="mt-1 text-sm text-slate-500">Επισκόπηση φαρμακείου — {dateLabel}</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-slate-500">Από
            <DateInput value={fromD} onChange={setFromD} className="mt-1" />
          </label>
          <label className="text-xs text-slate-500">Έως
            <DateInput value={toD} onChange={setToD} className="mt-1" />
          </label>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Εκτελέσεις" value={num(s?.executions ?? 0)} sub="συνταγές περιόδου" icon={Receipt} accent="indigo" />
        <KpiCard label="Αξία συνταγών" value={eur(s?.value ?? 0)} sub="σύνολο περιόδου" icon={BarIcon} accent="violet" />
        <KpiCard label="Αιτούμενα ταμείων" value={eur(s?.claimed ?? 0)} sub="προς ασφ. φορείς" icon={Wallet} accent="amber" />
        <KpiCard label="Μεικτό κέρδος" value={eur(s?.gross_profit ?? 0)} sub="αιτούμενο − χονδρική" icon={TrendingUp} accent="green" />
        <KpiCard label="Ασφαλισμένοι" value={num(s?.patient_count ?? 0)} sub="μοναδικοί" icon={Users} accent="sky" />
      </div>

      {/* charts row */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title="Πορεία Αξίας & Αιτούμενων" className="lg:col-span-2">
          <LineChart
            labels={labels}
            series={[
              { name: "Αξία (€)", data: valSeries },
              { name: "Αιτούμενα (€)", data: claimSeries },
            ]}
            height={300}
          />
        </PanelCard>
        <PanelCard title="Ανάλυση ανά ICD-10">
          <DonutChart
            height={300}
            data={(topIcd.data ?? []).map((d) => ({ name: d._id || "—", value: d.rx || 0 }))}
          />
        </PanelCard>
      </div>

      {/* bottom row */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title="Top Ιατροί (αξία)" className="lg:col-span-2">
          <BarChart
            horizontal
            height={300}
            labels={(topDoc.data ?? []).map((d) => d.name || "—")}
            data={(topDoc.data ?? []).map((d) => Math.round((d.value || 0) / 100))}
            name="€"
          />
        </PanelCard>
        <PanelCard title="Πρόσφατες Συνταγές" bodyClassName="pt-2">
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
              <li className="py-8 text-center text-sm text-slate-400">Δεν υπάρχουν</li>
            )}
          </ul>
        </PanelCard>
      </div>

      {/* busy-hours heatmap */}
      <div className="mt-4">
        <PanelCard title="Ώρες αιχμής — εκτελέσεις ανά ώρα & ημέρα">
          <HeatmapChart cells={heatCells} />
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
