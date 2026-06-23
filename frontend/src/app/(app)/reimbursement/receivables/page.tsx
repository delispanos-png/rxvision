"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Landmark, Wallet, AlertCircle, ScissorsLineDashed } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { QueryState } from "@/components/ui/QueryState";

type Payment = { amount: number; at?: string | null; note?: string | null };
type Row = {
  period: string; batch_id: string; fund: string; is_eopyy: boolean; rx: number;
  expected: number; payments: Payment[]; paid: number; settled: boolean; cut: number; open: number; status: string;
};
type FundSum = { fund: string; is_eopyy: boolean; expected: number; paid: number; open: number; cut: number };
type Receivables = {
  periods: string[];
  totals: { expected: number; paid: number; open: number; cut: number; settled_count: number; partial_count: number; open_count: number };
  by_fund: FundSum[];
  rows: Row[];
};

const monthLabel = (p: string) => { const [y, m] = p.split("-"); return `${m}/${y}`; };

function CollectControls({ r, onSaved }: { r: Row; onSaved: () => void }) {
  const t = useT();
  const [amt, setAmt] = useState("");
  const mut = useMutation({
    mutationFn: (b: { path: string; payload: object }) => api(`/reimbursement/receivables/${b.path}`, { method: "POST", body: JSON.stringify(b.payload) }),
    onSuccess: onSaved,
  });
  const addPayment = () => {
    const v = parseFloat(amt);
    if (!v) return;
    mut.mutate({ path: "payment", payload: { period: r.period, fund: r.fund, amount: Math.round(v * 100) } });
    setAmt("");
  };
  const toggleSettle = (checked: boolean) => mut.mutate({ path: "settle", payload: { period: r.period, fund: r.fund, settled: checked } });
  const removeLast = () => mut.mutate({ path: "payment/remove", payload: { period: r.period, fund: r.fund, index: r.payments.length - 1 } });

  const paymentsLabel = r.payments.map((p, i) => `${i + 1}η δόση: ${fmtEur(p.amount)}${p.at ? ` (${new Date(p.at).toLocaleDateString("el-GR")})` : ""}`).join("\n");

  return (
    <>
      <td className="px-3 py-2.5 text-right">
        {r.paid > 0 ? (
          <span className="inline-flex items-center gap-1" title={paymentsLabel}>
            <b className="text-emerald-700 dark:text-emerald-400">{fmtEur(r.paid)}</b>
            <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-500 dark:bg-slate-700">{r.payments.length}{t("δ", "p")}</span>
            {!r.settled && <button onClick={removeLast} className="text-slate-300 hover:text-rose-500" title={t("Ακύρωση τελευταίας δόσης", "Undo last payment")}>✕</button>}
          </span>
        ) : <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-right">
        {!r.settled && (
          <div className="flex items-center justify-end gap-1">
            <input type="number" value={amt} onChange={(e) => setAmt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPayment()} placeholder="€"
              className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-right text-sm dark:border-slate-600 dark:bg-slate-800" />
            <button onClick={addPayment} className="rounded-lg bg-sky-600 px-2 py-1 text-xs font-bold leading-none text-white hover:bg-sky-700" title={t("Καταχώρηση δόσης", "Add installment")}>＋</button>
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-center">
        <input type="checkbox" checked={r.settled} onChange={(e) => toggleSettle(e.target.checked)} title={t("Εξόφληση (η διαφορά γίνεται περικοπή)", "Settle (shortfall becomes a cut)")}
          className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-400" />
      </td>
    </>
  );
}

export default function ReceivablesPage() {
  const t = useT();
  const qc = useQueryClient();
  const [months, setMonths] = useState(12);
  const [fund, setFund] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [sortKey, setSortKey] = useState<"period" | "fund" | "expected" | "cut" | "open">("open");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const q = useQuery({ queryKey: ["reimb-receivables", months], queryFn: () => api<Receivables>(`/reimbursement/receivables?months=${months}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["reimb-receivables", months] });

  const toggleSort = (k: typeof sortKey) => {
    if (sortKey === k) setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "period" || k === "fund" ? "asc" : "desc"); }
  };

  const d = q.data;
  const rows = (d?.rows ?? [])
    .filter((r) => (!fund || r.fund === fund) && (!openOnly || !r.settled))
    .sort((a, b) => {
      const va = a[sortKey] as string | number | null, vb = b[sortKey] as string | number | null;
      const cmp = typeof va === "string" ? va.localeCompare(String(vb)) : (Number(va ?? 0) - Number(vb ?? 0));
      return sortDir === "asc" ? cmp : -cmp;
    });

  const SortTh = ({ k, label, align = "left" }: { k: typeof sortKey; label: string; align?: "left" | "right" }) => (
    <th className={`px-4 py-3 ${align === "right" ? "text-right" : "text-left"}`}>
      <button onClick={() => toggleSort(k)} className={`inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 ${sortKey === k ? "font-semibold text-slate-700 dark:text-slate-200" : ""}`}>
        {label}{sortKey === k && <span>{sortDir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Ανοιχτά υπόλοιπα από τα ταμεία", "Open balances owed by funds")}</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium text-slate-500">{t("Περίοδος", "Range")}
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
              className="ml-2 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
              <option value={6}>{t("6 μήνες", "6 months")}</option>
              <option value={12}>{t("12 μήνες", "12 months")}</option>
              <option value={24}>{t("24 μήνες", "24 months")}</option>
              <option value={0}>{t("Όλα", "All")}</option>
            </select>
          </label>
          {d && (
            <select value={fund} onChange={(e) => setFund(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
              <option value="">{t("Όλα τα ταμεία", "All funds")}</option>
              {d.by_fund.map((f) => <option key={f.fund} value={f.fund}>{f.fund}</option>)}
            </select>
          )}
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> {t("Μόνο ανοιχτά", "Open only")}
          </label>
        </div>
      </div>

      <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
        {d && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label={t("Αναμενόμενο σύνολο", "Total expected")} value={fmtEur(d.totals.expected)} icon={Landmark} accent="indigo" />
              <KpiCard label={t("Εισπραγμένο", "Collected")} value={fmtEur(d.totals.paid)} icon={Wallet} accent="green" />
              <KpiCard label={t("Ανοιχτό υπόλοιπο", "Open balance")} value={fmtEur(d.totals.open)} icon={AlertCircle} accent="amber"
                sub={t(`${d.totals.open_count} εκκρεμή`, `${d.totals.open_count} open`)}
                help={t("Όσα δεν έχουν σημειωθεί ως εισπραγμένα — αυτά οφείλουν ακόμη τα ταμεία.", "Receivables not yet marked collected — still owed by the funds.")} />
              <KpiCard label={t("Περικοπές", "Cuts")} value={fmtEur(d.totals.cut)} icon={ScissorsLineDashed} accent="rose" />
            </div>

            {/* per-fund open balance */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Ανοιχτό υπόλοιπο ανά ταμείο", "Open balance by fund")}</h4>
              <div className="space-y-2">
                {d.by_fund.filter((f) => f.open > 0).length === 0 && <div className="text-sm text-slate-400">{t("Κανένα ανοιχτό υπόλοιπο 🎉", "No open balance 🎉")}</div>}
                {d.by_fund.filter((f) => f.open > 0).map((f) => {
                  const max = Math.max(1, ...d.by_fund.map((x) => x.open));
                  return (
                    <div key={f.fund}>
                      <div className="mb-0.5 flex items-center justify-between text-xs">
                        <button onClick={() => setFund(f.fund)} className="truncate pr-2 text-slate-600 hover:text-indigo-600 dark:text-slate-300">{f.fund}</button>
                        <span className="font-semibold text-amber-600">{fmtEur(f.open)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div className="h-full rounded-full bg-amber-500" style={{ width: `${(f.open / max) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* per (month, fund) table */}
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/60">
                  <tr>
                    <SortTh k="period" label={t("Μήνας", "Month")} />
                    <SortTh k="fund" label={t("Ταμείο", "Fund")} />
                    <SortTh k="expected" label={t("Αναμενόμενο", "Expected")} align="right" />
                    <th className="px-3 py-3 text-right">{t("Εισπραγμένο", "Collected")}</th>
                    <th className="px-3 py-3 text-right">{t("Νέα δόση", "New installment")}</th>
                    <th className="px-3 py-3 text-center">{t("Εξόφληση", "Settle")}</th>
                    <SortTh k="cut" label={t("Περικοπή", "Cut")} align="right" />
                    <SortTh k="open" label={t("Ανοιχτό", "Open")} align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr key={r.batch_id} className={r.settled ? "bg-emerald-50/40 dark:bg-emerald-950/10" : r.paid > 0 ? "bg-amber-50/30 dark:bg-amber-950/10" : ""}>
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-700 dark:text-slate-200">{monthLabel(r.period)}</td>
                      <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">
                        {r.fund}{r.is_eopyy && <span className="ml-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">ΕΟΠΥΥ</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600 dark:text-slate-300">{fmtEur(r.expected)}</td>
                      <CollectControls r={r} onSaved={refresh} />
                      <td className="px-4 py-2.5 text-right">{r.cut ? <b className="text-rose-600">{fmtEur(r.cut)}</b> : <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-2.5 text-right font-semibold">{r.open ? <span className="text-amber-600">{fmtEur(r.open)}</span> : <span className="text-emerald-600">✓</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400">{t("Η εξόφληση ΕΟΠΥΥ γίνεται συνήθως σε 2 δόσεις: γράψε κάθε δόση στο «Νέα δόση» (＋) — μειώνεται το ανοιχτό υπόλοιπο. Όταν ολοκληρωθεί, τσέκαρε «Εξόφληση»: η διαφορά από το αναμενόμενο γίνεται περικοπή και το υπόλοιπο μηδενίζεται.", "ΕΟΠΥΥ usually pays in 2 installments: add each via «New installment» (＋). When done, tick «Settle»: the shortfall vs expected becomes a cut and the balance clears.")}</p>
          </>
        )}
      </QueryState>
    </div>
  );
}
