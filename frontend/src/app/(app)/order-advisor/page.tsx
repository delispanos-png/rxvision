"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles, PackageSearch, Boxes, Wallet, TrendingUp } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { InsightCard, type Insight } from "@/components/advisor/InsightCard";

type Sug = {
  product_id: string; product_name: string; substance?: string | null;
  avg_daily: number; expected_demand: number; suggested_qty: number; est_cost: number; price_rising?: boolean;
};
type Upc = { expected_open_date: string; patient_name?: string | null; amka?: string | null; products?: (string | null)[]; source_barcode?: string | null };
type OrderAdvice = {
  kpis: { items: number; qty: number; cost: number; rising: number };
  insights: Insight[];
  suggestions: Sug[];
  upcoming: Upc[];
};

const sugCols: Column<Sug>[] = [
  { key: "product_name", header: "Σκεύασμα", render: (r) => (
      <span className="inline-flex items-center gap-1.5">{r.product_name || "—"}
        {r.price_rising && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">ακριβαίνει</span>}
      </span>) },
  { key: "substance", header: "Δραστική", hideOnMobile: true, render: (r) => r.substance || "—" },
  { key: "avg_daily", header: "Μ.Ο./ημέρα", align: "right", render: (r) => fmtNum(r.avg_daily), sortValue: (r) => r.avg_daily },
  { key: "suggested_qty", header: "Πρόταση", align: "right", render: (r) => fmtNum(r.suggested_qty), sortValue: (r) => r.suggested_qty },
  { key: "est_cost", header: "Εκτ. κόστος", align: "right", render: (r) => fmtEur(r.est_cost), sortValue: (r) => r.est_cost },
];
const upcCols: Column<Upc>[] = [
  { key: "expected_open_date", header: "Αναμένεται", render: (r) => fmtDate(r.expected_open_date) },
  { key: "patient_name", header: "Ασθενής", render: (r) => r.patient_name || "—" },
  { key: "products", header: "Σκευάσματα", render: (r) => (r.products ?? []).filter(Boolean).join(", ") || "—" },
];

export default function OrderAdvisorPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["advisor", "orders"],
    queryFn: () => api<OrderAdvice>(`/advisor/orders?lead_days=7`),
  });

  const k = data?.kpis;
  const ins = data?.insights ?? [];
  const sug = data?.suggestions ?? [];
  const upc = data?.upcoming ?? [];

  return (
    <ModuleGuard module="order_suggestions">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
          <Sparkles className="h-6 w-6 text-brand-600" /> Σύμβουλος Παραγγελίας
        </h1>
        <p className="mt-1 text-sm text-slate-500">Έξυπνες προτάσεις αναπλήρωσης — βάσει ζήτησης, επαναλήψεων & αλλαγών τιμών.</p>
      </div>

      {k && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Προτεινόμενα είδη" value={fmtNum(k.items)} sub="σκευάσματα" icon={PackageSearch} accent="indigo" />
          <KpiCard label="Συνολική ποσότητα" value={fmtNum(k.qty)} sub="τεμάχια" icon={Boxes} accent="violet" />
          <KpiCard label="Εκτ. κόστος" value={fmtEur(k.cost)} sub="σύνολο πρότασης" icon={Wallet} accent="amber" />
          <KpiCard label="Ακριβαίνουν" value={fmtNum(k.rising)} sub="παράγγειλε νωρίς" icon={TrendingUp} accent="rose" />
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Έξυπνες προτάσεις</h2>
      {isLoading ? <div className="text-slate-400">Ανάλυση…</div> : (
        <div className="mb-5 grid gap-3 lg:grid-cols-2">
          {ins.map((i, idx) => <InsightCard key={idx} ins={i} />)}
        </div>
      )}

      <div className="space-y-4">
        <PanelCard title="Λίστα παραγγελίας (αυτόματη πρόταση)" bodyClassName="pt-2"
          action={<ExportMenu filename="protaseis-paraggelias" title="Προτάσεις παραγγελίας" rows={sug} columns={[
            { key: "product_name", header: "Σκεύασμα" }, { key: "substance", header: "Δραστική", value: (r) => r.substance || "—" },
            { key: "avg_daily", header: "Μ.Ο./ημέρα" }, { key: "suggested_qty", header: "Πρόταση" },
            { key: "est_cost", header: "Εκτ. κόστος (€)", value: (r) => ((r.est_cost || 0) / 100).toFixed(2) },
          ]} />}>
          <DataTable pageSize={15} columns={sugCols} rows={sug} rowKey={(r) => r.product_id} empty="Καμία πρόταση." />
        </PanelCard>

        <PanelCard collapsible defaultOpen={false} title="Ασθενείς για υπενθύμιση (επερχόμενες συνταγές)" bodyClassName="pt-2">
          <DataTable pageSize={15} columns={upcCols} rows={upc} rowKey={(r, i) => `${r.source_barcode}-${i}`} empty="Καμία επερχόμενη συνταγή." />
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
