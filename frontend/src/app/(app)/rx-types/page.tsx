"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  Activity, Banknote, Pill, ShieldAlert, FileText, Plane, Droplet, Syringe, Tag,
  BadgeEuro, Building2, Stamp, CircleSlash, Ban, Truck, Smartphone, Calendar,
  CalendarRange, FileCheck, Repeat, FlaskConical,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur, fmtDec } from "@/lib/formatters";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { QueryState } from "@/components/ui/QueryState";
import { KpiCard } from "@/components/kpi/KpiCard";

type Stat = { count: number; value: number };
type Breakdown = { total: number; value: number; items: Record<string, Stat> };
type T = (el: string, en: string) => string;
type Accent = "indigo" | "green" | "amber" | "orange" | "sky" | "rose" | "violet";
type Row = [key: string, label: string, token: string, icon: LucideIcon, accent: Accent];

// [key στο breakdown, ετικέτα, token για φίλτρο της λίστας συνταγών, icon, χρώμα]
const GROUPS = (t: T): { title: string; rows: Row[] }[] => [
  { title: t("Χαρακτηριστικά", "Characteristics"), rows: [
    ["chronic", t("Χρόνια αγωγή", "Chronic"), "chronic", Activity, "amber"],
    ["high_cost", t("Υψηλού κόστους", "High cost"), "high_cost", Banknote, "rose"],
    ["narcotic", t("Ναρκωτικό", "Narcotic"), "narcotic", ShieldAlert, "rose"],
    ["antibiotic", t("Αντιβιοτικό", "Antibiotic"), "antibiotic", Pill, "orange"],
    ["special_antibiotic", t("Ειδικό αντιβιοτικό", "Special antibiotic"), "special_antibiotic", ShieldAlert, "orange"],
    ["n3816", t("Νόμος 3816 (ΦΥΚ)", "Law 3816"), "n3816", FileText, "violet"],
    ["ifet", "ΙΦΕΤ", "ifet", Plane, "violet"],
    ["heparin", t("Ηπαρίνη", "Heparin"), "heparin", Droplet, "rose"],
    ["vaccines", t("Εμβόλιο", "Vaccine"), "vaccines", Syringe, "sky"],
    ["desensitization", t("Εμβόλιο απευαισθ.", "Desensitization"), "desensitization", Syringe, "sky"],
    ["single_dose", t("Μονοδοσιακό", "Single-dose"), "single_dose", Pill, "indigo"],
    ["by_brand", t("Εμπορική ονομασία", "By brand"), "by_brand", Tag, "indigo"],
    ["ekas", "ΕΚΑΣ", "ekas", BadgeEuro, "green"],
    ["eopyy_only", t("Μόνο φαρμακεία ΕΟΠΥΥ", "EOPYY pharmacies only"), "eopyy_only", Building2, "indigo"],
    ["hospital_only", t("Μόνο νοσοκομεία", "Hospitals only"), "hospital_only", Building2, "indigo"],
    ["eopyy_preapproval", t("Απαιτεί προέγκριση", "Pre-approval"), "eopyy_preapproval", Stamp, "amber"],
    ["outside_eopyy", t("Εκτός φαρμ. κόστους", "Outside EOPYY cost"), "outside_eopyy", CircleSlash, "rose"],
    ["negative_list", t("Αρνητική λίστα", "Negative list"), "negative_list", Ban, "rose"],
    ["home_delivery", t("Κατ' οίκον", "Home delivery"), "home_delivery", Truck, "green"],
    ["intangible", t("Άυλη", "Intangible"), "intangible", Smartphone, "sky"],
    ["galenic", t("Γαληνικά", "Galenic"), "galenic", FlaskConical, "violet"],
  ] },
  { title: t("Διάρκεια", "Duration"), rows: [
    ["monthly", t("Μηνιαία", "Monthly"), "monthly", Calendar, "indigo"],
    ["bimonthly", t("Δίμηνη", "Bimonthly"), "bimonthly", CalendarRange, "indigo"],
  ] },
  { title: t("Επαναληψιμότητα", "Repeatability"), rows: [
    ["simple", t("Απλή", "Simple"), "simple", FileCheck, "indigo"],
    ["repeat", t("Επαναλαμβανόμενη", "Repeating"), "repeat", Repeat, "violet"],
    ["r3", t("Τρίμηνη", "3-month"), "3", Repeat, "violet"],
    ["r4", t("Τετράμηνη", "4-month"), "4", Repeat, "violet"],
    ["r5", t("Πεντάμηνη", "5-month"), "5", Repeat, "violet"],
    ["r6", t("Εξάμηνη", "6-month"), "6", Repeat, "violet"],
  ] },
];

