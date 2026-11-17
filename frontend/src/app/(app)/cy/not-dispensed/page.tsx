"use client";

/* RxVision Κύπρος — Είδη που δεν δόθηκαν (QtyDisp = 0).
   «Στη μέση της συνταγής» = πιθανή έλλειψη αποθέματος · «Στην τελευταία φάση» = οριστικά χαμένη πώληση. */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Item = { key: string; description: string | null; kind: string; mid: number; last: number; units_missed: number;
  patients: number; unit_price_cents: number | null; value_missed_cents: number };
type Resp = { summary: { products: number; mid: number; last: number; value_missed_cents: number; unpriced: number }; items: Item[] };

export default function CyNotDispensedPage() {
  const t = useT();
  const q = useQuery({ queryKey: ["cy", "not-dispensed"], queryFn: () => api<Resp>("/cy/not-dispensed") });
  const s = q.data?.summary;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Είδη που δεν δόθηκαν", "Items not dispensed")}</h1>
        <p className="text-sm text-slate-500">{t("Σκευάσματα που ήταν στη συνταγή αλλά δεν δόθηκαν. Στη μέση της συνταγής συνήθως σημαίνει έλλειψη αποθέματος — στην τελευταία φάση, χαμένη πώληση.",
          "Products on the prescription that were not given. Mid-prescription usually means a stock-out — at the last step, a lost sale.")}</p>
      </header>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {s && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[[t("Σκευάσματα", "Products"), fmtNum(s.products)], [t("Στη μέση της συνταγής", "Mid-prescription"), fmtNum(s.mid)],
            [t("Στην τελευταία φάση", "At the last step"), fmtNum(s.last)], [t("Αξία που δεν πουλήθηκε", "Value not sold"), fmtEur(s.value_missed_cents)]]
            .map(([l, v]) => (
              <div key={l} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="text-xs font-medium text-slate-500">{l}</div><div className="mt-1 text-2xl font-bold">{v}</div>
              </div>))}
        </div>
      )}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2">{t("Σκεύασμα", "Product")}</th><th className="px-4 py-2 text-right">{t("Στη μέση", "Mid")}</th>
              <th className="px-4 py-2 text-right">{t("Τελευταία φάση", "Last step")}</th><th className="px-4 py-2 text-right">{t("Πελάτες", "Customers")}</th>
              <th className="px-4 py-2 text-right">{t("Τεμάχια", "Units")}</th><th className="px-4 py-2 text-right">{t("Αξία", "Value")}</th></tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((r) => (
              <tr key={r.key} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2">{r.description || r.key}<div className="text-xs text-slate-400">{r.key}</div></td>
                <td className="px-4 py-2 text-right">{fmtNum(r.mid)}</td><td className="px-4 py-2 text-right">{fmtNum(r.last)}</td>
                <td className="px-4 py-2 text-right">{fmtNum(r.patients)}</td><td className="px-4 py-2 text-right">{fmtNum(r.units_missed)}</td>
                <td className="px-4 py-2 text-right">{r.unit_price_cents == null ? <span className="text-xs text-slate-400">{t("χωρίς τιμή", "no price")}</span> : fmtEur(r.value_missed_cents)}</td>
              </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
