"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Receipt, Wallet, Users, UserPlus, PhoneCall, Clock, Pill, Layers } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { Tooltip } from "@/components/ui/Tooltip";

type Today = {
  day: string; is_live: boolean; current_hour: number; last_activity?: string | null; last_sync?: string | null;
  rx: number; value: number; patients: number; new_patients: number;
  avg_day_rx: number; vs_avg: number | null;
  rx_yoy: number; value_yoy: number; vs_yoy_rx: number | null; vs_yoy_value: number | null;
  by_hour: { hour: number; rx: number; value: number }[];
  categories: { category: string; count: number }[];
  top_meds: { name: string; count: number }[];
  expected_absent: number; expected_week: number;
};

const CAT: Record<string, string> = { normal: "Κανονικό", narcotic: "Ναρκωτικό", vaccine: "Εμβόλιο", high_cost: "Υψηλού κόστους", allergen: "Αλλεργιογόνο" };

export default function TodayPage() {
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["pi-today"], queryFn: () => api<Today>("/patient-intelligence/today"),
    refetchInterval: 60000,
  });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Φόρτωση ημέρας…", "Loading day…")}</div>;
  if (!data) return null;

  const maxHour = Math.max(1,...data.by_hour.map((h) => h.rx));
  // live → cap the axis at the current hour (can't execute in the future); past day → full 07–22
  const endHour = data.is_live ? Math.max(9, Math.min(22, data.current_hour)) : 22;
  const hours = Array.from({ length: endHour - 7 + 1 }, (_, i) => i + 7);
  const byHourMap = new Map(data.by_hour.map((h) => [h.hour, h.rx]));
  const maxCat = Math.max(1,...data.categories.map((c) => c.count));
  const maxMed = Math.max(1,...data.top_meds.map((m) => m.count));
  const dayLabel = new Date(data.day).toLocaleDateString(t("el-GR", "en-GB"), { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
            {t("Ζωντανά σήμερα", "Live today")}
          </span>
          <span className="font-medium text-slate-700 dark:text-slate-200">{dayLabel}</span>
        </div>
        <span className="text-xs text-slate-400">
          {data.last_activity && <>{t("Τελ. εκτέλεση", "Last execution")} {new Date(data.last_activity).toLocaleTimeString(t("el-GR", "en-GB"), { hour: "2-digit", minute: "2-digit" })}</>}
          {data.last_sync && <> · {t("sync", "sync")} {new Date(data.last_sync).toLocaleTimeString(t("el-GR", "en-GB"), { hour: "2-digit", minute: "2-digit" })}</>}
        </span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard label={t("Συνταγές", "Prescriptions")} help={t("Πλήθος εκτελέσεων συνταγών στην περίοδο.", "Number of executions in the period.")} value={fmtNum(data.rx)} icon={Receipt} accent="indigo" trend={data.vs_yoy_rx ?? undefined} sub={t(`μ.ο. μέρας ${data.avg_day_rx}${data.vs_avg != null ? ` · ${data.vs_avg >= 0 ? "+" : ""}${Math.round(data.vs_avg)}% vs μ.ο.` : ""}`, `day avg ${data.avg_day_rx}${data.vs_avg != null ? ` · ${data.vs_avg >= 0 ? "+" : ""}${Math.round(data.vs_avg)}% vs avg` : ""}`)} />
        <KpiCard label={t("Τζίρος ημέρας", "Day revenue")} help={t("Συνολική λιανική αξία των εκτελέσεων της ημέρας.", "Day's total retail value.")} value={fmtEur(data.value)} icon={Wallet} accent="green" trend={data.vs_yoy_value ?? undefined} sub={t(`πέρσι ${fmtEur(data.value_yoy)}`, `last year ${fmtEur(data.value_yoy)}`)} />
        <KpiCard label={t("Ασθενείς", "Patients")} help={t("Μοναδικοί ασθενείς της περιόδου/ομάδας.", "Unique patients.")} value={fmtNum(data.patients)} icon={Users} accent="violet" />
        <KpiCard label={t("Νέοι σήμερα", "New today")} help={t("Ασθενείς με πρώτη εκτέλεση στην περίοδο.", "Patients with their first execution in the period.")} value={fmtNum(data.new_patients)} icon={UserPlus} accent="sky" />
        <KpiCard label={t("Δεν ήρθαν (εκκρεμείς)", "No-shows (pending)")} help={t("Ασθενείς που δεν ήρθαν για την επανάληψή τους.", "Patients who didn't return for refills.")} value={fmtNum(data.expected_absent)} icon={PhoneCall} accent="rose" sub={t(`${data.expected_week} αυτή την εβδομάδα`, `${data.expected_week} this week`)} onClick={() => router.push("/intelligence/recall")} />
      </div>

      {/* intraday curve */}
      <div className="rx-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Clock className="h-4 w-4 text-brand-600" /> {t("Ροή ημέρας ανά ώρα", "Hourly flow")}</h3>
          <span className="text-xs text-slate-400">{data.is_live ? t(`έως ${data.current_hour}:00 (τώρα)`, `to ${data.current_hour}:00 (now)`) : dayLabel}</span>
        </div>
        <div className="flex h-32 items-end gap-1">
          {hours.map((h) => {
            const rx = byHourMap.get(h) ?? 0;
            return (
              <Tooltip key={h} label={`${h}:00 — ${rx}`}><div className="group flex flex-1 flex-col items-center justify-end">
                <span className="mb-1 text-[10px] font-semibold text-slate-400 group-hover:text-brand-600">{rx || ""}</span>
                <div className="w-full rounded-t bg-brand-400 transition-all group-hover:bg-brand-600" style={{ height: `${(rx / maxHour) * 100}%`, minHeight: rx ? "4px" : "0" }} />
                <span className="mt-1 text-[9px] text-slate-400">{h}</span>
              </div></Tooltip>
            );
          })}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* categories */}
        <div className="rx-card p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Layers className="h-4 w-4 text-brand-600" /> {t("Κατηγορίες εκτελέσεων", "Execution categories")}</h3>
          <div className="space-y-2.5">
            {data.categories.map((c) => (
              <div key={c.category}>
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-600 dark:text-slate-300">{t(CAT[c.category] ?? c.category, c.category)}</span>
                  <b className="text-sm text-slate-700 dark:text-slate-200">{c.count}</b>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(c.count / maxCat) * 100}%` }} /></div>
              </div>
            ))}
            {!data.categories.length && <p className="text-sm text-slate-400">{t("Καμία εκτέλεση.", "No executions.")}</p>}
          </div>
        </div>

        {/* top meds */}
        <div className="rx-card p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Pill className="h-4 w-4 text-brand-600" /> {t("Κορυφαία φάρμακα ημέρας", "Top medicines today")}</h3>
          <div className="space-y-2.5">
            {data.top_meds.map((m) => (
              <div key={m.name}>
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-600 dark:text-slate-300">{m.name}</span>
                  <b className="text-sm text-slate-700 dark:text-slate-200">{m.count}</b>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-violet-500" style={{ width: `${(m.count / maxMed) * 100}%` }} /></div>
              </div>
            ))}
            {!data.top_meds.length && <p className="text-sm text-slate-400">{t("Καμία εκτέλεση.", "No executions.")}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
