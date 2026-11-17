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
import { fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Row = { key: string; barcode: string | null; description: string | null; kind: string | null; expected: number;
  patients: number; missed_30d: number; stock: number | null; suggested: number };

export default function CyReorderPage() {
  const t = useT();
  const [h, setH] = useState(14);
  const q = useQuery({ queryKey: ["cy", "reorder", h], queryFn: () => api<{ items: Row[]; summary: { products: number; units: number; with_stock_info: number } }>(`/cy/reorder?horizon=${h}`) });
  const rows = q.data?.items ?? [];
  const cols: Column<Row>[] = [
    { key: "description", header: t("Σκεύασμα", "Product"), render: (r) => <div><div className="font-medium">{r.description || "—"}</div><div className="text-xs text-slate-400">{r.barcode || r.key}{r.kind === "consumable" ? ` · ${t("αναλώσιμο", "consumable")}` : ""}</div></div> },
    { key: "expected", header: t("Θα ζητηθούν", "Expected"), align: "right", render: (r) => <span>{fmtNum(r.expected)} <span className="text-xs text-slate-400">({r.patients} {t("πελ.", "cust.")})</span></span> },
    { key: "missed_30d", header: t("Έλειψαν 30ημ.", "Missed 30d"), align: "right", render: (r) => r.missed_30d ? <span className="text-amber-700">{fmtNum(r.missed_30d)}</span> : "—" },
    { key: "stock", header: t("Απόθεμα", "Stock"), align: "right", render: (r) => r.stock == null ? <span className="text-xs text-slate-400">{t("άγνωστο", "unknown")}</span> : fmtNum(r.stock), sortValue: (r) => r.stock ?? -1 },
    { key: "suggested", header: t("Πρόταση", "Suggested"), align: "right", render: (r) => <b>{fmtNum(r.suggested)}</b> },
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
              { key: "stock", header: t("Απόθεμα", "Stock") }, { key: "suggested", header: t("Πρόταση", "Suggested") }], rows)}
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
      <div className="rx-card p-2">
        {q.isLoading ? <Loader2 className="m-4 h-5 w-5 animate-spin text-slate-400" /> :
          <DataTable pageSize={30} columns={cols} rows={rows} rowKey={(r) => r.key} empty={t("Τίποτα για παραγγελία σε αυτό το διάστημα.", "Nothing to order in this period.")} />}
      </div>
    </div>
  );
}
