"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { TrendingUp, Percent, Coins, Scissors, Layers, Info } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtDec, fmtEur, fmtPct, fmtNum, fmtMoney} from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { SelectFilter } from "@/components/filters/SelectFilter";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { ExportMenu } from "@/components/export/ExportMenu";
import { AttentionMap } from "@/components/profitability/AttentionMap";

type Summary = {
  revenue: number; // cents — ΧΩΡΙΣ ΦΠΑ (services/vat.py)
  amount_total?: number; // cents — με ΦΠΑ
  cost: number; // cents
  gross_profit: number; // cents
  margin_pct: number;
  estimated_cost_pct?: number; // % του κόστους που είναι ΕΚΤΙΜΗΣΗ (όχι πραγματική χονδρική)
  fund_cuts?: number;          // cents — περικοπές ταμείων σε εξοφλημένους μήνες της περιόδου
  net_profit?: number;         // cents — μεικτό − περικοπές
  cut_months_settled?: number;
};

type AgingBucket = { bucket: string; open: number; months: number };
type Aging = { buckets: AgingBucket[]; total_open: number; overdue_open: number; payments_recorded: boolean; tracking_from?: string | null; untracked_claimed?: number };

type ByRow = { label: string; gross_profit: number; margin_pct: number };
type CategoryRow = {
  label: string;
  units: number;
  value: number;        // cents — έσοδα (λιανική)
  gross_profit: number; // cents
  margin_pct: number;
};
type LowMarginRow = {
  product_id: string;
  product_name: string;
  units: number;
  margin_pct: number;
  gross_profit: number; // cents
  retail_price?: number;      // cents — λιανική/τεμάχιο
  wholesale_price?: number;   // cents — χονδρική/τεμάχιο
  wholesale_source?: string;  // real | masterdata | estimated | unavailable
};

