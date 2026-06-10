"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { InsightCard, type Insight } from "@/components/advisor/InsightCard";
import { CrossSellCard } from "@/components/advisor/CrossSellCard";

type Kpi = { value: number; delta: number | null };
type Cat = { code: string; name: string; revenue: number; gross_profit: number; margin_pct: number; units: number; rx: number; share_pct: number; trend_pct: number | null; verdict: string };
type Xsell = { atc: string; class: string; sell: string; why: string; reach: number };
type Business = {
  period: { from: string; to: string };
  kpis: { revenue: Kpi; gross_profit: Kpi; margin_pct: Kpi; rx: Kpi; claimed: Kpi; patients: Kpi };
  insights: Insight[];
  categories: Cat[];
  cross_sell: Xsell[];
};

const VERDICT: Record<string, { label: string; cls: string }> = {
  focus: { label: "🟢 Εστίασε", cls: "bg-emerald-100 text-emerald-700" },
  maintain: { label: "🟡 Διατήρησε", cls: "bg-amber-100 text-amber-700" },
  divest: { label: "🔴 Μη επενδύεις", cls: "bg-rose-100 text-rose-700" },
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
      <div className="mb-4 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-brand-600 to-violet-700 p-5 text-white shadow-lg">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" /></span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/80">AI · Ζωντανή ανάλυση</span>
        </div>
        <h1 className="mt-1.5 flex items-center gap-2 text-2xl font-bold tracking-tight"><Sparkles className="h-6 w-6" /> Σύμβουλος Επιχείρησης</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/90">
          {data ? <>Σάρωσα <b>{num(k?.rx.value ?? 0)}</b> συνταγές & <b>{num(k?.patients.value ?? 0)}</b> ασθενείς σε <b>{data.categories.length}</b> θεραπευτικές κατηγορίες. Εντόπισα <b>{ins.length}</b> προτεραιότητες και <b>{data.cross_sell.length}</b> ευκαιρίες συνοδευτικής πώλησης για σένα.</> : "Επεξεργάζομαι τα δεδομένα του φαρμακείου σου…"}
        </p>
      </div>
      <div className="mb-5"><DateRangeFilter /></div>

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
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {ins.map((i, idx) => <InsightCard key={idx} ins={i} />)}
        </div>
      )}

      {/* therapeutic-category turnover & verdict */}
      {(data?.categories?.length ?? 0) > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Θεραπευτικές κατηγορίες — πού να εστιάσεις</h2>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-card">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr><th className="px-4 py-3">Κατηγορία (ATC)</th><th className="px-4 py-3 text-right">Τζίρος</th><th className="px-4 py-3 text-right">Μερίδιο</th><th className="px-4 py-3 text-right">Περιθώριο</th><th className="px-4 py-3 text-right">Τάση</th><th className="px-4 py-3">Ετυμηγορία</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.categories.map((c) => (
                  <tr key={c.code}>
                    <td className="px-4 py-3 font-medium text-slate-800">{c.name} <span className="text-[10px] text-slate-400">{c.code}</span></td>
                    <td className="px-4 py-3 text-right">{eur(c.revenue)}</td>
                    <td className="px-4 py-3 text-right text-slate-500">{c.share_pct.toFixed(0)}%</td>
                    <td className="px-4 py-3 text-right">{c.margin_pct.toFixed(0)}%</td>
                    <td className={`px-4 py-3 text-right font-medium ${(c.trend_pct ?? 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{c.trend_pct == null ? "—" : `${c.trend_pct >= 0 ? "+" : ""}${c.trend_pct.toFixed(0)}%`}</td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${VERDICT[c.verdict]?.cls}`}>{VERDICT[c.verdict]?.label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* cross-sell opportunities */}
      {(data?.cross_sell?.length ?? 0) > 0 && (
        <div className="mt-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">Ευκαιρίες συνοδευτικής πώλησης</h2>
          <p className="mb-3 text-xs text-slate-400">Βάσει των θεραπευτικών κατηγοριών στις οποίες ανήκουν οι ασθενείς σου — λογικές, αιτιολογημένες προτάσεις παραφαρμάκου.</p>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {data!.cross_sell.map((x, idx) => <CrossSellCard key={idx} x={x} />)}
          </div>
        </div>
      )}
    </ModuleGuard>
  );
}
