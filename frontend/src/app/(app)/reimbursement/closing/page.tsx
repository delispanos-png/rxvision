"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Receipt, ScissorsLineDashed, Wallet, Banknote, Syringe } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur, fmtMoney } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { KpiCard } from "@/components/kpi/KpiCard";

type Bracket = { from: number; to: number | null; rate: number; base: number; amount: number };
type Deductions = { base: number; rebate: number; rebate_breakdown: Bracket[]; discount: number; discount_breakdown: Bracket[]; receipt: number };
type Fund = { fund: string; is_eopyy: boolean; is_vaccine: boolean; rx: number; retail: number; claim: number; patient: number; rebate: number; discount: number; receipt: number; rebate_base?: number };
type FundDay = { funds: string[]; rows: { day: string; counts: Record<string, number>; total: number }[] };
type Closing = {
  period: string;
  totals: { rx: number; retail: number; claim: number; patient: number; eopyy_claim: number; other_claim: number; gross_profit: number; rebate: number; discount: number; rebate_base: number; receipt: number };
  deductions: Deductions;
  by_fund: Fund[];
  by_fund_day: FundDay;
  by_day: { day: string; rx: number; claim: number }[];
};

const short = (s: string) => (s.length > 26 ? s.slice(0, 24) + "…" : s);
const pct = (r: number) => `${(r * 100).toLocaleString("el-GR")}%`;

function bracketFormula(brk: Bracket[]): string {
  return brk.map((b) => `${fmtEur(b.from)}–${b.to != null ? fmtEur(b.to) : "+"} × ${pct(b.rate)} = ${fmtEur(b.amount)}`).join(" · ");
}

