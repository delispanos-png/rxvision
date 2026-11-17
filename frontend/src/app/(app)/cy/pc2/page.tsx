"use client";

/* RxVision Κύπρος — Διαφορά τιμής (PC2): ό,τι πληρώνουν οι πελάτες επειδή πήραν σκεύασμα ακριβότερο
   από την τιμή αναφοράς του ΟΑΥ. Η πρόταση φθηνότερου ισοδύναμου έρχεται με τον κατάλογο ΟΑΥ (ATC). */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Resp = { days: number; total_cents: number; monthly_cents: number; patients: number;
  by_product: { key: string; description: string | null; pc2_cents: number; times: number; patients: number }[];
  by_patient: { patient_ref: string; patient_name: string | null; pc2_cents: number; times: number; products: string[] }[] };

export default function CyPc2Page() {
  const t = useT();
  const q = useQuery({ queryKey: ["cy", "pc2"], queryFn: () => api<Resp>("/cy/pc2") });
  const d = q.data;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Διαφορά τιμής (PC2)", "Price difference (PC2)")}</h1>
        <p className="text-sm text-slate-500">{t("Όσα πληρώνουν οι πελάτες σου πάνω από την τιμή αναφοράς του ΟΑΥ, επειδή πήραν ακριβότερο σκεύασμα. Τελευταίες 90 ημέρες.",
          "What your customers pay above the HIO reference price for choosing a pricier product. Last 90 days.")}</p>
      </header>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {d && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[[t("Σύνολο 90 ημερών", "90-day total"), fmtEur(d.total_cents)], [t("Ανά μήνα", "Per month"), fmtEur(d.monthly_cents)],
              [t("Πελάτες που πληρώνουν διαφορά", "Customers paying a difference"), fmtNum(d.patients)]].map(([l, v]) => (
              <div key={l} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="text-xs font-medium text-slate-500">{l}</div><div className="mt-1 text-2xl font-bold">{v}</div>
              </div>))}
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Ανά σκεύασμα", "By product")}</h2>
              <table className="w-full text-sm"><tbody>
                {d.by_product.map((r) => (
                  <tr key={r.key} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2">{r.description || r.key}<div className="text-xs text-slate-400">{fmtNum(r.patients)} {t("πελάτες", "customers")} · {fmtNum(r.times)} {t("φορές", "times")}</div></td>
                    <td className="px-4 py-2 text-right font-medium">{fmtEur(r.pc2_cents)}</td>
                  </tr>))}
              </tbody></table>
            </section>
            <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Ανά πελάτη", "By customer")}</h2>
              <table className="w-full text-sm"><tbody>
                {d.by_patient.map((r) => (
                  <tr key={r.patient_ref} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2"><Link href={`/cy/patients/${encodeURIComponent(r.patient_ref)}`} className="font-medium hover:text-indigo-600">{r.patient_name || "—"}</Link>
                      <div className="text-xs text-slate-400">{r.products.slice(0, 2).join(" · ")}</div></td>
                    <td className="px-4 py-2 text-right font-medium">{fmtEur(r.pc2_cents)}</td>
                  </tr>))}
              </tbody></table>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