// Δ% vs την ίδια περσινή περίοδο (▲ πράσινο / ▼ κόκκινο)
function Trend({ cur, prev }: { cur: number; prev?: number }) {
  const d = pctDelta(cur, prev);
  if (d === undefined) return null;
  return (
    <span className={`text-[11px] font-semibold ${d >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
      {d >= 0 ? "▲" : "▼"} {fmtDec(Math.abs(d), 1)}%
    </span>
  );
}

export default function RxTypesPage() {
  const t = useT();
  const router = useRouter();
  const filters = useUiStore();
  const qs = filtersToQuery(filters);
  const q = useQuery({ queryKey: ["rx-characteristics", qs], queryFn: () => api<Breakdown>(`/prescriptions/characteristics?${qs}`) });
  const d = q.data;
  // ίδια περίοδος πέρσι (52 εβδομάδες πίσω) για Δ%
  const pr = prevYearRange(filters.dateFrom, filters.dateTo);
  const prevQs = pr ? filtersToQuery({...filters, dateFrom: pr.from, dateTo: pr.to }) : "";
  const qp = useQuery({ queryKey: ["rx-characteristics", "prev", prevQs], queryFn: () => api<Breakdown>(`/prescriptions/characteristics?${prevQs}`), enabled: !!pr });
  const prev = qp.data;
  return (
    <ModuleGuard module="prescription_analytics">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Εκτελέσεις ανά είδος συνταγής", "Executions by prescription type")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("Πλήθος & αξία εκτελέσεων ανά χαρακτηριστικό — κλικ για τη φιλτραρισμένη λίστα", "Count & value of executions per characteristic — click for the filtered list")}</p>
      </div>
      <div className="mb-4"><DateRangeFilter /></div>
      <QueryState isLoading={q.isLoading} isError={q.isError} isEmpty={!!d && !d.total} onRetry={() => q.refetch()}>
        {d && (
          <div className="space-y-6">
            <div className="rx-card p-4">
              <div className="text-xs text-slate-400">{t("Σύνολο εκτελέσεων περιόδου", "Total executions in period")}{pr ? t(" · Δ vs ίδια περσινή περίοδο", " · Δ vs same period last year") : ""}</div>
              <div className="mt-1 flex items-baseline gap-2 text-2xl font-bold text-slate-900 dark:text-slate-100">
                {fmtNum(d.total)} <span className="text-base font-medium text-slate-400">· {fmtEur(d.value)}</span>
                <Trend cur={d.total} prev={prev?.total} />
              </div>
            </div>
            {GROUPS(t).map((g) => {
              // μόνο κάρτες με αποτέλεσμα (>0)· κρύψε ομάδα αν είναι όλες μηδέν
              const visible = g.rows.filter(([key]) => (d.items[key]?.count || 0) > 0);
              if (!visible.length) return null;
              return (
                <div key={g.title}>
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">{g.title}</h2>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {visible.map(([key, label, token, icon, accent]) => {
                      const s = d.items[key] || { count: 0, value: 0 };
                      const pct = d.total ? Math.round((s.count / d.total) * 100) : 0;
                      const sub = [s.value > 0 ? fmtEur(s.value) : "", s.count > 0 ? `${pct}% ${t("του συνόλου", "of total")}` : ""].filter(Boolean).join(" · ");
                      return (
                        <KpiCard key={key} label={label} value={fmtNum(s.count)} sub={sub || undefined}
                          icon={icon} accent={accent} trend={pctDelta(s.count, prev?.items?.[key]?.count)}
                          onClick={() => router.push(`/prescriptions?char=${token}`)} />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </QueryState>
    </ModuleGuard>
  );
}
