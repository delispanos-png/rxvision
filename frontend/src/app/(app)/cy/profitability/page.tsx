"use client";

/* RxVision Κύπρος: Κερδοφορία (20/11/2026). Στο ΓεΣΥ ο ΟΑΥ πληρώνει τα φάρμακα ΣΤΗ ΧΟΝΔΡΙΚΗ, άρα το κέρδος
   του φαρμακείου είναι:
     1) η ΑΜΟΙΒΗ ΟΑΥ ανά συσκευασία (ακριβής από την «Εκκαθάριση ΟΑΥ», αλλιώς προσωρινή με την τελευταία
        γνωστή τιμή μονάδας — πάντα σημειωμένη),
     2) οι εφημερίες και οι διορθώσεις της κατάστασης πληρωμής,
     3) η διαφορά ΓεΣΥ − χονδρικής ανά σκεύασμα (≈0 για φάρμακα· δείχνει είδη που πληρώνονται κάτω από την αγορά).
   Backend: services/cy/analytics.py::profitability. Ποτέ εκτίμηση χωρίς εκκαθάριση. */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BadgeEuro, Moon, Scale, TrendingUp } from "lucide-react";
import { api } from "@/lib/apiClient";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { QueryState } from "@/components/ui/QueryState";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore } from "@/store/uiStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Row = { key: string; barcode: string | null; name: string | null; kind: string | null; opened_pack: boolean; units: number;
  revenue: number; revenue_net: number; vat_pct: number; cost: number | null; profit: number | null; margin_pct: number | null };
type Fee = { packages: number; exact_packages: number; exact_cents: number; provisional_packages: number; provisional_cents: number;
  no_fee_packages: number; price_cents: number | null; price_month: string | null; available: boolean; total_cents: number | null };
type Resp = { totals: { revenue: number; revenue_net: number; covered_revenue_net: number; cost: number; profit: number;
  margin_pct: number | null; coverage_pct: number; total_profit: number | null };
  fee: Fee; duty_cents: number; corrections_cents: number; settlement_months: string[];
  items: Row[]; missing_cost: number; opened_packs: number };

const MONTHS = ["Ιανουαρίου", "Φεβρουαρίου", "Μαρτίου", "Απριλίου", "Μαΐου", "Ιουνίου", "Ιουλίου", "Αυγούστου",
  "Σεπτεμβρίου", "Οκτωβρίου", "Νοεμβρίου", "Δεκεμβρίου"];
const mgen = (m: string | null) => (m ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "");

