"use client";

/* RxVision Κύπρος: Κερδοφορία. Ίδιος κανόνας με την Ελλάδα: κέρδος = έσοδα ΧΩΡΙΣ ΦΠΑ − χονδρική.
   Το XML ΓεΣΥ δεν έχει χονδρική: την παίρνουμε από την Αποθήκη (barcode). Όπου λείπει, το είδος
   ΔΕΝ μπαίνει στο κέρδος (ποτέ εκτίμηση) και η «κάλυψη» λέει πόσο από τα έσοδα μετρήθηκε. */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Percent, ShieldCheck, TrendingUp, Wallet } from "lucide-react";
import { api } from "@/lib/apiClient";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { QueryState } from "@/components/ui/QueryState";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore } from "@/store/uiStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Row = { key: string; barcode: string | null; name: string | null; kind: string | null; units: number; revenue: number;
  revenue_net: number; vat_pct: number; cost: number | null; profit: number | null; margin_pct: number | null };
type Resp = { totals: { revenue: number; revenue_net: number; covered_revenue_net: number; cost: number; profit: number;
  margin_pct: number | null; coverage_pct: number }; items: Row[]; missing_cost: number };

export default function CyProfitabilityPage() {
  const t = useT();
  const { dateFrom, dateTo } = useUiStore();
  const q = useQuery({ queryKey: ["cy", "profit", dateFrom, dateTo], queryFn: () => api<Resp>(`/cy/profitability?date_from=${dateFrom}&date_to=${dateTo}`) });
  const d = q.data;
  const cols: Column<Row>[] = [
    { key: "name", header: t("Σκεύασμα", "Product"), render: (r) => <div><div className="font-medium">{r.name || "—"}</div><div className="text-xs text-slate-400">{r.barcode || r.key} · {t("ΦΠΑ", "VAT")} {r.vat_pct}%</div></div> },
    { key: "units", header: t("Τεμάχια", "Units"), align: "right", render: (r) => fmtNum(r.units) },
    { key: "revenue_net", header: t("Έσοδα χωρίς ΦΠΑ", "Revenue excl. VAT"), align: "right", render: (r) => fmtEur(r.revenue_net) },
    { key: "cost", header: t("Χονδρική", "Wholesale"), align: "right", sortValue: (r) => r.cost ?? -1,
      render: (r) => r.cost == null ? <span className="text-xs text-amber-700">{t("λείπει", "missing")}</span> : fmtEur(r.cost) },
    { key: "profit", header: t("Κέρδος", "Profit"), align: "right", sortValue: (r) => r.profit ?? -1e12,
      render: (r) => r.profit == null ? "—" : <b className={r.profit < 0 ? "text-rose-600" : ""}>{fmtEur(r.profit)}</b> },
    { key: "margin_pct", header: "%", align: "right", sortValue: (r) => r.margin_pct ?? -1e6, render: (r) => r.margin_pct == null ? "—" : `${r.margin_pct}%` },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Κερδοφορία", "Profitability")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Κέρδος ανά σκεύασμα: έσοδα χωρίς ΦΠΑ μείον χονδρική από την Αποθήκη.", "Profit per product: revenue excl. VAT minus wholesale from the Warehouse.")}</p>
        </div>
        <DateRangeFilter />
      </div>
      {d && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <KpiCard label={t("Έσοδα χωρίς ΦΠΑ", "Revenue excl. VAT")} value={fmtEur(d.totals.revenue_net)} icon={Wallet} accent="indigo"
            sub={`${t("με ΦΠΑ", "incl. VAT")} ${fmtEur(d.totals.revenue)}`} />
          <KpiCard label={t("Μεικτό κέρδος", "Gross profit")} value={fmtEur(d.totals.profit)} icon={TrendingUp} accent="green"
            help={t("Μόνο για τα σκευάσματα με χονδρική στην Αποθήκη.", "Only for products with a wholesale price in the Warehouse.")} />
          <KpiCard label={t("Περιθώριο", "Margin")} value={d.totals.margin_pct == null ? "—" : `${d.totals.margin_pct}%`} icon={Percent} accent="violet" />
          <KpiCard label={t("Κάλυψη", "Coverage")} value={`${d.totals.coverage_pct}%`} icon={ShieldCheck} accent={d.totals.coverage_pct >= 80 ? "green" : "amber"}
            sub={`${fmtNum(d.missing_cost)} ${t("σκευάσματα χωρίς χονδρική", "products without wholesale")}`}
            help={t("Πόσο από τα έσοδα έχει γνωστή χονδρική. Το XML ΓεΣΥ δεν γράφει χονδρική· τη συμπληρώνεις στην Αποθήκη.", "How much of the revenue has a known wholesale price. The GHS XML has none; you fill it in the Warehouse.")} />
        </div>
      )}
      {d && d.missing_cost > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          {t("Για να μετρηθούν όλα, συμπλήρωσε τη χονδρική τους στην ", "To count everything, fill in their wholesale price in the ")}
          <Link href="/warehouse" className="font-medium underline">{t("Αποθήκη", "Warehouse")}</Link>.
        </p>
      )}
      <div className="rx-card p-2">
        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()} isEmpty={(d?.items.length ?? 0) === 0}
          empty={t("Καμία εκτέλεση στην περίοδο.", "No dispensings in the period.")}>
          <DataTable pageSize={30} columns={cols} rows={d?.items ?? []} rowKey={(r) => r.key} />
        </QueryState>
      </div>
    </div>
  );
}
