"use client";

/* RxVision Κύπρος — Υπάλληλοι: εκτελέσεις ανά χρήστη της πύλης ΓεΣΥ (από το XML). */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtDate, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Row = { username: string | null; name: string | null; dispensings: number; lines: number; total_cents: number; first: string | null; last: string | null };

export default function CyStaffPage() {
  const t = useT();
  const q = useQuery({ queryKey: ["cy", "staff"], queryFn: () => api<{ days: number; items: Row[] }>("/cy/staff") });
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Υπάλληλοι", "Staff")}</h1>
        <p className="text-sm text-slate-500">{t("Ποιος εκτέλεσε τι στην πύλη ΓεΣΥ, τις τελευταίες 90 ημέρες.", "Who dispensed what on the GHS portal, last 90 days.")}</p>
      </header>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2">{t("Χρήστης πύλης", "Portal user")}</th><th className="px-4 py-2 text-right">{t("Εκτελέσεις", "Dispensings")}</th>
              <th className="px-4 py-2 text-right">{t("Είδη", "Items")}</th><th className="px-4 py-2 text-right">{t("Αξία", "Value")}</th>
              <th className="px-4 py-2">{t("Τελευταία", "Last")}</th></tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((r) => (
              <tr key={r.username ?? "?"} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2"><div className="font-medium">{r.name || "—"}</div><div className="text-xs text-slate-400">{r.username}</div></td>
                <td className="px-4 py-2 text-right">{fmtNum(r.dispensings)}</td>
                <td className="px-4 py-2 text-right">{fmtNum(r.lines)}</td>
                <td className="px-4 py-2 text-right">{fmtEur(r.total_cents)}</td>
                <td className="px-4 py-2">{r.last ? fmtDate(r.last) : "—"}</td>
              </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
