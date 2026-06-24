"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Users, UserPlus, UserMinus, Receipt, Wallet, Coins, Activity, PhoneCall, RotateCcw, Crown,
  Sparkles, AlertTriangle, ArrowRight, Brain, UserCheck,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { Tooltip } from "@/components/ui/Tooltip";

type Kpi = { value: number; delta: number | null };
type Overview = {
  kpis: Record<string, Kpi>;
  total_patients: number; recall_recoverable: number;
  winback: { bucket: number; count: number; lost_revenue: number; recoverable: number }[];
  vip: { tier: string; label: string; count: number; revenue: number }[];
  compliance_distribution: { band: string; label: string; count: number }[];
  trend: Record<"daily" | "weekly" | "monthly", { label: string; rx: number; value: number }[]>;
  insights: { icon: string; severity: string; title: string; text: string; cta: { label: string; href: string } | null }[];
};

const SEV: Record<string, string> = {
  opportunity: "border-brand-200 bg-brand-50/60 dark:border-brand-800 dark:bg-brand-950/40",
  critical: "border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/40",
  positive: "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/30",
  info: "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900",
};
const SEV_ICON: Record<string, string> = { opportunity: "text-brand-600", critical: "text-rose-600", positive: "text-emerald-600", info: "text-slate-500" };
const TIER: Record<string, string> = { platinum: "from-slate-300 to-slate-500", gold: "from-amber-300 to-amber-500", silver: "from-slate-200 to-slate-400", bronze: "from-orange-300 to-orange-500" };
const BAND: Record<string, string> = { excellent: "bg-emerald-500", good: "bg-lime-500", medium: "bg-amber-500", risk: "bg-orange-500", critical: "bg-rose-500" };