export default function CyProfitabilityPage() {
  const t = useT();
  const { dateFrom, dateTo } = useUiStore();
  const q = useQuery({ queryKey: ["cy", "profit", dateFrom, dateTo], queryFn: () => api<Resp>(`/cy/profitability?date_from=${dateFrom}&date_to=${dateTo}`) });
  const d = q.data;
  const f = d?.fee;
  const cols: Column<Row>[] = [
    { key: "name", header: t("Σκεύασμα", "Product"), render: (r) => (
      <div>
        <div className="font-medium">{r.name || "—"}
          {r.kind === "consumable" && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t("αναλώσιμο", "consumable")}</span>}
          {r.opened_pack && <span className="ml-1.5 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-800" title={t("Δόθηκε σε τεμάχια από ανοιγμένη συσκευασία· η χονδρική της Αποθήκης είναι ανά κουτί, άρα δεν υπολογίζεται.", "Given as pieces from an opened pack; the Warehouse wholesale is per box, so it is not computed.")}>{t("υποδιαίρεση", "split pack")}</span>}
        </div>
        <div className="text-xs text-slate-400">{r.barcode || r.key.replace("|opened", "")} · {t("ΦΠΑ", "VAT")} {r.vat_pct}%</div>
      </div>) },
    { key: "units", header: t("Τεμάχια", "Units"), align: "right", render: (r) => fmtNum(r.units) },
    { key: "revenue_net", header: t("Πληρωμή ΓεΣΥ χωρίς ΦΠΑ", "GHS payment excl. VAT"), align: "right", render: (r) => fmtEur(r.revenue_net) },
    { key: "cost", header: t("Χονδρική", "Wholesale"), align: "right", sortValue: (r) => r.cost ?? -1,
      render: (r) => r.cost == null ? <span className="text-xs text-amber-700">{r.opened_pack ? "—" : t("λείπει", "missing")}</span> : fmtEur(r.cost) },
    { key: "profit", header: t("Διαφορά", "Difference"), align: "right", sortValue: (r) => r.profit ?? -1e12,
      render: (r) => r.profit == null ? "—" : <b className={r.profit < 0 ? "text-rose-600" : ""}>{fmtEur(r.profit)}</b> },
    { key: "margin_pct", header: "%", align: "right", sortValue: (r) => r.margin_pct ?? -1e6, render: (r) => r.margin_pct == null ? "—" : `${r.margin_pct}%` },
  ];
  const extra = (d?.duty_cents ?? 0) + (d?.corrections_cents ?? 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Κερδοφορία", "Profitability")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Στο ΓεΣΥ ο ΟΑΥ πληρώνει τα φάρμακα στη χονδρική. Το κέρδος σου είναι η αμοιβή ανά συσκευασία, οι εφημερίες και ό,τι διαφέρει από τη χονδρική.",
            "In the GHS the HIO pays medicines at wholesale. Your profit is the fee per package, the duty nights and whatever differs from wholesale.")}</p>
        </div>
        <DateRangeFilter />
      </div>

      {d && f && !f.available && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          {t("Για να δεις την αμοιβή σου από τον ΟΑΥ, ανέβασε τα αρχεία του μήνα στην ", "To see your HIO fee, upload the month's files in ")}
          <Link href="/cy/settlement" className="font-medium underline">{t("Εκκαθάριση ΟΑΥ", "HIO settlement")}</Link>.
        </p>
      )}

      {d && f && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <KpiCard label={t("Κέρδος περιόδου", "Profit for the period")} icon={TrendingUp} accent="green"
            value={d.totals.total_profit == null ? "—" : fmtEur(d.totals.total_profit)}
            sub={f.provisional_packages > 0 ? t("μέρος του είναι προσωρινό", "part of it is provisional") : undefined}
            help={t("Αμοιβή ΟΑΥ + εφημερίες και διορθώσεις + διαφορά ΓεΣΥ − χονδρικής.", "HIO fee + duty nights and corrections + GHS − wholesale difference.")} />
          <KpiCard label={t("Αμοιβή ΟΑΥ", "HIO fee")} icon={BadgeEuro} accent="indigo"
            value={f.total_cents == null ? "—" : fmtEur(f.total_cents)}
            sub={`${fmtNum(f.packages)} ${t("συσκευασίες", "packages")}`}
            help={t("Συσκευασίες × τιμή μονάδας του μήνα. Ακριβής για όσες εκτελέσεις είναι στις πληρωμένες απαιτήσεις· για τις υπόλοιπες προσωρινή με την τελευταία γνωστή τιμή μονάδας.",
              "Packages × the month's unit price. Exact for dispensings in the paid claims; for the rest provisional with the latest known unit price.")} />
          <KpiCard label={t("Εφημερίες και διορθώσεις", "Duty nights and corrections")} icon={Moon} accent="violet"
            value={d.settlement_months.length ? fmtEur(extra) : "—"}
            sub={d.settlement_months.length ? `${t("εφημερίες", "duty")} ${fmtEur(d.duty_cents)} · ${t("διορθώσεις", "corrections")} ${fmtEur(d.corrections_cents)}` : t("από την κατάσταση πληρωμής", "from the remittance advice")} />
          <KpiCard label={t("Διαφορά ΓεΣΥ − χονδρικής", "GHS − wholesale difference")} icon={Scale} accent={d.totals.profit < 0 ? "amber" : "green"}
            value={fmtEur(d.totals.profit)}
            sub={`${t("κάλυψη", "coverage")} ${d.totals.coverage_pct}% · ${fmtNum(d.missing_cost)} ${t("χωρίς χονδρική", "without wholesale")}`}
            help={t("Για τα φάρμακα είναι σχεδόν μηδέν, γιατί ο ΟΑΥ πληρώνει τη χονδρική. Αρνητικό σημαίνει ότι κάποια είδη πληρώνονται κάτω από την τιμή που τα αγοράζεις.",
              "For medicines it is almost zero, as the HIO pays wholesale. Negative means some items are paid below what you buy them for.")} />
        </div>
      )}

      {f && f.provisional_packages > 0 && f.price_cents != null && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
          {t(`Ακριβής αμοιβή: ${fmtEur(f.exact_cents)} για ${fmtNum(f.exact_packages)} συσκευασίες. Προσωρινή: ${fmtEur(f.provisional_cents)} για ${fmtNum(f.provisional_packages)} συσκευασίες, με την τιμή μονάδας ${fmtEur(f.price_cents)} ${mgen(f.price_month)}. Γίνεται ακριβής μόλις ανεβάσεις την εκκαθάριση του μήνα.`,
            `Exact fee: ${fmtEur(f.exact_cents)} for ${fmtNum(f.exact_packages)} packages. Provisional: ${fmtEur(f.provisional_cents)} for ${fmtNum(f.provisional_packages)} packages, at the ${f.price_month} unit price of ${fmtEur(f.price_cents)}. It becomes exact once you upload that month's settlement.`)}
        </p>
      )}

      {d && d.missing_cost > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          {t("Για να μετρηθούν όλα στη διαφορά, συμπλήρωσε τη χονδρική τους στην ", "To include everything in the difference, fill in their wholesale price in the ")}
          <Link href="/warehouse" className="font-medium underline">{t("Αποθήκη", "Warehouse")}</Link>.
        </p>
      )}

      <div className="rx-card p-2">
        <h2 className="px-2 pb-2 pt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Διαφορά ΓεΣΥ − χονδρικής ανά σκεύασμα", "GHS − wholesale difference by product")}</h2>
        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()} isEmpty={(d?.items.length ?? 0) === 0}
          empty={t("Καμία εκτέλεση στην περίοδο.", "No dispensings in the period.")}>
          <DataTable pageSize={30} columns={cols} rows={d?.items ?? []} rowKey={(r) => r.key} />
        </QueryState>
      </div>
    </div>
  );
}
