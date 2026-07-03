"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { fmtNum, fmtEur } from "@/lib/formatters";

type ReportDay = { date: string; rx: number; claim: number; retail: number; patient: number };
type ReportFund = { fund: string; is_eopyy: boolean; is_vaccine: boolean; rx: number; retail: number; claim: number; patient: number; rebate: number; discount: number; receipt: number; not_submitted?: boolean; invoice: { issue: boolean; amount?: number; text: string }; days: ReportDay[] };
type Report = { period: string; funds: ReportFund[]; grand: { rx: number; claim: number; retail: number; receipt: number } };

const grDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

// Αναλυτική εκτύπωση/άποψη κλεισίματος — ανά ταμείο × ημέρα + οδηγία τιμολογίου + γενικό σύνολο.
// Ζωντανό (τρέχων μήνας χωρίς «κλείσιμο»). Εκτυπώνεται μόνο του (print CSS απομονώνει το #closing-report).
export function ClosingReportModal({ period, t, onClose }: { period: string; t: (el: string, en: string) => string; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ["reimb-closing-report", period], queryFn: () => api<Report>(`/reimbursement/closing/report?period=${period}`) });
  return (
    <div className="fixed inset-0 z-[60] overflow-auto bg-black/40 p-3 print:static print:overflow-visible print:bg-white print:p-0" onClick={onClose}>
      <style>{`@media print { body { visibility: hidden !important } #closing-report, #closing-report * { visibility: visible !important } #closing-report { position: absolute; left: 0; top: 0; width: 100% } .no-print { display: none !important } }`}</style>
      <div className="mx-auto max-w-4xl rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900 print:max-w-none print:rounded-none print:p-0 print:shadow-none" onClick={(e) => e.stopPropagation()}>
        <div className="no-print mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t("Αναλυτικό Κλείσιμο", "Detailed closing")} — {period}</h2>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">🖨️ {t("Εκτύπωση", "Print")}</button>
            <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">{t("Κλείσιμο", "Close")}</button>
          </div>
        </div>
        {isLoading ? <div className="p-8 text-center text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
          <div id="closing-report" className="text-slate-800 dark:text-slate-100 print:text-black">
            <div className="mb-4 border-b border-slate-300 pb-2">
              <div className="text-xl font-bold">{t("Αναλυτικό Κλείσιμο Μήνα", "Monthly Closing — detailed")} · {period}</div>
              <div className="text-xs text-slate-500">{t("Διαδικασία κατάθεσης ανά ταμείο & ημέρα — τι τιμολόγιο να εκδοθεί σε κάθε ταμείο.", "Submission per fund & day — which invoice to issue to each fund.")}</div>
            </div>
            {(data?.funds ?? []).map((f) => (
              <section key={f.fund} className="mb-5 break-inside-avoid">
                <h3 className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm font-bold">
                  <span>{f.not_submitted ? "💯 " : ""}{f.fund}</span>
                  <span className="text-slate-500">{fmtNum(f.rx)} {t("συνταγές", "Rx")} · {t("Αιτούμενο", "Claim")} <b className="text-emerald-700">{fmtEur(f.claim)}</b></span>
                </h3>
                <div className={`mb-2 rounded-lg border px-3 py-1.5 text-[12px] ${f.invoice.issue ? "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"}`}>
                  🧾 <b>{f.invoice.issue ? t("Τιμολόγιο:", "Invoice:") : t("Χωρίς τιμολόγιο:", "No invoice:")}</b> {f.invoice.text}
                </div>
                {f.days.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="border-b border-slate-300 text-left text-slate-500">
                          <th className="py-1 pr-2">{t("Ημ/νία", "Date")}</th>
                          <th className="py-1 px-2 text-right">{t("Συνταγές", "Rx")}</th>
                          <th className="py-1 px-2 text-right">{t("Αιτούμενο", "Claim")}</th>
                          <th className="py-1 px-2 text-right">{t("Λιανική", "Retail")}</th>
                          <th className="py-1 pl-2 text-right">{t("Συμμετοχή", "Patient")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {f.days.map((d) => (
                          <tr key={d.date} className="border-b border-slate-100 dark:border-slate-800">
                            <td className="py-0.5 pr-2">{grDate(d.date)}</td>
                            <td className="py-0.5 px-2 text-right">{fmtNum(d.rx)}</td>
                            <td className="py-0.5 px-2 text-right font-medium text-emerald-700 dark:text-emerald-400">{fmtEur(d.claim)}</td>
                            <td className="py-0.5 px-2 text-right text-slate-500">{fmtEur(d.retail)}</td>
                            <td className="py-0.5 pl-2 text-right text-slate-500">{fmtEur(d.patient)}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-slate-300 font-bold">
                          <td className="py-1 pr-2">{t("Σύνολο", "Total")}</td>
                          <td className="py-1 px-2 text-right">{fmtNum(f.rx)}</td>
                          <td className="py-1 px-2 text-right text-emerald-700">{fmtEur(f.claim)}</td>
                          <td className="py-1 px-2 text-right">{fmtEur(f.retail)}</td>
                          <td className="py-1 pl-2 text-right">{fmtEur(f.patient)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ))}
            <div className="mt-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30 print:bg-white">
              <div className="text-sm font-bold text-emerald-900 dark:text-emerald-200">{t("ΓΕΝΙΚΟ ΣΥΝΟΛΟ (υποβαλλόμενες)", "GRAND TOTAL (submitted)")}</div>
              <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span>{t("Συνταγές", "Rx")}: <b>{fmtNum(data?.grand.rx ?? 0)}</b></span>
                <span>{t("Αιτούμενο", "Claim")}: <b className="text-emerald-700">{fmtEur(data?.grand.claim ?? 0)}</b></span>
                <span>{t("Λιανική", "Retail")}: <b>{fmtEur(data?.grand.retail ?? 0)}</b></span>
                <span>{t("Αναμ. είσπραξη", "Expected receipt")}: <b className="text-indigo-700">{fmtEur(data?.grand.receipt ?? 0)}</b></span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