export default function IntelligenceDashboard() {
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["pi-overview"], queryFn: () => api<Overview>("/patient-intelligence/overview") });
  const [tv, setTv] = useState<"daily" | "weekly" | "monthly">("monthly");
  const k = data?.kpis;
  const go = (href: string) => router.push(href);

  if (isLoading) return <div className="p-8 text-slate-400">{t("Ανάλυση δεδομένων…", "Analyzing…")}</div>;

  const cards: { key: string; label: string; en: string; icon: typeof Users; accent: "indigo" | "sky" | "rose" | "violet" | "amber" | "green" | "orange"; money?: boolean; suffix?: string; href?: string; help: string; helpEn: string }[] = [
    { key: "active_60d", label: "Ενεργοί (60ημ)", en: "Active (60d)", icon: Users, accent: "indigo", href: "/intelligence/patients", help: "Πελάτες που εξυπηρετήθηκαν τις τελευταίες 60 ημέρες.", helpEn: "Patients served in the last 60 days." },
    { key: "new_month", label: "Νέοι ασθενείς", en: "New patients", icon: UserPlus, accent: "sky", help: "Πελάτες που εκτέλεσαν για πρώτη φορά συνταγή στο φαρμακείο σου αυτόν τον μήνα.", helpEn: "Patients with their first prescription this month." },
    { key: "returns", label: "Επιστροφές", en: "Returns", icon: UserCheck, accent: "green", href: "/intelligence/returns", help: "Ανενεργοί πελάτες που ξαναγύρισαν στο φαρμακείο.", helpEn: "Inactive patients who returned." },
    { key: "lost_patients", label: "Χαμένοι ασθενείς", en: "Lost patients", icon: UserMinus, accent: "rose", href: "/intelligence/winback", help: "Πελάτες που έχουν να εμφανιστούν πολύ καιρό (πέρα από το διάστημα της αγωγής τους).", helpEn: "Patients absent well beyond their therapy interval." },
    { key: "rx_month", label: "Συνταγές μήνα", en: "Prescriptions (month)", icon: Receipt, accent: "violet", help: "Πλήθος εκτελέσεων συνταγών αυτόν τον μήνα.", helpEn: "Number of prescriptions executed this month." },
    { key: "avg_rx_value", label: "Μέση αξία συνταγής", en: "Avg prescription value", icon: Wallet, accent: "amber", money: true, help: "Μέση λιανική αξία ανά εκτελεσμένη συνταγή (συνολική αξία ÷ πλήθος συνταγών).", helpEn: "Average retail value per prescription." },
    { key: "revenue_per_patient", label: "Έσοδα ανά ασθενή", en: "Revenue per patient", icon: Coins, accent: "green", money: true, help: "Μέση συνολική αξία που αφήνει κάθε πελάτης (συνολικός τζίρος ÷ πλήθος πελατών).", helpEn: "Average total value per patient." },
    { key: "compliance_score", label: "Compliance Score", en: "Compliance Score", icon: Activity, accent: "indigo", suffix: "/100", href: "/intelligence/compliance", help: "Μέση συνέπεια των χρόνιων ασθενών: πόσες από τις αναμενόμενες επαναλήψεις τους εκτελέστηκαν εγκαίρως (0–100).", helpEn: "Average adherence of chronic patients (0–100)." },
    { key: "recall_patients", label: "Προς Recall", en: "To Recall", icon: PhoneCall, accent: "orange", href: "/intelligence/recall", help: "Πελάτες με συνταγή που ανοίγει τώρα/σύντομα — αξίζει να τους θυμίσεις να περάσουν.", helpEn: "Patients with a refill opening now/soon." },
    { key: "winback_revenue", label: "Win-Back έσοδα", en: "Win-Back revenue", icon: RotateCcw, accent: "green", money: true, href: "/intelligence/winback", help: "Δυνητικά έσοδα αν επαναφέρεις τους χαμένους πελάτες (αξία των αγωγών που έχασαν).", helpEn: "Potential revenue from winning back lost patients." },
    { key: "vip_patients", label: "VIP ασθενείς", en: "VIP patients", icon: Crown, accent: "amber", href: "/intelligence/vip", help: "Οι κορυφαίοι πελάτες σε συνολική αξία (κατηγορίες Platinum 5% + Gold 10% της πελατείας).", helpEn: "Top patients by total value (Platinum + Gold)." },
  ];

  const series = data?.trend[tv] ?? [];
  const maxTrend = Math.max(1,...series.map((m) => m.rx));
  const compTotal = (data?.compliance_distribution ?? []).reduce((s, b) => s + b.count, 0) || 1;

  return (
    <div className="space-y-6">
      {/* AI INSIGHTS */}
      {!!data?.insights.length && (
        <div>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500"><Sparkles className="h-4 w-4 text-brand-600" /> {t("AI Insights", "AI Insights")}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {data.insights.map((i, idx) => (
              <div key={idx} className={`flex items-start gap-3 rounded-2xl border p-4 shadow-card ${SEV[i.severity] ?? SEV.info}`}>
                <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white dark:bg-slate-800 ${SEV_ICON[i.severity] ?? SEV_ICON.info}`}>
                  {i.severity === "critical" ? <AlertTriangle className="h-5 w-5" /> : <Brain className="h-5 w-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{i.title}</h3>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">{i.text}</p>
                  {i.cta && <button onClick={() => go(i.cta!.href)} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">{i.cta.label} <ArrowRight className="h-3.5 w-3.5" /></button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* KPI GRID */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {k && cards.map((c) => (
          <KpiCard key={c.key} label={t(c.label, c.en)} help={t(c.help, c.helpEn)}
            value={c.money ? fmtEur(k[c.key]?.value ?? 0) : `${fmtNum(k[c.key]?.value ?? 0)}${c.suffix ?? ""}`}
            icon={c.icon} accent={c.accent} trend={k[c.key]?.delta ?? undefined}
            onClick={c.href ? () => go(c.href!) : undefined} />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* WIN-BACK */}
        <div className="rx-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><RotateCcw className="h-4 w-4 text-brand-600" /> {t("Win-Back ανά αδράνεια", "Win-Back by inactivity")}</h3>
            <button onClick={() => go("/intelligence/winback")} className="text-xs font-medium text-brand-700 hover:underline">{t("Άνοιγμα", "Open")} →</button>
          </div>
          <div className="space-y-2">
            {(data?.winback ?? []).map((b) => (
              <div key={b.bucket} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{b.bucket} {t("ημέρες", "days")}</span>
                <span className="text-xs text-slate-500">{fmtNum(b.count)} {t("ασθενείς", "patients")}</span>
                <span className="ml-auto text-sm font-bold text-emerald-600">{fmtEur(b.recoverable)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* VIP TIERS */}
        <div className="rx-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Crown className="h-4 w-4 text-amber-500" /> {t("VIP κατηγορίες", "VIP tiers")}
              <Tooltip label={t("Κατάταξη όλων των πελατών σου με βάση τη ΣΥΝΟΛΙΚΗ ΑΞΙΑ (τζίρο) που έχουν αφήσει, από τον μεγαλύτερο στον μικρότερο. Χωρίζονται σε: Platinum = κορυφαίο 5%, Gold = επόμενο 10%, Silver = επόμενο 20%, Bronze = υπόλοιπο 65%. Όσοι δεν έχουν αγορές εξαιρούνται.", "Customers ranked by total value: Platinum top 5%, Gold next 10%, Silver next 20%, Bronze rest.")}>
                <span className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-slate-300 text-[9px] font-bold text-slate-400 hover:border-brand-400 hover:text-brand-500">i</span>
              </Tooltip>
            </h3>
            <button onClick={() => go("/intelligence/vip")} className="text-xs font-medium text-brand-700 hover:underline">{t("Άνοιγμα", "Open")} →</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(data?.vip ?? []).map((tr) => (
              <div key={tr.tier} className={`rounded-xl bg-gradient-to-br ${TIER[tr.tier]} p-3 text-white shadow`}>
                <div className="text-xs font-semibold uppercase opacity-90">{tr.label}</div>
                <div className="text-xl font-bold">{fmtNum(tr.count)}</div>
                <div className="text-xs opacity-90">{fmtEur(tr.revenue)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* COMPLIANCE DISTRIBUTION */}
        <div className="rx-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Activity className="h-4 w-4 text-brand-600" /> {t("Κατανομή συμμόρφωσης", "Compliance distribution")}</h3>
            <button onClick={() => go("/intelligence/compliance")} className="text-xs font-medium text-brand-700 hover:underline">{t("Άνοιγμα", "Open")} →</button>
          </div>
          <div className="mb-2 flex h-4 overflow-hidden rounded-full">
            {(data?.compliance_distribution ?? []).map((b) => b.count > 0 && (
              <Tooltip key={b.band} label={`${b.label}: ${b.count}`}><div className={BAND[b.band]} style={{ width: `${(b.count / compTotal) * 100}%` }} /></Tooltip>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
            {(data?.compliance_distribution ?? []).map((b) => (
              <span key={b.band} className="inline-flex items-center gap-1.5 text-slate-500"><span className={`h-2.5 w-2.5 rounded-full ${BAND[b.band]}`} /> {b.label}: <b className="text-slate-700 dark:text-slate-200">{b.count}</b></span>
            ))}
          </div>
        </div>

        {/* TREND — daily / weekly / monthly */}
        <div className="rx-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Receipt className="h-4 w-4 text-brand-600" /> {t("Τάση συνταγών", "Prescriptions trend")}</h3>
            <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
              {(["daily", "weekly", "monthly"] as const).map((v) => (
                <button key={v} onClick={() => setTv(v)} className={`rounded px-2 py-0.5 font-medium ${tv === v ? "bg-brand-600 text-white" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}>
                  {t({ daily: "Ημέρα", weekly: "Εβδ.", monthly: "Μήνας" }[v], { daily: "Day", weekly: "Wk", monthly: "Month" }[v])}
                </button>
              ))}
            </div>
          </div>
          <div className="flex h-28 items-end gap-1">
            {series.map((m) => (
              <Tooltip key={m.label} label={`${m.label}: ${m.rx}`}><div className="group flex flex-1 flex-col items-center justify-end">
                <div className="w-full rounded-t bg-brand-400 transition-all group-hover:bg-brand-600" style={{ height: `${(m.rx / maxTrend) * 100}%`, minHeight: m.rx ? "3px" : "0" }} />
                <span className="mt-1 truncate text-[9px] text-slate-400">{tv === "monthly" ? m.label.slice(5) : tv === "daily" ? m.label.slice(8) : m.label.slice(6)}</span>
              </div></Tooltip>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