export default function ProfitabilityPage() {
  const t = useT();
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const [dim, setDim] = useState("fund");

  const DIMS = [
    { value: "fund", label: t("Ταμείο", "Insurance fund") },
    { value: "doctor", label: t("Ιατρός", "Doctor") },
    { value: "icd10", label: "ICD-10" },
    { value: "product", label: t("Σκεύασμα", "Product") },
    // ΟΧΙ «Κατηγορία»: αυτό είναι κανονικό/ναρκωτικό/γαληνικό. Η ΘΕΡΑΠΕΥΤΙΚΗ κατηγορία έχει δικό της
    // πάνελ πιο κάτω — ίδια λέξη για δύο διαφορετικά πράγματα μπέρδευε.
    { value: "type", label: t("Τύπος σκευάσματος", "Product type") },
  ];

  const lowMarginColumns: Column<LowMarginRow>[] = [
    { key: "product_name", header: t("Σκεύασμα", "Product") },
    { key: "units", header: t("Τεμάχια", "Units"), align: "right", render: (r) => fmtNum(r.units) },
    { key: "wholesale_price", header: t("Χονδρική", "Wholesale"), align: "right", render: (r) => r.wholesale_price ? `${fmtEur(r.wholesale_price)}${r.wholesale_source === "estimated" ? " ~" : ""}` : "—" },
    { key: "retail_price", header: t("Λιανική", "Retail"), align: "right", render: (r) => r.retail_price ? fmtEur(r.retail_price) : "—" },
    { key: "margin_pct", header: t("Περιθώριο", "Margin"), align: "right", render: (r) => fmtPct(r.margin_pct) },
    { key: "gross_profit", header: t("Κέρδος", "Profit"), align: "right", render: (r) => fmtEur(r.gross_profit) },
  ];

  const summary = useQuery({
    queryKey: ["profitability", "summary", q],
    queryFn: () => api<Summary>(`/profitability/summary?${q}`),
  });
  const pr = prevYearRange(filters.dateFrom, filters.dateTo);
  const prevSummary = useQuery({
    queryKey: ["profitability", "summary", "prevYear", pr?.from, pr?.to],
    queryFn: () => api<Summary>(`/profitability/summary?${filtersToQuery({...filters, dateFrom: pr!.from, dateTo: pr!.to })}`),
    enabled: !!pr,
  });

  const byDim = useQuery({
    queryKey: ["profitability", "by", dim, q],
    queryFn: () => api<{ rows: ByRow[] }>(`/profitability/by?dim=${dim}&${q}`),
  });

  const byCategory = useQuery({
    queryKey: ["profitability", "by-category", q],
    queryFn: () => api<{ rows: CategoryRow[] }>(`/profitability/by-category?${q}`),
  });

  const lowMargin = useQuery({
    queryKey: ["profitability", "low-margin", 10, q],
    queryFn: () => api<{ items: LowMarginRow[] }>(`/profitability/low-margin?threshold_pct=10&${q}`),
  });

  const aging = useQuery({
    queryKey: ["profitability", "aging"],
    queryFn: () => api<Aging>(`/profitability/aging`),
  });

  const s = summary.data;
  const p = prevSummary.data;
  const rows = byDim.data?.rows ?? [];
  const ag = aging.data;
  const lowItems = lowMargin.data?.items ?? [];
  const catRows = byCategory.data?.rows ?? [];
  const topCat = catRows[0];

  const categoryColumns: Column<CategoryRow>[] = [
    { key: "label", header: t("Κατηγορία", "Category") },
    { key: "units", header: t("Τεμάχια", "Units"), align: "right", render: (r) => fmtNum(r.units) },
    { key: "value", header: t("Έσοδα χωρίς ΦΠΑ", "Revenue excl. VAT"), align: "right", render: (r) => fmtEur(r.value) },
    { key: "gross_profit", header: t("Κέρδος", "Profit"), align: "right", render: (r) => fmtEur(r.gross_profit) },
    { key: "margin_pct", header: t("Περιθώριο", "Margin"), align: "right", render: (r) => fmtPct(r.margin_pct) },
  ];

  return (
    <ModuleGuard module="profitability">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Κερδοφορία", "Profitability")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Μεικτό κέρδος, περιθώρια & ταμειακή ροή", "Gross profit, margins & cash flow")}</p>
        </div>
        <ExportMenu filename={`kerdoforia-${dim}`} title={t("Κερδοφορία ανά διάσταση", "Profitability by dimension")} rows={byDim.data?.rows ?? []} columns={[
          { key: "label", header: t("Διάσταση", "Dimension") },
          { key: "gross_profit", header: t("Μεικτό κέρδος (€)", "Gross profit (€)"), value: (r) => fmtMoney((r.gross_profit || 0)) },
          { key: "margin_pct", header: t("Περιθώριο %", "Margin %"), value: (r) => fmtDec(r.margin_pct ?? 0, 1) },
        ]} />
      </div>

      <div className="mb-4"><DateRangeFilter /></div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <KpiCard label={t("Μεικτό κέρδος", "Gross profit")} help={t("Λιανική αξία των φαρμάκων που δόθηκαν ΧΩΡΙΣ ΦΠΑ − κόστος χονδρικής τους (η χονδρική είναι ήδη χωρίς ΦΠΑ, ο ΦΠΑ της λιανικής αποδίδεται στο κράτος). Ακυρωμένες εκτελέσεις και όσες εξαίρεσες από τα στατιστικά δεν μετρούν.", "Retail value of what was dispensed EXCLUDING VAT − its wholesale cost (wholesale is already excl. VAT; retail VAT goes to the state). Cancelled executions and those you excluded from statistics do not count.")} value={s ? fmtEur(s.gross_profit) : "—"} sub={t("λιανική χωρίς ΦΠΑ − χονδρική", "retail excl. VAT − wholesale")} icon={TrendingUp} accent="green" trend={pctDelta(s?.gross_profit, p?.gross_profit)} />
          <KpiCard label={t("Περιθώριο", "Margin")} help={t("Περιθώριο κέρδους = μεικτό κέρδος / λιανική αξία χωρίς ΦΠΑ.", "Margin = gross profit / retail value excl. VAT.")} value={s ? fmtPct(s.margin_pct) : "—"} sub={t("μεικτό περιθώριο", "gross margin")} icon={Percent} accent="violet" trend={pctDelta(s?.margin_pct, p?.margin_pct)} />
          <KpiCard label={t("Έσοδα χωρίς ΦΠΑ", "Revenue excl. VAT")} help={t("Λιανική αξία των φαρμάκων που δόθηκαν, χωρίς τον ΦΠΑ (φάρμακα 6%). Η αξία με ΦΠΑ φαίνεται από κάτω.", "Retail value of what was dispensed, excluding VAT (medicines 6%). The value incl. VAT is shown below.")} value={s ? fmtEur(s.revenue) : "—"} sub={s?.amount_total != null ? t(`με ΦΠΑ ${fmtEur(s.amount_total)}`, `incl. VAT ${fmtEur(s.amount_total)}`) : t("σύνολο περιόδου", "period total")} icon={Coins} accent="amber" trend={pctDelta(s?.revenue, p?.revenue)} />
          <KpiCard
            label={t("Κορυφαία κατηγορία", "Top category")}
            help={t("Θεραπευτική κατηγορία (βάσει ATC) με το μεγαλύτερο μεικτό κέρδος στην περίοδο.", "Therapeutic category (by ATC) with the highest gross profit in the period.")}
            value={topCat ? fmtEur(topCat.gross_profit) : "—"}
            sub={topCat ? topCat.label : t("κέρδος ανά κατηγορία", "profit by category")}
            icon={Layers}
            accent="sky"
          />
          <KpiCard
            label={t("Περικοπές ταμείων", "Fund cuts")}
            help={t("Όσα αιτήθηκες και δεν πληρώθηκαν, στους μήνες της περιόδου που σημείωσες ως εξοφλημένους στην Αποζημίωση. Είναι κέρδος που δεν υπήρξε ποτέ.", "What you claimed and was never paid, in the months of the period you marked as settled under Reimbursement. It is profit that never existed.")}
            value={s ? fmtEur(s.fund_cuts ?? 0) : "—"}
            sub={s && (s.fund_cuts ?? 0) > 0
              ? t(`καθαρό κέρδος ${fmtEur(s.net_profit ?? s.gross_profit)}`, `net profit ${fmtEur(s.net_profit ?? s.gross_profit)}`)
              : t("κανένας εξοφλημένος μήνας με περικοπή", "no settled month with a cut")}
            icon={Scissors}
            accent="rose"
          />
        </div>

        {/* ΔΙΑΦΑΝΕΙΑ: πόσο «σκληρό» είναι το κόστος που βλέπεις */}
        {s && (s.estimated_cost_pct ?? 0) >= 1 && (
          <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t(`Το ${fmtDec(s.estimated_cost_pct ?? 0, 0)}% του κόστους αυτής της περιόδου είναι εκτίμηση από την κλίμακα διατίμησης, γιατί η ΗΔΥΚΑ δεν έδωσε χονδρική για αυτά τα είδη. Στους πίνακες σημειώνεται με «~».`,
               `${fmtDec(s.estimated_cost_pct ?? 0, 0)}% of this period's cost is estimated from the markup bands, because ΗΔΥΚΑ gave no wholesale price for those items. Tables mark it with “~”.`)}
          </p>
        )}

        {/* χάρτης προσοχής: τι πιέζει / τι βοηθά / τι είναι αδιάφορο — και πού να κοιτάξεις */}
        <AttentionMap q={q} />

        {/* by-dimension chart */}
        <PanelCard
          title={t("Μεικτό κέρδος ανά διάσταση", "Gross profit by dimension")}
          action={
            <div className="w-44">
              <SelectFilter
                label=""
                value={dim}
                options={DIMS}
                onChange={(v) => setDim(v ?? "fund")}
                allLabel={t("Ταμείο", "Insurance fund")}
              />
            </div>
          }
        >
          <BarChart
            labels={rows.map((r) => r.label)}
            data={rows.map((r) => Math.round(r.gross_profit / 100))}
            name={t("Κέρδος", "Profit")}
            horizontal
            height={Math.max(220, rows.length * 36)}
          />
        </PanelCard>

        {/* profit by therapeutic category */}
        <PanelCard
          title={t("Κέρδος ανά κατηγορία", "Profit by category")}
          action={
            <div className="flex items-center gap-3">
              {topCat && (
                <span className="text-sm text-slate-500">
                  {t("Κορυφαία", "Top")}: <b className="text-slate-800 dark:text-slate-200">{topCat.label}</b> · <b className="text-emerald-600 dark:text-emerald-400">{fmtEur(topCat.gross_profit)}</b>
                </span>
              )}
              <ExportMenu filename="kerdos-ana-katigoria" title={t("Κέρδος ανά κατηγορία", "Profit by category")} rows={catRows} columns={[
                { key: "label", header: t("Κατηγορία", "Category") },
                { key: "units", header: t("Τεμάχια", "Units"), value: (r) => fmtNum(r.units) },
                { key: "value", header: t("Έσοδα χωρίς ΦΠΑ (€)", "Revenue excl. VAT (€)"), value: (r) => fmtMoney(r.value || 0) },
                { key: "gross_profit", header: t("Κέρδος (€)", "Profit (€)"), value: (r) => fmtMoney(r.gross_profit || 0) },
                { key: "margin_pct", header: t("Περιθώριο %", "Margin %"), value: (r) => fmtDec(r.margin_pct ?? 0, 1) },
              ]} />
            </div>
          }
        >
          <QueryState
            isLoading={byCategory.isLoading}
            isError={byCategory.isError}
            isEmpty={catRows.length === 0}
            onRetry={() => byCategory.refetch()}
          >
            <BarChart
              labels={catRows.map((r) => r.label)}
              data={catRows.map((r) => Math.round(r.gross_profit / 100))}
              name={t("Κέρδος", "Profit")}
              horizontal
              height={Math.max(240, catRows.length * 34)}
            />
            <div className="mt-4">
              <DataTable pageSize={20} columns={categoryColumns} rows={catRows} rowKey={(r) => r.label} />
            </div>
          </QueryState>
        </PanelCard>

        {/* ανοιχτά υπόλοιπα ταμείων — από την Αποζημίωση, που ξέρει τι πληρώθηκε */}
        <PanelCard
          title={t("Τι σου χρωστούν τα ταμεία — ανά ηλικία (ημέρες)", "What the funds owe you — by age (days)")}
          action={
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-slate-500">
                {t("Ανοιχτά", "Open")}: <b className="text-slate-800 dark:text-slate-200">{ag ? fmtEur(ag.total_open) : "—"}</b>
              </span>
              <span className="text-slate-500">
                {t("Πάνω από 60 ημέρες", "Over 60 days")}: <b className="text-amber-600">{ag ? fmtEur(ag.overdue_open) : "—"}</b>
              </span>
            </div>
          }
        >
          {ag && !ag.payments_recorded && (
            <p className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t(`Δεν έχεις σημειώσει ακόμη καμία είσπραξη, οπότε δεν μπορούμε να ξέρουμε τι σου χρωστούν — μόνο τι αιτήθηκες${ag.untracked_claimed ? ` (${fmtEur(ag.untracked_claimed)} τους τελευταίους 24 μήνες)` : ""}. Σημείωσε τι πληρώθηκε και εδώ θα βλέπεις τι είναι πραγματικά ανοιχτό και πόσο παλιό: `,
                   `You have not recorded any payment yet, so we cannot know what you are owed — only what you claimed${ag.untracked_claimed ? ` (${fmtEur(ag.untracked_claimed)} over the last 24 months)` : ""}. Record what was paid and this will show what is really open, and how old: `)}
                <Link href="/reimbursement/receivables" className="font-semibold underline">{t("Αποζημίωση → Υπόλοιπα", "Reimbursement → Balances")}</Link>
              </span>
            </p>
          )}
          {ag?.payments_recorded && ag.tracking_from && (
            <p className="mb-3 text-xs text-slate-500">
              {t(`Υπολογίζεται από ${ag.tracking_from.slice(5)}/${ag.tracking_from.slice(0, 4)}, τον πρώτο μήνα που σημείωσες είσπραξη. Οι προηγούμενοι μήνες δεν μετρούν ως οφειλόμενοι — δεν ξέρουμε αν πληρώθηκαν.`,
                 `Counted from ${ag.tracking_from.slice(5)}/${ag.tracking_from.slice(0, 4)}, the first month you recorded a payment. Earlier months are not counted as owed — we do not know whether they were paid.`)}
            </p>
          )}
          <BarChart
            labels={(ag?.buckets ?? []).map((b) => b.bucket)}
            data={(ag?.buckets ?? []).map((b) => Math.round(b.open / 100))}
            name={t("Ανοιχτά €", "Open €")}
            height={280}
          />
        </PanelCard>

        {/* low-margin table */}
        <PanelCard title={t("Είδη χαμηλής κερδοφορίας (< 10%)", "Low-margin items (< 10%)")} bodyClassName="pt-2">
          <p className="mb-3 text-xs text-slate-500">
            {t("Ταξινομημένα κατά τεμάχια που δόθηκαν στην περίοδο. Στα συνταγογραφούμενα το περιθώριο το ορίζει η κρατική διατίμηση και πέφτει όσο ακριβαίνει το φάρμακο — δεν είναι κάτι που διορθώνεις με την τιμή. Σε ενδιαφέρουν γιατί δεσμεύουν πολλά χρήματα σε απόθεμα για λίγο κέρδος: κράτα τα όσο χρειάζεται, όχι παραπάνω.",
               "Sorted by units dispensed in the period. For prescription medicines the margin is set by state pricing and shrinks as the medicine gets more expensive — not something you fix with price. They matter because they tie up a lot of money in stock for little profit: hold what you need, not more.")}
          </p>
          <QueryState
            isLoading={lowMargin.isLoading}
            isError={lowMargin.isError}
            isEmpty={lowItems.length === 0}
            onRetry={() => lowMargin.refetch()}
          >
            <DataTable pageSize={20} columns={lowMarginColumns} rows={lowItems} rowKey={(r) => r.product_id} />
          </QueryState>
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