export default function ClosingPage() {
  const t = useT();
  const { period } = useReimbPeriod();
  const { data, isLoading } = useQuery({ queryKey: ["reimb-closing", period], queryFn: () => api<Closing>(`/reimbursement/closing?period=${period}`) });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggleFund = (f: string) => setHidden((prev) => { const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n; });
  const maxDay = Math.max(1,...(data?.by_day ?? []).map((d) => d.rx));
  const ded = data?.deductions;
  const fd = data?.by_fund_day;

  const rebateHelp = ded && ded.rebate_breakdown.length
    ? t(`Rebate (Ν.3918/2011), μόνο ΕΟΠΥΥ φάρμακα (εκτός εμβολίων & ΦΥΚ). Κλιμακωτά στη βάση ${fmtEur(ded.base)}: `, `Rebate on ΕΟΠΥΥ medicines, base ${fmtEur(ded.base)}: `) + bracketFormula(ded.rebate_breakdown) + ` · Σύνολο = ${fmtEur(ded.rebate)}`
    : t("Δεν προκύπτει rebate (βάση < 5.000€).", "No rebate (base < €5,000).");
  const discountHelp = ded && ded.discount_breakdown.length
    ? t(`Έκπτωση βάσει τζίρου (Ν.4052/2012), μόνο >35.000€. Κλιμακωτά στη βάση ${fmtEur(ded.base)}: `, `Turnover discount, base ${fmtEur(ded.base)}: `) + bracketFormula(ded.discount_breakdown) + ` · Σύνολο = ${fmtEur(ded.discount)}`
    : t("Δεν προκύπτει έκπτωση (βάση < 35.000€).", "No discount (base < €35,000).");

  const cols: Column<Fund>[] = [
    { key: "fund", header: t("Ταμείο", "Fund"), render: (r) => <span className="inline-flex items-center gap-1.5" title={r.fund}>{r.is_vaccine ? <Syringe className="h-3.5 w-3.5 text-sky-600" /> : r.is_eopyy ? <Building2 className="h-3.5 w-3.5 text-emerald-600" /> : null}{short(r.fund)}</span> },
    { key: "rx", header: t("Συνταγές", "Rx"), align: "right", sortValue: (r) => r.rx, render: (r) => fmtNum(r.rx) },
    { key: "claim", header: t("Αιτούμενο", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => <b className="text-emerald-700 dark:text-emerald-400">{fmtEur(r.claim)}</b> },
    { key: "rebate", header: "Rebate", align: "right", hideOnMobile: true, sortValue: (r) => r.rebate, render: (r) => r.rebate ? <span className="text-rose-600">−{fmtEur(r.rebate)}</span> : <span className="text-slate-300">—</span> },
    { key: "discount", header: t("Έκπτωση", "Discount"), align: "right", hideOnMobile: true, sortValue: (r) => r.discount, render: (r) => r.discount ? <span className="text-rose-600">−{fmtEur(r.discount)}</span> : <span className="text-slate-300">—</span> },
    { key: "receipt", header: t("Αναμ. είσπραξη", "Expected receipt"), align: "right", sortValue: (r) => r.receipt, render: (r) => <b className="text-indigo-700 dark:text-indigo-400">{fmtEur(r.receipt)}</b> },
    { key: "patient", header: t("Συμμετοχή", "Patient"), align: "right", hideOnMobile: true, sortValue: (r) => r.patient, render: (r) => fmtEur(r.patient) },
  ];

  const fundColor = (i: number) => ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-slate-400", "bg-slate-300"][i] ?? "bg-slate-300";

  return (
    <div className="space-y-5">
      {isLoading ? <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard label={t("Συνταγές", "Rx")} value={fmtNum(data?.totals.rx ?? 0)} icon={Receipt} accent="indigo" help={t("Πλήθος εκτελέσεων του μήνα.", "Executions this month.")} />
            <KpiCard label={t("Αιτούμενο", "Claim")} value={fmtEur(data?.totals.claim ?? 0)} icon={Banknote} accent="green" help={t("Ποσό που αποζημιώνει το ταμείο = Λιανική − Συμμετοχή ασθενούς.", "Fund-reimbursed amount = retail − patient share.")} />
            <KpiCard label="Rebate" value={`−${fmtEur(data?.totals.rebate ?? 0)}`} icon={ScissorsLineDashed} accent="rose" help={rebateHelp} />
            <KpiCard label={t("Έκπτωση τζίρου", "Turnover disc.")} value={`−${fmtEur(data?.totals.discount ?? 0)}`} icon={ScissorsLineDashed} accent="rose" help={discountHelp} />
            <KpiCard label={t("Αναμ. είσπραξη", "Expected receipt")} value={fmtEur(data?.totals.receipt ?? 0)} icon={Wallet} accent="violet" help={t("Αιτούμενο − Rebate − Έκπτωση βάσει τζίρου = το ποσό που τελικά εισπράττει το φαρμακείο.", "Claim − rebate − turnover discount = what the pharmacy actually collects.")} />
            <KpiCard label={t("Συμμετοχή", "Patient")} value={fmtEur(data?.totals.patient ?? 0)} icon={Wallet} accent="amber" help={t("Ποσό που πληρώνει ο ασθενής.", "Patient out-of-pocket.")} />
          </div>

          <div className="rx-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Building2 className="h-4 w-4 text-emerald-600" /> {t("Αιτούμενο & είσπραξη ανά ταμείο", "Claim & receipt per fund")}</h3>
              <ExportMenu filename={`closing-${period}`} title="Monthly Closing" rows={data?.by_fund ?? []} columns={[
                { key: "fund", header: t("Ταμείο", "Fund") },
                { key: "rx", header: "Rx" },
                { key: "claim", header: "Claim (€)", value: (r) => fmtMoney(r.claim) },
                { key: "rebate", header: "Rebate (€)", value: (r) => fmtMoney(r.rebate) },
                { key: "discount", header: "Discount (€)", value: (r) => fmtMoney(r.discount) },
                { key: "receipt", header: "Receipt (€)", value: (r) => fmtMoney(r.receipt) },
              ]} />
            </div>
            <DataTable pageSize={15} columns={cols} rows={data?.by_fund ?? []} rowKey={(r) => r.fund} empty={t("Καμία εγγραφή.", "No data.")} />
            <p className="mt-2 text-xs text-slate-400">{t("Rebate & έκπτωση βάσει τζίρου ισχύουν μόνο στα ΕΟΠΥΥ-Φάρμακα (όχι εμβόλια, όχι ΦΥΚ). Το ΕΤΥΑΠ είναι επιπλέον αιτούμενο (κάλυψη ΕΤΥΑΠ/ΚΥΥΑΠ) χωρίς rebate/έκπτωση.", "Rebate & turnover discount apply only to ΕΟΠΥΥ medicines. ΕΤΥΑΠ is an extra claim (ΕΤΥΑΠ/ΚΥΥΑΠ coverage) with no rebate/discount.")}</p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rx-card p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Building2 className="h-4 w-4 text-emerald-600" /> {t("Εκτελέσεις ανά ταμείο & ημέρα", "Executions per fund & day")}</h3>
              {fd && (() => {
                const visible = fd.funds.filter((f) => !hidden.has(f));
                const rowTotal = (row: FundDay["rows"][0]) => visible.reduce((s, f) => s + (row.counts[f] || 0), 0);
                const max = Math.max(1,...fd.rows.map(rowTotal));
                return (
                  <>
                    <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
                      {fd.funds.map((f, i) => {
                        const off = hidden.has(f);
                        return (
                          <button key={f} onClick={() => toggleFund(f)} title={t("Κλικ για εμφάνιση/απόκρυψη", "Click to show/hide") + ` — ${f}`}
                            className={`inline-flex items-center gap-1 ${off ? "text-slate-300 line-through" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"}`}>
                            <span className={`h-2.5 w-2.5 rounded-sm ${off ? "bg-slate-200 dark:bg-slate-700" : fundColor(i)}`} />{short(f)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex h-32 items-end gap-0.5">
                      {fd.rows.map((row) => {
                        const total = rowTotal(row);
                        const totalPx = Math.round((total / max) * 108);
                        return (
                          <div key={row.day} className="group flex flex-1 flex-col items-center justify-end" title={`${row.day}: ${total}`}>
                            <div className="flex w-full flex-col-reverse overflow-hidden rounded-t" style={{ height: `${totalPx}px` }}>
                              {fd.funds.map((f, i) => {
                                if (hidden.has(f)) return null;
                                const n = row.counts[f] || 0;
                                if (!n) return null;
                                return <div key={f} className={fundColor(i)} style={{ height: `${Math.max(1, Math.round((n / total) * totalPx))}px` }} />;
                              })}
                            </div>
                            <span className="mt-0.5 text-[8px] text-slate-400">{row.day}</span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
            <div className="rx-card p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Αιτούμενο ανά ημέρα", "Claim per day")}</h3>
              <div className="flex h-32 items-end gap-0.5">
                {(data?.by_day ?? []).map((d) => (
                  <div key={d.day} className="group flex flex-1 flex-col items-center justify-end" title={`${d.day}: ${d.rx} (${fmtEur(d.claim)})`}>
                    <div className="w-full rounded-t bg-emerald-400 group-hover:bg-emerald-600" style={{ height: `${Math.max(d.rx ? 2 : 0, Math.round((d.rx / maxDay) * 108))}px` }} />
                    <span className="mt-0.5 text-[8px] text-slate-400">{d.day.slice(8)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
