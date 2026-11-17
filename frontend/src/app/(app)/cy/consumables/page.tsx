"use client";

/* RxVision Κύπρος — Αναλώσιμα & διαβητικοί πελάτες. Ταινίες γλυκόζης/σκαρφιστήρες = διαβήτης
   (το XML ΓεΣΥ δεν έχει διάγνωση). Η κατάσταση έρχεται από τον ΕΝΑ ορισμό αλυσίδων (chains). */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtDate, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";
import { STATUS_STYLE, type ChainStatus } from "@/lib/cy";

type Resp = { summary: { patients: number; diabetic: number; late: number };
  items: { code: string; description: string | null; times: number; units: number; total_cents: number; patients: number }[];
  patients: { patient_ref: string; patient_name: string | null; diabetic: boolean; last: string; total_cents: number; status: ChainStatus | "closed"; items: string[] }[] };

export default function CyConsumablesPage() {
  const t = useT();
  const q = useQuery({ queryKey: ["cy", "consumables"], queryFn: () => api<Resp>("/cy/consumables") });
  const s = q.data?.summary;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Αναλώσιμα & διαβητικοί", "Consumables & diabetics")}</h1>
        <p className="text-sm text-slate-500">{t("Ποιοι παίρνουν αναλώσιμα (ταινίες, σκαρφιστήρες κ.λπ.) και ποιοι άργησαν να έρθουν για τα επόμενα.",
          "Who receives consumables (strips, lancets etc.) and who is late for the next supply.")}</p>
      </header>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {s && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[[t("Πελάτες με αναλώσιμα", "Customers with consumables"), fmtNum(s.patients)], [t("Διαβητικοί (από αναλώσιμα)", "Diabetic (from consumables)"), fmtNum(s.diabetic)],
            [t("Καθυστερούν ή χάθηκαν", "Late or lost"), fmtNum(s.late)]].map(([l, v]) => (
            <div key={l} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <div className="text-xs font-medium text-slate-500">{l}</div><div className="mt-1 text-2xl font-bold">{v}</div></div>))}
        </div>
      )}
      <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Πελάτες", "Customers")}</h2>
        <table className="w-full text-sm"><tbody>
          {(q.data?.patients ?? []).map((p) => (
            <tr key={p.patient_ref} className="border-t border-slate-100 align-top dark:border-slate-800">
              <td className="px-4 py-2"><Link href={`/cy/patients/${encodeURIComponent(p.patient_ref)}`} className="font-medium hover:text-indigo-600">{p.patient_name || "—"}</Link>
                {p.diabetic && <span className="ml-2 rounded bg-sky-100 px-1.5 text-xs text-sky-800">{t("διαβητικός", "diabetic")}</span>}
                <div className="text-xs text-slate-400">{p.items.slice(0, 2).join(" · ")}</div></td>
              <td className="whitespace-nowrap px-4 py-2 text-xs">{t("τελευταία", "last")} {fmtDate(p.last)}</td>
              <td className="px-4 py-2">{p.status !== "closed" && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status].cls}`}>{t(STATUS_STYLE[p.status].el, STATUS_STYLE[p.status].en)}</span>}</td>
              <td className="px-4 py-2 text-right">{fmtEur(p.total_cents)}</td>
            </tr>))}
        </tbody></table>
      </section>
      <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Ανά είδος", "By item")}</h2>
        <table className="w-full text-sm"><tbody>
          {(q.data?.items ?? []).map((r) => (
            <tr key={r.code} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-4 py-2">{r.description || r.code}<div className="text-xs text-slate-400">{fmtNum(r.patients)} {t("πελάτες", "customers")} · {fmtNum(r.units)} {t("τεμ.", "units")}</div></td>
              <td className="px-4 py-2 text-right">{fmtEur(r.total_cents)}</td>
            </tr>))}
        </tbody></table>
      </section>
    </div>
  );
}
