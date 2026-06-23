"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, TrendingUp, ScissorsLineDashed, Wallet, Syringe } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Row = {
  fund: string; is_eopyy: boolean; is_vaccine: boolean;
  avg_3m: number; avg_3m_ly: number; ly_month: number; deviation: number;
  forecast: number; rebate: number; discount: number; receipt: number;
};
type FC = { target: string; a_months: string[]; b_months: string[]; ly_month: string; by_fund: Row[]; forecast_total: number; receipt_total: number; rebate_total: number; discount_total: number };

const ml = (p: string) => { const [y, m] = p.split("-"); return `${m}/${y}`; };
const short = (s: string) => (s.length > 26 ? s.slice(0, 24) + "…" : s);
const pct = (r: number) => `${(r * 100).toLocaleString("el-GR", { maximumFractionDigits: 2 })}%`;

export default function ForecastPage() {
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: ["reimb-forecast"], queryFn: () => api<FC>("/reimbursement/forecast") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Υπολογισμός πρόβλεψης…", "Forecasting…")}</div>;

  const formula = (r: Row) =>
    `Α (μ.ο. ${(data?.a_months ?? []).map(ml).join(", ")}) = ${fmtEur(r.avg_3m)}\n` +
    `Β (μ.ο. ίδιων μηνών πέρσι) = ${fmtEur(r.avg_3m_ly)}\n` +
    `Γ (${ml(data?.ly_month ?? "")}) = ${fmtEur(r.ly_month)}\n` +
    `Δ = (Γ−Β)/Β = ${pct(r.deviation)}\n` +
    `Πρόβλεψη = Α × (1+Δ) = ${fmtEur(r.forecast)}`;

  const cols: Column<Row>[] = [
    { key: "fund", header: t("Ταμείο", "Fund"), render: (r) => <span className="inline-flex items-center gap-1.5" title={r.fund}>{r.is_vaccine ? <Syringe className="h-3.5 w-3.5 text-sky-600" /> : r.is_eopyy ? <Building2 className="h-3.5 w-3.5 text-emerald-600" /> : null}{short(r.fund)}</span> },
    { key: "forecast", header: t("Αναμ. μηνιαίο αιτούμενο", "Forecast claim"), align: "right", sortValue: (r) => r.forecast, render: (r) => <b className="cursor-help border-b border-dotted border-slate-300 text-emerald-700 dark:text-emerald-400" title={formula(r)}>{fmtEur(r.forecast)}</b> },
    { key: "rebate", header: "Rebate", align: "right", hideOnMobile: true, sortValue: (r) => r.rebate, render: (r) => r.rebate ? <span className="text-rose-600">−{fmtEur(r.rebate)}</span> : <span className="text-slate-300">—</span> },
    { key: "discount", header: t("Έκπτ. τζίρου", "Turnover disc."), align: "right", hideOnMobile: true, sortValue: (r) => r.discount, render: (r) => r.discount ? <span className="text-rose-600">−{fmtEur(r.discount)}</span> : <span className="text-slate-300">—</span> },
    { key: "receipt", header: t("Αναμ. είσπραξη", "Expected receipt"), align: "right", sortValue: (r) => r.receipt, render: (r) => <b className="text-indigo-700 dark:text-indigo-400">{fmtEur(r.receipt)}</b> },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label={t("Αναμ. μηνιαίο αιτούμενο", "Forecast claim")} value={fmtEur(data?.forecast_total ?? 0)} icon={TrendingUp} accent="green"
          help={t(`Πρόβλεψη αιτούμενου ${ml(data?.target ?? "")} ανά ταμείο: Α×(1+Δ), όπου Α=μ.ο. 3μήνου, Δ=περσινή εποχική απόκλιση.`, "Forecast claim via A×(1+Δ).")} />
        <KpiCard label="Rebate" value={`−${fmtEur(data?.rebate_total ?? 0)}`} icon={ScissorsLineDashed} accent="rose" help={t("Εκτιμώμενο rebate επί της πρόβλεψης (ΕΟΠΥΥ-Φάρμακα).", "Estimated rebate on the forecast.")} />
        <KpiCard label={t("Έκπτωση τζίρου", "Turnover disc.")} value={`−${fmtEur(data?.discount_total ?? 0)}`} icon={ScissorsLineDashed} accent="rose" help={t("Εκτιμώμενη έκπτωση βάσει τζίρου επί της πρόβλεψης.", "Estimated turnover discount on the forecast.")} />
        <KpiCard label={t("Αναμ. είσπραξη", "Expected receipt")} value={fmtEur(data?.receipt_total ?? 0)} icon={Wallet} accent="violet" help={t("Πρόβλεψη αιτούμενου − Rebate − Έκπτωση = τι θα εισπράξει τελικά το φαρμακείο.", "Forecast − rebate − discount = what the pharmacy will collect.")} />
      </div>
      <p className="text-sm text-slate-500">
        {t(`Πρόβλεψη για ${ml(data?.target ?? "")}, ανά ταμείο. Πέρασε τον δείκτη πάνω στο «Αναμ. μηνιαίο αιτούμενο» για τον αναλυτικό τύπο (Α/Β/Γ/Δ).`,
          `Forecast for ${ml(data?.target ?? "")}, per fund. Hover the forecast for the full formula.`)}
      </p>
      <DataTable pageSize={20} columns={cols} rows={data?.by_fund ?? []} rowKey={(r) => r.fund} empty={t("Καμία εγγραφή.", "No data.")} />
    </div>
  );
}
