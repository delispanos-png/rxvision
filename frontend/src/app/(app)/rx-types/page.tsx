"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { QueryState } from "@/components/ui/QueryState";

type Stat = { count: number; value: number };
type Breakdown = { total: number; value: number; items: Record<string, Stat> };
type T = (el: string, en: string) => string;

// [key στο breakdown, ετικέτα, token για φίλτρο της λίστας συνταγών]
const GROUPS = (t: T): { title: string; rows: [string, string, string][] }[] => [
  { title: t("Χαρακτηριστικά", "Characteristics"), rows: [
    ["chronic", t("Χρόνια αγωγή", "Chronic"), "chronic"],
    ["high_cost", t("Υψηλού κόστους", "High cost"), "high_cost"],
    ["narcotic", t("Ναρκωτικό", "Narcotic"), "narcotic"],
    ["antibiotic", t("Αντιβιοτικό", "Antibiotic"), "antibiotic"],
    ["special_antibiotic", t("Ειδικό αντιβιοτικό", "Special antibiotic"), "special_antibiotic"],
    ["n3816", t("Νόμος 3816 (ΦΥΚ)", "Law 3816"), "n3816"],
    ["ifet", "ΙΦΕΤ", "ifet"],
    ["heparin", t("Ηπαρίνη", "Heparin"), "heparin"],
    ["vaccines", t("Εμβόλιο", "Vaccine"), "vaccines"],
    ["desensitization", t("Εμβόλιο απευαισθ.", "Desensitization"), "desensitization"],
    ["single_dose", t("Μονοδοσιακό", "Single-dose"), "single_dose"],
    ["by_brand", t("Εμπορική ονομασία", "By brand"), "by_brand"],
    ["ekas", "ΕΚΑΣ", "ekas"],
    ["eopyy_only", t("Μόνο φαρμακεία ΕΟΠΥΥ", "EOPYY pharmacies only"), "eopyy_only"],
    ["hospital_only", t("Μόνο νοσοκομεία", "Hospitals only"), "hospital_only"],
    ["eopyy_preapproval", t("Απαιτεί προέγκριση", "Pre-approval"), "eopyy_preapproval"],
    ["outside_eopyy", t("Εκτός φαρμ. κόστους", "Outside EOPYY cost"), "outside_eopyy"],
    ["negative_list", t("Αρνητική λίστα", "Negative list"), "negative_list"],
    ["home_delivery", t("Κατ' οίκον", "Home delivery"), "home_delivery"],
    ["intangible", t("Άυλη", "Intangible"), "intangible"],
  ] },
  { title: t("Διάρκεια", "Duration"), rows: [
    ["monthly", t("Μηνιαία", "Monthly"), "monthly"],
    ["bimonthly", t("Δίμηνη", "Bimonthly"), "bimonthly"],
  ] },
  { title: t("Επαναληψιμότητα", "Repeatability"), rows: [
    ["simple", t("Απλή", "Simple"), "simple"],
    ["repeat", t("Επαναλαμβανόμενη", "Repeating"), "repeat"],
    ["r3", t("Τρίμηνη", "3-month"), "3"],
    ["r4", t("Τετράμηνη", "4-month"), "4"],
    ["r5", t("Πεντάμηνη", "5-month"), "5"],
    ["r6", t("Εξάμηνη", "6-month"), "6"],
  ] },
];

export default function RxTypesPage() {
  const t = useT();
  const router = useRouter();
  const filters = useUiStore();
  const qs = filtersToQuery(filters);
  const q = useQuery({ queryKey: ["rx-characteristics", qs], queryFn: () => api<Breakdown>(`/prescriptions/characteristics?${qs}`) });
  const d = q.data;
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
              <div className="text-xs text-slate-400">{t("Σύνολο εκτελέσεων περιόδου", "Total executions in period")}</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{fmtNum(d.total)} <span className="text-base font-medium text-slate-400">· {fmtEur(d.value)}</span></div>
            </div>
            {GROUPS(t).map((g) => (
              <div key={g.title}>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">{g.title}</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {g.rows.map(([key, label, token]) => {
                    const s = d.items[key] || { count: 0, value: 0 };
                    const pct = d.total ? Math.round((s.count / d.total) * 100) : 0;
                    return (
                      <button key={key} onClick={() => router.push(`/prescriptions?char=${token}`)}
                        className="rounded-xl border border-slate-200 p-3 text-left transition hover:border-brand-300 hover:bg-brand-50/40 dark:border-slate-700 dark:hover:bg-brand-950/30">
                        <div className="truncate text-xs text-slate-500" title={label}>{label}</div>
                        <div className="mt-1 flex items-baseline gap-2">
                          <span className="text-xl font-bold text-slate-900 dark:text-slate-100">{fmtNum(s.count)}</span>
                          {s.count > 0 ? <span className="text-[11px] text-slate-400">{pct}%</span> : null}
                        </div>
                        {s.value > 0 ? <div className="text-xs text-slate-400">{fmtEur(s.value)}</div> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </ModuleGuard>
  );
}
