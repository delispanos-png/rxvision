"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { InsightCard, type Insight } from "@/components/advisor/InsightCard";

type Kpi = { value: number; delta: number | null };
type Business = {
  period: { from: string; to: string };
  kpis: { revenue: Kpi; gross_profit: Kpi; margin_pct: Kpi; rx: Kpi; claimed: Kpi; patients: Kpi };
  insights: Insight[];
};

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);
const num = (n: number) => new Intl.NumberFormat("el-GR").format(n || 0);

function Delta({ delta, invert = false }: { delta: number | null; invert?: boolean }) {
  if (delta == null) return null;
  const good = invert ? delta <= 0 : delta >= 0;
  const Icon = delta >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${good ? "text-emerald-600" : "text-rose-600"}`}>
      <Icon className="h-3.5 w-3.5" /> {Math.abs(delta).toFixed(1)}%
    </span>
  );
}

function KpiTile({ label, value, delta, invert }: { label: string; value: string; delta: number | null; invert?: boolean }) {
  return (
    <div className="rx-card p-4">
      <div className="rx-label">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <div className="text-xl font-bold text-slate-900 sm:text-[22px]">{value}</div>
        <Delta delta={delta} invert={invert} />
      </div>
      <div className="mt-0.5 text-[11px] text-slate-400">vs προηγ. ίση περίοδος</div>
    </div>
  );
}

export default function BusinessAdvisorPage() {
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const { data, isLoading } = useQuery({
    queryKey: ["advisor", "business", q],
    queryFn: () => api<Business>(`/advisor/business?${q}`),
  });

  const k = data?.kpis;
  const ins = data?.insights ?? [];

  return (
    <ModuleGuard module="dashboard">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
            <Sparkles className="h-6 w-6 text-brand-600" /> Σύμβουλος Επιχείρησης
          </h1>
          <p className="mt-1 text-sm text-slate-500">Όλη η εικόνα & οι προτεραιότητες του φαρμακείου σε μία οθόνη.</p>
        </div>
        <DateRangeFilter />
      </div>

      {k && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <KpiTile label="Έσοδα" value={eur(k.revenue.value)} delta={k.revenue.delta} />
          <KpiTile label="Μεικτό κέρδος" value={eur(k.gross_profit.value)} delta={k.gross_profit.delta} />
          <KpiTile label="Περιθώριο" value={`${(k.margin_pct.value || 0).toFixed(1)}%`} delta={k.margin_pct.delta} />
          <KpiTile label="Συνταγές" value={num(k.rx.value)} delta={k.rx.delta} />
          <KpiTile label="Αιτούμενα" value={eur(k.claimed.value)} delta={k.claimed.delta} />
          <KpiTile label="Ασθενείς" value={num(k.patients.value)} delta={k.patients.delta} />
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Προτεραιότητες & προτάσεις</h2>
      {isLoading ? (
        <div className="text-slate-400">Ανάλυση…</div>
      ) : ins.length === 0 ? (
        <div className="rx-card p-8 text-center text-slate-400">Καμία ειδική ένδειξη — όλα ομαλά για την περίοδο. 👍</div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {ins.map((i, idx) => <InsightCard key={idx} ins={i} />)}
        </div>
      )}
    </ModuleGuard>
  );
}
