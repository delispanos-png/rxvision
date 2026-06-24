"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles, PackageSearch, Boxes, Wallet, TrendingUp } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtNum, fmtEur, fmtDate, fmtMoney} from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { InsightCard, type Insight } from "@/components/advisor/InsightCard";
import { CrossSellCard } from "@/components/advisor/CrossSellCard";

type Sug = {
  product_id: string; product_name: string; substance?: string | null;
  avg_daily: number; expected_demand: number; suggested_qty: number; est_cost: number; price_rising?: boolean;
};
type Upc = { expected_open_date: string; patient_name?: string | null; amka?: string | null; products?: (string | null)[]; source_barcode?: string | null };
type Xsell = { atc: string; class: string; sell: string; why: string; reach: number };
type OrderAdvice = {
  kpis: { items: number; qty: number; cost: number; rising: number };
  insights: Insight[];
  suggestions: Sug[];
  upcoming: Upc[];
  cross_sell: Xsell[];
};

type T = (el: string, en: string) => string;
const makeSugCols = (t: T): Column<Sug>[] => [
  { key: "product_name", header: t("Σκεύασμα", "Product"), render: (r) => (
      <span className="inline-flex items-center gap-1.5">{r.product_name || "—"}
        {r.price_rising && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">{t("ακριβαίνει", "rising")}</span>}
      </span>) },
  { key: "substance", header: t("Δραστική", "Active substance"), hideOnMobile: true, render: (r) => r.substance || "—" },
  { key: "avg_daily", header: t("Μ.Ο./ημέρα", "Avg/day"), align: "right", render: (r) => fmtNum(r.avg_daily), sortValue: (r) => r.avg_daily },
  { key: "suggested_qty", header: t("Πρόταση", "Suggestion"), align: "right", render: (r) => fmtNum(r.suggested_qty), sortValue: (r) => r.suggested_qty },
  { key: "est_cost", header: t("Εκτ. κόστος", "Est. cost"), align: "right", render: (r) => fmtEur(r.est_cost), sortValue: (r) => r.est_cost },
];
const makeUpcCols = (t: T): Column<Upc>[] => [
  { key: "expected_open_date", header: t("Αναμένεται", "Expected"), render: (r) => fmtDate(r.expected_open_date) },
  { key: "patient_name", header: t("Ασθενής", "Patient"), render: (r) => r.patient_name || "—" },
  { key: "products", header: t("Σκευάσματα", "Products"), render: (r) => (r.products ?? []).filter(Boolean).join(", ") || "—" },
];

export default function OrderAdvisorPage() {
  const t = useT();
  const sugCols = makeSugCols(t);
  const upcCols = makeUpcCols(t);
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
      <div className="mb-5 overflow-hidden rounded-2xl bg-gradient-to-br from-violet-700 via-brand-600 to-brand-600 p-5 text-white shadow-lg">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" /></span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/80">{t("AI · Πρόβλεψη ζήτησης", "AI · Demand forecast")}</span>
        </div>
        <h1 className="mt-1.5 flex items-center gap-2 text-2xl font-bold tracking-tight"><Sparkles className="h-6 w-6" /> {t("Σύμβουλος Παραγγελίας", "Order Advisor")}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/90">
          {data ? (t("el", "en") === "en"
            ? <>I estimated demand from recurring prescriptions & trends: <b>{fmtNum(k?.items ?? 0)}</b> products to order, <b>{fmtNum(k?.rising ?? 0)}</b> rising in price, and <b>{data.cross_sell?.length ?? 0}</b> OTC categories to stock.</>
            : <>Υπολόγισα τη ζήτηση από επαναλαμβανόμενες συνταγές & τάσεις: <b>{fmtNum(k?.items ?? 0)}</b> σκευάσματα προς παραγγελία, <b>{fmtNum(k?.rising ?? 0)}</b> που ακριβαίνουν, και <b>{data.cross_sell?.length ?? 0}</b> κατηγορίες παραφαρμάκου για στοκ.</>
          ) : t("Υπολογίζω την επερχόμενη ζήτηση…", "Estimating upcoming demand…")}
        </p>
      </div>

      {k && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label={t("Προτεινόμενα είδη", "Suggested items")} help={t("Είδη που προτείνονται για παραγγελία βάσει εκτελέσεων/πρόβλεψης.", "Items suggested for ordering.")} value={fmtNum(k.items)} sub={t("σκευάσματα", "products")} icon={PackageSearch} accent="indigo" />
          <KpiCard label={t("Συνολική ποσότητα", "Total quantity")} help={t("Συνολική ποσότητα τεμαχίων.", "Total quantity of units.")} value={fmtNum(k.qty)} sub={t("τεμάχια", "units")} icon={Boxes} accent="violet" />
          <KpiCard label={t("Εκτ. κόστος", "Est. cost")} help={t("Εκτιμώμενο κόστος χονδρικής της πρότασης παραγγελίας.", "Estimated wholesale cost of the order.")} value={fmtEur(k.cost)} sub={t("σύνολο πρότασης", "suggestion total")} icon={Wallet} accent="amber" />
          <KpiCard label={t("Ακριβαίνουν", "Rising in price")} help={t("Είδη με ανοδική τιμή χονδρικής.", "Items with rising wholesale price.")} value={fmtNum(k.rising)} sub={t("παράγγειλε νωρίς", "order early")} icon={TrendingUp} accent="rose" />
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{t("Έξυπνες προτάσεις", "Smart suggestions")}</h2>
      {isLoading ? <div className="text-slate-400">{t("Ανάλυση…", "Analyzing…")}</div> : (
        <div className="mb-5 grid gap-3 lg:grid-cols-2">
          {ins.map((i, idx) => <InsightCard key={idx} ins={i} />)}
        </div>
      )}

      {/* παραφάρμακα to stock for cross-sell */}
      {(data?.cross_sell?.length ?? 0) > 0 && (
        <div className="mb-5">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">{t("Παραφάρμακα για στοκ (συνοδευτική πώληση)", "OTC products to stock (cross-sell)")}</h2>
          <p className="mb-3 text-xs text-slate-400">{t("Με βάση τις θεραπείες των ασθενών σου — έχε τα διαθέσιμα για να κλείνεις την πώληση στο ταμείο.", "Based on your patients' therapies — keep them in stock to close the sale at the counter.")}</p>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {data!.cross_sell.map((x, idx) => <CrossSellCard key={idx} x={x} />)}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <PanelCard title={t("Λίστα παραγγελίας (αυτόματη πρόταση)", "Order list (automatic suggestion)")} bodyClassName="pt-2"
          action={<ExportMenu filename="protaseis-paraggelias" title={t("Προτάσεις παραγγελίας", "Order suggestions")} rows={sug} columns={[
            { key: "product_name", header: t("Σκεύασμα", "Product") }, { key: "substance", header: t("Δραστική", "Active substance"), value: (r) => r.substance || "—" },
            { key: "avg_daily", header: t("Μ.Ο./ημέρα", "Avg/day") }, { key: "suggested_qty", header: t("Πρόταση", "Suggestion") },
            { key: "est_cost", header: t("Εκτ. κόστος (€)", "Est. cost (€)"), value: (r) => fmtMoney((r.est_cost || 0)) },
          ]} />}>
          <DataTable pageSize={15} columns={sugCols} rows={sug} rowKey={(r) => r.product_id} empty={t("Καμία πρόταση.", "No suggestions.")} />
        </PanelCard>

        <PanelCard collapsible defaultOpen={false} title={t("Ασθενείς για υπενθύμιση (επερχόμενες συνταγές)", "Patients to remind (upcoming prescriptions)")} bodyClassName="pt-2">
          <DataTable pageSize={15} columns={upcCols} rows={upc} rowKey={(r, i) => `${r.source_barcode}-${i}`} empty={t("Καμία επερχόμενη συνταγή.", "No upcoming prescriptions.")} />
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
