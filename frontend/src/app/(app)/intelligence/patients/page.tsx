"use client";

import { useEffect, useState } from "react";
import { useRouter as useNavRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur, fmtDate, fmtMoney} from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";

type Row = {
  patient_id: string; name?: string | null; amka?: string | null; age_group?: string | null; sex?: string | null;
  area?: string | null; rx_count: number; value: number; avg_value: number; last_seen?: string | null;
  frequency: number; ltv: number; gap_days?: number | null;
};

export default function PatientAnalyticsPage() {
  const t = useT();
  const router = useRouter();
  const [sort, setSort] = useState("value");
  // ?active=60 από την κάρτα «Ενεργοί (60ημ)» → η λίστα δείχνει ΑΚΡΙΒΩΣ αυτούς που μετρά η κάρτα
  // (window.location και όχι useSearchParams: αυτό θα απαιτούσε όριο Suspense στο build.)
  const nav = useNavRouter();
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setActive(Number(new URLSearchParams(window.location.search).get("active")) || null);
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const { data, isLoading } = useQuery({ queryKey: ["pi-patients", sort, active], queryFn: () => api<{ items: Row[]; total: number; shown?: number }>(`/patient-intelligence/patients?sort=${sort}${active ? `&active_days=${active}` : ""}`) });

  const cols: Column<Row>[] = [
    { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.amka || "—" },
    { key: "age", header: t("Ηλικία/Φύλο", "Age/Sex"), hideOnMobile: true, render: (r) => [r.age_group, r.sex].filter(Boolean).join(" · ") || "—" },
    { key: "rx_count", header: t("Συνταγές", "Rx"), align: "right", sortValue: (r) => r.rx_count, render: (r) => fmtNum(r.rx_count) },
    { key: "value", header: "LTV", align: "right", sortValue: (r) => r.value, render: (r) => <b>{fmtEur(r.value)}</b> },
    { key: "avg_value", header: t("Μ.Ο.", "Avg"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.avg_value) },
    { key: "frequency", header: t("Συχν./μήνα", "Freq/mo"), align: "right", hideOnMobile: true, sortValue: (r) => r.frequency, render: (r) => r.frequency },
    { key: "last_seen", header: t("Τελ. επίσκεψη", "Last visit"), render: (r) => r.last_seen ? fmtDate(r.last_seen) : "—" },
    { key: "gap", header: t("Ημ. χωρίς", "Days idle"), align: "right", hideOnMobile: true, sortValue: (r) => r.gap_days ?? 0, render: (r) => r.gap_days ?? "—" },
  ];

  if (isLoading) return <div className="p-8 text-slate-400">{t("Φόρτωση ασθενών…", "Loading patients…")}</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
          {fmtNum(data?.total ?? 0)} {active ? t(`ασθενείς ενεργοί τις τελευταίες ${active} ημέρες`, `patients active in the last ${active} days`) : t("ασθενείς · ανάλυση αξίας ζωής & συχνότητας", "patients · lifetime value & frequency analysis")}
          {data?.shown !== undefined && data.shown < (data.total ?? 0) && <span className="text-xs text-slate-400">{t(`(εμφανίζονται οι ${fmtNum(data.shown)} κορυφαίοι)`, `(top ${fmtNum(data.shown)} shown)`)}</span>}
          {active && <button onClick={() => { nav.push("/intelligence/patients"); setActive(null); }} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-100 dark:bg-brand-900/30 dark:text-brand-300">{t("όλοι οι ασθενείς ×", "all patients ×")}</button>}
        </p>
        <div className="flex items-center gap-2">
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
            <option value="value">{t("Ταξ.: Αξία ζωής", "Sort: LTV")}</option>
            <option value="rx">{t("Ταξ.: Συνταγές", "Sort: Rx count")}</option>
            <option value="frequency">{t("Ταξ.: Συχνότητα", "Sort: Frequency")}</option>
            <option value="recent">{t("Ταξ.: Πιο πρόσφατοι", "Sort: Most recent")}</option>
          </select>
          <ExportMenu filename="patient-analytics" title="Patient Analytics" rows={data?.items ?? []} columns={[
            { key: "name", header: t("Ασθενής", "Patient"), value: (r) => r.name || r.amka || "" },
            { key: "rx_count", header: "Rx" },
            { key: "value", header: "LTV (€)", value: (r) => fmtMoney(r.value) },
            { key: "frequency", header: "Freq/mo" },
          ]} />
        </div>
      </div>
      <DataTable pageSize={25} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.patient_id}
        onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)} empty={t("Καμία εγγραφή.", "No data.")} />
    </div>
  );
}
