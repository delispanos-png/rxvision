"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { compliancePriority, PRIORITY_CLS, PRIORITY_SOLID } from "@/lib/priority";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Tooltip } from "@/components/ui/Tooltip";

type Dist = { band: string; label: string; count: number };
type Row = { patient_id: string; name?: string | null; amka?: string | null; compliance: number; band: string; band_label: string; executed: number; expected: number; missed: number; value: number;
  last_missed?: string | null; regular?: boolean };

// Τα χρώματα ζουν πλέον στο κοινό lib/priority.ts — ίδια σημασία σε Ρίσκο/Recall/Εμβολιασμούς.
const BAND = (b: string) => PRIORITY_SOLID[compliancePriority(b)];
const BAND_TXT = (b: string) => PRIORITY_CLS[compliancePriority(b)];

export default function CompliancePage() {
  const t = useT();
  const router = useRouter();
  // Φίλτρα κατά πρόταση φαρμακοποιού: μόνο ΤΑΚΤΙΚΟΙ πελάτες, και μόνο όσοι έχασαν επανάληψη
  // πριν από αρκετό καιρό (τότε είναι οριστικά χαμένη — όχι «θα έρθει αύριο»).
  const [regularOnly, setRegularOnly] = useState(true);
  const [lostDays, setLostDays] = useState(60);
  const { data, isLoading } = useQuery({
    queryKey: ["pi-compliance", regularOnly, lostDays],
    queryFn: () => api<{ distribution: Dist[]; items: Row[]; total: number }>(`/patient-intelligence/compliance?regular_only=${regularOnly}&lost_days=${lostDays}`),
    placeholderData: keepPreviousData,   // αλλαγή φίλτρου: κράτα τον πίνακα, μην «αδειάζει» η σελίδα
  });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Υπολογισμός compliance…", "Computing compliance…")}</div>;
  const total = (data?.distribution ?? []).reduce((s, b) => s + b.count, 0) || 1;

  const cols: Column<Row>[] = [
    { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.amka || "—" },
    { key: "compliance", header: "Score", align: "right", sortValue: (r) => r.compliance, render: (r) => (
      <span className="inline-flex items-center gap-2">
        <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 sm:inline-block"><span className={`block h-full ${BAND(r.band)}`} style={{ width: `${r.compliance}%` }} /></span>
        <b>{r.compliance}</b>
      </span>
    ) },
    { key: "band", header: t("Κατηγορία", "Band"), render: (r) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${BAND_TXT(r.band)}`}>{r.band_label}</span> },
    { key: "ratio", header: t("Εκτελ./Αναμ.", "Done/Exp."), align: "right", hideOnMobile: true, render: (r) => `${r.executed}/${r.expected}` },
    { key: "missed", header: t("Χαμένες", "Missed"), align: "right", sortValue: (r) => r.missed, render: (r) => fmtNum(r.missed) },
    { key: "last_missed", header: t("Τελευταία χαμένη", "Last missed"), align: "right", hideOnMobile: true, sortValue: (r) => r.last_missed ?? "", render: (r) => r.last_missed ? fmtDate(r.last_missed) : "—" },
    { key: "value", header: t("Αξία", "Value"), align: "right", sortValue: (r) => r.value, render: (r) => fmtEur(r.value) },
  ];

  return (
    <div className="space-y-5">
      <div className="rx-card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Κατανομή συμμόρφωσης", "Compliance distribution")}</h3>
        <div className="mb-2 flex h-5 overflow-hidden rounded-full">
          {(data?.distribution ?? []).map((b) => b.count > 0 && <Tooltip key={b.band} label={`${b.label}: ${b.count}`}><div className={BAND(b.band)} style={{ width: `${(b.count / total) * 100}%` }} /></Tooltip>)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {(data?.distribution ?? []).map((b) => <span key={b.band} className="inline-flex items-center gap-1.5 text-slate-500"><span className={`h-2.5 w-2.5 rounded-full ${BAND(b.band)}`} /> {b.label}: <b className="text-slate-700 dark:text-slate-200">{b.count}</b></span>)}
        </div>
      </div>
      <div className="rx-card flex flex-wrap items-center gap-x-5 gap-y-2 p-4 text-sm">
        <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={regularOnly} onChange={(e) => setRegularOnly(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          {t("Μόνο τακτικοί πελάτες", "Regular customers only")}
          <Tooltip label={t("Πελάτες με εκτελέσεις σε τουλάχιστον 6 διαφορετικούς μήνες του τελευταίου έτους.", "Customers with dispensings in at least 6 different months of the last year.")}><span className="cursor-help text-slate-400">ⓘ</span></Tooltip>
        </label>
        <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
          {t("Χαμένη επανάληψη", "Missed repeat")}
          <select value={lostDays} onChange={(e) => setLostDays(Number(e.target.value))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800">
            <option value={0}>{t("οποτεδήποτε", "any time")}</option>
            <option value={60}>{t("πάνω από 2 μήνες", "over 2 months ago")}</option>
            <option value={90}>{t("πάνω από 3 μήνες", "over 3 months ago")}</option>
          </select>
        </label>
        <span className="text-xs text-slate-500">{t(`${fmtNum(data?.total ?? 0)} πελάτες`, `${fmtNum(data?.total ?? 0)} customers`)}</span>
      </div>
      <DataTable pageSize={20} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.patient_id}
        onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)} empty={t("Καμία εγγραφή.", "No data.")} />
    </div>
  );
}
