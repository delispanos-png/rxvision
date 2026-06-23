"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Syringe, ShieldAlert, Users, CheckCircle2, ArrowRight, CalendarRange } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum } from "@/lib/formatters";
import { QueryState } from "@/components/ui/QueryState";
import { KpiCard } from "@/components/kpi/KpiCard";

type Campaign = {
  name: string; season: string; period_start: string; period_end: string;
  rollout: { age_group: string; opens_at: string }[]; priority_icd: string[];
};
type AgeRow = { age_group: string; pending: number; vaccinated: number; open: boolean };
type Worklist = {
  total: number;
  counts: { pending: number; vaccinated: number; high_risk_pending: number };
  by_age: AgeRow[];
};

const fmtDate = (s?: string) => (s ? new Date(s).toLocaleDateString("el-GR") : "—");

export default function VaccinationOverviewPage() {
  const t = useT();
  const camp = useQuery({ queryKey: ["vacc-campaign"], queryFn: () => api<Campaign>("/vaccinations/campaign") });
  const wl = useQuery({ queryKey: ["vacc-overview"], queryFn: () => api<Worklist>("/vaccinations/worklist?page=1&page_size=1") });

  const c = wl.data?.counts;
  const base = c ? c.pending + c.vaccinated : 0;
  const coverage = base ? Math.round((c!.vaccinated / base) * 100) : 0;

  return (
    <div>
      {camp.data && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-100 bg-sky-50 px-5 py-4 dark:border-sky-900/40 dark:bg-sky-950/30">
          <div className="flex items-center gap-3">
            <CalendarRange className="h-5 w-5 text-sky-600" />
            <div>
              <div className="font-semibold text-slate-800 dark:text-slate-100">{camp.data.name}</div>
              <div className="text-xs text-slate-500">{t("Περίοδος", "Period")}: {fmtDate(camp.data.period_start)} – {fmtDate(camp.data.period_end)} · {t("Σεζόν", "Season")} {camp.data.season}</div>
            </div>
          </div>
          <Link href="/vaccinations/settings" className="rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-50 dark:bg-slate-900">{t("Ρυθμίσεις campaign", "Campaign settings")}</Link>
        </div>
      )}

      <QueryState isLoading={wl.isLoading} isError={wl.isError} onRetry={() => wl.refetch()}>
        {c && (
          <>
            <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
              <KpiCard label={t("Εκκρεμείς στόχοι", "Pending targets")} value={fmtNum(c.pending)} icon={Syringe} accent="sky"
                help={t("Πελάτες που δεν έχουν εμβολιαστεί ακόμη αυτή τη σεζόν.", "Customers not yet vaccinated this season.")} />
              <KpiCard label={t("Υψηλού κινδύνου εκκρεμείς", "High-risk pending")} value={fmtNum(c.high_risk_pending)} icon={ShieldAlert} accent="rose"
                help={t("Εκκρεμείς με αναπνευστικά/χρόνια ICD-10 στο ιστορικό — απόλυτη προτεραιότητα.", "Pending with respiratory/chronic ICD-10 history — top priority.")} />
              <KpiCard label={t("Εμβολιασμένοι σεζόν", "Vaccinated this season")} value={fmtNum(c.vaccinated)} icon={CheckCircle2} accent="green" />
              <KpiCard label={t("Κάλυψη", "Coverage")} value={`${coverage}%`} icon={Users} accent="violet"
                help={t("Εμβολιασμένοι ως ποσοστό της πελατειακής βάσης.", "Vaccinated as a share of the customer base.")} />
            </div>

            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Ανά ηλικιακή ομάδα (μεγαλύτεροι πρώτα)", "By age group (older first)")}</h3>
              <Link href="/vaccinations/targets" className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700">
                {t("Λίστα στόχων", "Open worklist")} <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"><tr>
                  <th className="px-4 py-2 text-left">{t("Ηλικία", "Age")}</th>
                  <th className="px-4 py-2 text-left">{t("Κατάσταση", "Status")}</th>
                  <th className="px-4 py-2 text-right">{t("Εκκρεμείς", "Pending")}</th>
                  <th className="px-4 py-2 text-right">{t("Εμβολιασμένοι", "Vaccinated")}</th>
                  <th className="px-4 py-2 text-left">{t("Κάλυψη", "Coverage")}</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {wl.data!.by_age.map((a) => {
                    const tot = a.pending + a.vaccinated;
                    const pct = tot ? Math.round((a.vaccinated / tot) * 100) : 0;
                    return (
                      <tr key={a.age_group}>
                        <td className="px-4 py-2 font-semibold text-slate-700 dark:text-slate-200">{a.age_group}</td>
                        <td className="px-4 py-2">
                          {a.open
                            ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{t("Ανοιχτό", "Open")}</span>
                            : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{t("Κλειστό", "Locked")}</span>}
                        </td>
                        <td className="px-4 py-2 text-right font-semibold text-sky-700 dark:text-sky-400">{fmtNum(a.pending)}</td>
                        <td className="px-4 py-2 text-right text-slate-600 dark:text-slate-300">{fmtNum(a.vaccinated)}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs text-slate-500">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
