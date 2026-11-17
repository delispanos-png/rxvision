"use client";

/* RxVision Κύπρος — Ανάκληση παρτίδας: ποιοι πελάτες πήραν την παρτίδα Χ (από το EMVS του XML).
   Κρατάμε παρτίδα + λήξη, ΟΧΙ σειριακό — αρκεί για ανάκληση. */

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtDate, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Resp = { lot: string; patients: number; packs: number;
  items: { dispensed_at: string; patient_ref: string; patient_name: string | null; description: string | null; gtin: string | null; expiry: string | null; packs: number; doctor: string | null }[] };

export default function CyRecallPage() {
  const t = useT();
  const [lot, setLot] = useState(""); const [gtin, setGtin] = useState(""); const [go, setGo] = useState<{ lot: string; gtin: string } | null>(null);
  const q = useQuery({ queryKey: ["cy", "recall", go], enabled: !!go?.lot,
    queryFn: () => api<Resp>(`/cy/recall?lot=${encodeURIComponent(go!.lot)}${go!.gtin ? `&gtin=${encodeURIComponent(go!.gtin)}` : ""}`) });
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Ανάκληση παρτίδας", "Batch recall")}</h1>
        <p className="text-sm text-slate-500">{t("Γράψε την παρτίδα (και, αν θέλεις, το barcode) και δες ποιοι πελάτες την πήραν και πότε.",
          "Enter the batch (and optionally the barcode) to see which customers received it and when.")}</p>
      </header>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setGo({ lot: lot.trim(), gtin: gtin.trim() }); }}>
        <input value={lot} onChange={(e) => setLot(e.target.value)} placeholder={t("Παρτίδα (LOT)", "Batch (LOT)")} className="w-48 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        <input value={gtin} onChange={(e) => setGtin(e.target.value)} placeholder={t("Barcode / GTIN (προαιρετικό)", "Barcode / GTIN (optional)")} className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        <button type="submit" disabled={!lot.trim()} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"><Search className="h-4 w-4" />{t("Αναζήτηση", "Search")}</button>
      </form>
      {q.isFetching && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {q.data && (
        <div className="space-y-3">
          <p className="text-sm"><b>{fmtNum(q.data.patients)}</b> {t("πελάτες", "customers")} · <b>{fmtNum(q.data.packs)}</b> {t("κουτιά", "packs")}</p>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-sm"><tbody>
              {q.data.items.map((r, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="whitespace-nowrap px-4 py-2">{fmtDate(r.dispensed_at)}</td>
                  <td className="px-4 py-2"><Link href={`/cy/patients/${encodeURIComponent(r.patient_ref)}`} className="font-medium hover:text-indigo-600">{r.patient_name || "—"}</Link></td>
                  <td className="px-4 py-2">{r.description}<div className="text-xs text-slate-400">{r.gtin}{r.expiry ? ` · ${t("λήξη", "exp.")} ${fmtDate(r.expiry)}` : ""}</div></td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.packs)}</td>
                </tr>))}
              {q.data.items.length === 0 && <tr><td className="px-4 py-6 text-center text-slate-400">{t("Κανείς πελάτης δεν πήρε αυτή την παρτίδα.", "No customer received this batch.")}</td></tr>}
            </tbody></table>
          </div>
        </div>
      )}
    </div>
  );
}
