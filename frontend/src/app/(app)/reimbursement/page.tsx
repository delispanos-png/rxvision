"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Receipt, Wallet, Landmark, Coins, TrendingUp, ShieldAlert, AlertTriangle, Calculator,
  Building2, ScissorsLineDashed, Wrench, FileWarning,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";

type Exec = {
  period: string;
  kpis: Record<string, number>;
  delta_prev: Record<string, number | null>;
  delta_yoy: Record<string, number | null>;
  insights: { severity: string; icon: string; text: string }[];
};

const SEV: Record<string, string> = {
  critical: "border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/40",
  warning: "border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/30",
  info: "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900",
};
const SEV_ICON: Record<string, string> = { critical: "text-rose-600", warning: "text-amber-600", info: "text-slate-500" };

export default function ReimbursementExecutive() {
  const t = useT();
  const router = useRouter();
  const { period } = useReimbPeriod();
  const { data, isLoading } = useQuery({ queryKey: ["reimb-exec", period], queryFn: () => api<Exec>(`/reimbursement/executive?period=${period}`) });
  const k = data?.kpis;
  const dp = data?.delta_prev;

  return (
    <div className="space-y-6">
      {isLoading ? <div className="p-8 text-slate-400">{t("Έλεγχος αποζημίωσης…", "Auditing reimbursement…")}</div> : (
        <>
          {/* AI AUDITOR */}
          {!!data?.insights.length && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500"><ShieldAlert className="h-4 w-4 text-emerald-600" /> {t("AI Auditor", "AI Auditor")}</h2>
              <div className="grid gap-3 md:grid-cols-2">
                {data.insights.map((i, idx) => (
                  <div key={idx} className={`flex items-start gap-3 rounded-2xl border p-4 shadow-card ${SEV[i.severity] ?? SEV.info}`}>
                    <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white dark:bg-slate-800 ${SEV_ICON[i.severity] ?? SEV_ICON.info}`}>
                      {i.severity === "critical" ? <ShieldAlert className="h-5 w-5" /> : i.severity === "warning" ? <AlertTriangle className="h-5 w-5" /> : <Calculator className="h-5 w-5" />}
                    </span>
                    <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{i.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* FINANCIALS */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            <KpiCard label={t("Συνταγές μήνα", "Prescriptions")} help={t("Πλήθος εκτελέσεων του μήνα.", "Executions for the month.")} value={fmtNum(k?.rx ?? 0)} icon={Receipt} accent="indigo" trend={dp?.rx ?? undefined} />
            <KpiCard label={t("Λιανική αξία", "Retail value")} help={t("Άθροισμα λιανικής αξίας των εκτελέσεων.", "Sum of retail value.")} value={fmtEur(k?.retail ?? 0)} icon={Wallet} accent="violet" trend={dp?.retail ?? undefined} />
            <KpiCard label={t("Συνολική απαίτηση", "Total claim")} help={t("Συνολικό αιτούμενο ποσό προς όλα τα ταμεία.", "Total amount claimed to all funds.")} value={fmtEur(k?.claim ?? 0)} icon={Landmark} accent="green" trend={dp?.claim ?? undefined} />
            <KpiCard label={t("Συμμετοχή ασφ/νου", "Patient share")} help={t("Ποσό που πλήρωσαν οι ασθενείς από την τσέπη.", "Out-of-pocket patient share.")} value={fmtEur(k?.patient ?? 0)} icon={Coins} accent="amber" trend={dp?.patient ?? undefined} />
            <KpiCard label={t("Απαίτηση ΕΟΠΥΥ", "ΕΟΠΥΥ claim")} help={t("Άθροισμα αιτούμενου μόνο προς ΕΟΠΥΥ.", "Sum claimed to ΕΟΠΥΥ only.")} value={fmtEur(k?.eopyy_claim ?? 0)} icon={Building2} accent="sky" />
            <KpiCard label={t("Απαίτηση λοιπά ταμεία", "Other funds claim")} help={t("Άθροισμα αιτούμενου προς τα υπόλοιπα ταμεία (εκτός ΕΟΠΥΥ).", "Sum claimed to other funds.")} value={fmtEur(k?.other_claim ?? 0)} icon={Building2} accent="indigo" />
            <KpiCard label={t("Μεικτό κέρδος", "Gross profit")} help={t("Αιτούμενο/αξία − κόστος χονδρικής των φαρμάκων.", "Claimed/value − wholesale cost.")} value={fmtEur(k?.gross_profit ?? 0)} icon={TrendingUp} accent="green" />
          </div>

          {/* AUDIT / RISK */}
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{t("Έλεγχος πριν την υποβολή", "Pre-submission control")}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label={t("Πιθανές περικοπές", "Expected cuts")} help={t("Συνταγές με πιθανότητα περικοπής από τον έλεγχο ταμείου.", "Prescriptions at risk of being cut.")} value={fmtEur(k?.expected_cuts ?? 0)} icon={ScissorsLineDashed} accent="rose" onClick={() => router.push("/reimbursement/risk")} />
              <KpiCard label={t("Προς διόρθωση", "To fix")} help={t("Συνταγές που χρειάζονται διόρθωση πριν την υποβολή.", "Prescriptions needing correction.")} value={fmtNum(k?.to_fix ?? 0)} icon={Wrench} accent="rose" onClick={() => router.push("/reimbursement/risk")} />
              <KpiCard label={t("Μερικές εκτελέσεις", "Partial executions")} help={t("Συνταγές που εκτελέστηκαν μερικώς.", "Partially executed prescriptions.")} value={fmtNum(k?.partial ?? 0)} icon={FileWarning} accent="indigo" sub={t("ενημερωτικό · νόμιμο (όχι περικοπή)", "informational · lawful (not a cut)")} />
              <KpiCard label={t("Ασυμφωνίες ποσών", "Amount mismatches")} help={t("Συνταγές με ασυμφωνία ποσών (ταμείο+συμμετοχή ≠ λιανική).", "Prescriptions with amount mismatch.")} value={fmtNum(k?.mismatch ?? 0)} icon={Calculator} accent="amber" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
