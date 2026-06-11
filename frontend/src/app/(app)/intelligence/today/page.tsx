"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Receipt, Wallet, Users, UserPlus, PhoneCall, Clock, Pill, Layers, Radio } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";

type Today = {
  day: string; is_live: boolean; current_hour: number; rx: number; value: number; patients: number; new_patients: number;
  avg_day_rx: number; vs_avg: number | null;
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

  const maxHour = Math.max(1, ...data.by_hour.map((h) => h.rx));
  // live → cap the axis at the current hour (can't execute in the future); past day → full 07–22
  const endHour = data.is_live ? Math.max(9, Math.min(22, data.current_hour)) : 22;
  const hours = Array.from({ length: endHour - 7 + 1 }, (_, i) => i + 7);
  const byHourMap = new Map(data.by_hour.map((h) => [h.hour, h.rx]));
  const maxCat = Math.max(1, ...data.categories.map((c) => c.count));
  const maxMed = Math.max(1, ...data.top_meds.map((m) => m.count));
  const dayLabel = new Date(data.day).toLocaleDateString(t("el-GR", "en-GB"), { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${data.is_live ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
            <Radio className="h-3.5 w-3.5" /> {data.is_live ? t("Ζωντανά σήμερα", "Live today") : t("Τελευταία μέρα με δεδομένα", "Latest day with data")}
          </span>
          <span className="font-medium text-slate-700 dark:text-slate-200">{dayLabel}</span>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard label={t("Συνταγές", "Prescriptions")} value={fmtNum(data.rx)} icon={Receipt} accent="indigo" trend={data.vs_avg ?? undefined} sub={t(`μ.ο. μέρας ${data.avg_day_rx}`, `day avg ${data.avg_day_rx}`)} />
        <KpiCard label={t("Τζίρος ημέρας", "Day revenue")} value={fmtEur(data.value)} icon={Wallet} accent="green" />
        <KpiCard label={t("Ασθενείς", "Patients")} value={fmtNum(data.patients)} icon={Users} accent="violet" />
        <KpiCard label={t("Νέοι σήμερα", "New today")} value={fmtNum(data.new_patients)} icon={UserPlus} accent="sky" />
        <KpiCard label={t("Δεν ήρθαν (εκκρεμείς)", "No-shows (pending)")} value={fmtNum(data.expected_absent)} icon={PhoneCall} accent="rose" sub={t(`${data.expected_week} αυτή την εβδομάδα`, `${data.expected_week} this week`)} onClick={() => router.push("/intelligence/recall")} />
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
              <div key={h} className="group flex flex-1 flex-col items-center justify-end" title={`${h}:00 — ${rx}`}>
                <span className="mb-1 text-[10px] font-semibold text-slate-400 group-hover:text-brand-600">{rx || ""}</span>
                <div className="w-full rounded-t bg-brand-400 transition-all group-hover:bg-brand-600" style={{ height: `${(rx / maxHour) * 100}%`, minHeight: rx ? "4px" : "0" }} />
                <span className="mt-1 text-[9px] text-slate-400">{h}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* categories */}
        <div className="rx-card p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Layers className="h-4 w-4 text-brand-600" /> {t("Κατηγορίες εκτελέσεων", "Execution categories")}</h3>
          <div className="space-y-2">
            {data.categories.map((c) => (
              <div key={c.category} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-sm text-slate-600 dark:text-slate-300">{t(CAT[c.category] ?? c.category, c.category)}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(c.count / maxCat) * 100}%` }} /></div>
                <b className="w-8 text-right text-sm text-slate-700 dark:text-slate-200">{c.count}</b>
              </div>
            ))}
            {!data.categories.length && <p className="text-sm text-slate-400">{t("Καμία εκτέλεση.", "No executions.")}</p>}
          </div>
        </div>

        {/* top meds */}
        <div className="rx-card p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Pill className="h-4 w-4 text-brand-600" /> {t("Κορυφαία φάρμακα ημέρας", "Top medicines today")}</h3>
          <div className="space-y-2">
            {data.top_meds.map((m) => (
              <div key={m.name} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-sm text-slate-600 dark:text-slate-300">{m.name}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-violet-500" style={{ width: `${(m.count / maxMed) * 100}%` }} /></div>
                <b className="w-8 text-right text-sm text-slate-700 dark:text-slate-200">{m.count}</b>
              </div>
            ))}
            {!data.top_meds.length && <p className="text-sm text-slate-400">{t("Καμία εκτέλεση.", "No executions.")}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
