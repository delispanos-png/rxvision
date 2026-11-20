"use client";

/* RxVision Κύπρος: Πρόταση παραγγελίας. Τι θα ζητηθεί τις επόμενες ημέρες από τις ανοιχτές
   συνταγές (ίδιος ορισμός αλυσίδων), τι έλειψε τον τελευταίο μήνα, και τι απόθεμα λέει η Αποθήκη.
   Δεν παραγγέλνει τίποτα μόνο του: δίνει λίστα για τον προμηθευτή (CSV). */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { downloadCsv } from "@/lib/csv";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Sup = { name: string; code: string | null; wholesale_cents: number; stock: number | null; offer: string | null; available: boolean };
type Row = { key: string; barcode: string | null; description: string | null; kind: string | null; expected: number;
  patients: number; missed_30d: number; stock: number | null; suggested: number;
  suppliers: Sup[]; best_supplier: string | null; best_cents: number | null; saving_cents: number };
type Basket = { supplier: string; items: number; cost_cents: number; cheapest: number };
type Summary = { products: number; units: number; with_stock_info: number; with_suppliers: number; best_cost_cents: number; saving_cents: number };

export default function CyReorderPage() {
  const t = useT();
  const [h, setH] = useState(14);
  const q = useQuery({ queryKey: ["cy", "reorder", h], queryFn: () => api<{ items: Row[]; baskets: Basket[]; summary: Summary }>(`/cy/reorder?horizon=${h}`) });
  const rows = q.data?.items ?? [];
  const cols: Column<Row>[] = [
    { key: "description", header: t("Σκεύασμα", "Product"), render: (r) => <div><div className="font-medium">{r.description || "—"}</div><div className="text-xs text-slate-400">{r.barcode || r.key}{r.kind === "consumable" ? ` · ${t("αναλώσιμο", "consumable")}` : ""}</div></div> },
    { key: "expected", header: t("Θα ζητηθούν", "Expected"), align: "right", render: (r) => <span>{fmtNum(r.expected)} <span className="text-xs text-slate-400">({r.patients} {t("πελ.", "cust.")})</span></span> },
    { key: "missed_30d", header: t("Έλειψαν 30ημ.", "Missed 30d"), align: "right", render: (r) => r.missed_30d ? <span className="text-amber-700">{fmtNum(r.missed_30d)}</span> : "—" },
    { key: "stock", header: t("Απόθεμα", "Stock"), align: "right", render: (r) => r.stock == null ? <span className="text-xs text-slate-400">{t("άγνωστο", "unknown")}</span> : fmtNum(r.stock), sortValue: (r) => r.stock ?? -1 },
    { key: "suggested", header: t("Πρόταση", "Suggested"), align: "right", render: (r) => <b>{fmtNum(r.suggested)}</b> },
    // Σύγκριση προμηθευτών (κατάλογος PharmacyOne): φθηνότερος με διαθεσιμότητα + όλοι στο hover
    { key: "best_cents", header: t("Καλύτερη τιμή", "Best price"), align: "right", sortValue: (r) => r.best_cents ?? 1e12,
      render: (r) => !r.suppliers?.length ? <span className="text-xs text-slate-400">{t("χωρίς προμηθευτή", "no supplier")}</span> : (
        <div className="text-right" title={r.suppliers.map((x) => `${x.name}: ${fmtEur(x.wholesale_cents)}${x.available ? "" : " (χωρίς απόθεμα)"}${x.offer ? ` · ${x.offer}` : ""}`).join("\n")}>
          <div className="font-semibold text-emerald-700 dark:text-emerald-400">{fmtEur(r.best_cents ?? 0)}</div>
          <div className="text-xs text-slate-500">{r.best_supplier}{r.suppliers.length > 1 ? ` · +${r.suppliers.length - 1}` : ""}</div>
        </div>) },
    { key: "saving_cents", header: t("Γλιτώνεις", "You save"), align: "right", sortValue: (r) => r.saving_cents,
      render: (r) => r.saving_cents ? <span className="text-emerald-700 dark:text-emerald-400">{fmtEur(r.saving_cents)}</span> : "—" },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Πρόταση παραγγελίας", "Reorder suggestion")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Τι θα ζητήσουν οι πελάτες σου από τις ανοιχτές συνταγές τους, τι σου έλειψε, και τι έχεις στην Αποθήκη.", "What your customers will ask for from their open prescriptions, what you ran out of, and what the Warehouse holds.")}</p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 14, 30].map((d) => (
            <button key={d} onClick={() => setH(d)} className={`rounded-full border px-3 py-1 text-sm ${h === d ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>{d} {t("ημέρες", "days")}</button>
          ))}
          {rows.length > 0 && (
            <button onClick={() => downloadCsv("paraggelia-gesy", [
              { key: "barcode", header: "Barcode" }, { key: "description", header: t("Σκεύασμα", "Product") },
              { key: "expected", header: t("Θα ζητηθούν", "Expected") }, { key: "missed_30d", header: t("Έλειψαν 30ημ.", "Missed 30d") },
              { key: "stock", header: t("Απόθεμα", "Stock") }, { key: "suggested", header: t("Πρόταση", "Suggested") },
              { key: "best_supplier", header: t("Προμηθευτής", "Supplier") }, { key: "best_eur", header: t("Χονδρική €", "Wholesale €") }],
              rows.map((r) => ({ ...r, best_eur: r.best_cents != null ? (r.best_cents / 100).toFixed(2).replace(".", ",") : "" })))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
          )}
        </div>
      </div>
      {q.data && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {fmtNum(q.data.summary.products)} {t("σκευάσματα", "products")} · {t("πρόταση", "suggested")} <b>{fmtNum(q.data.summary.units)}</b> {t("τεμάχια", "units")}
          {q.data.summary.with_stock_info < q.data.summary.products && <span className="text-xs text-slate-400"> · {t("για όσα δεν υπάρχουν στην Αποθήκη, η πρόταση δεν αφαιρεί απόθεμα", "where the Warehouse has no record, stock is not subtracted")}</span>}
        </p>
      )}
      {q.data && q.data.summary.with_suppliers > 0 && (
        <div className="rx-card p-4">
          <div className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{t("Σύγκριση προμηθευτών", "Supplier comparison")}</div>
          <p className="mb-3 text-xs text-slate-500">
            {t("Τιμές χονδρικής από τον κατάλογο PharmacyOne. Αν πάρεις κάθε είδος από τον φθηνότερο που το έχει, η παραγγελία κοστίζει", "Wholesale prices from the PharmacyOne catalogue. Buying each item from the cheapest supplier that has it costs")}{" "}
            <b>{fmtEur(q.data.summary.best_cost_cents)}</b>{q.data.summary.saving_cents > 0 && <> {t("και γλιτώνεις έως", "and saves up to")} <b className="text-emerald-700 dark:text-emerald-400">{fmtEur(q.data.summary.saving_cents)}</b></>}.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {q.data.baskets.slice(0, 8).map((b) => (
              <div key={b.supplier} className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                <div className="font-medium text-slate-800 dark:text-slate-100">{b.supplier}</div>
                <div className="text-xs text-slate-500">{b.items} {t("είδη", "items")} · {fmtEur(b.cost_cents)} · {t("φθηνότερος σε", "cheapest on")} {b.cheapest}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="rx-card p-2">
        {q.isLoading ? <Loader2 className="m-4 h-5 w-5 animate-spin text-slate-400" /> :
          <DataTable pageSize={30} columns={cols} rows={rows} rowKey={(r) => r.key} empty={t("Τίποτα για παραγγελία σε αυτό το διάστημα.", "Nothing to order in this period.")} />}
      </div>
    </div>
  );
}
