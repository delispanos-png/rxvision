"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Row = {
  patient_id: string; name?: string | null; amka?: string | null; compliance: number | null;
  missed: number; gap_days: number; value: number; reasons: string[]; recoverable: number;
};

const REASON: Record<string, { el: string; en: string }> = {
  low_compliance: { el: "Χαμηλό compliance", en: "Low compliance" },
  missed_renewals: { el: "Χαμένες ανανεώσεις", en: "Missed renewals" },
  long_gap: { el: "Μεγάλο διάστημα", en: "Long gap" },
};

export default function RiskPage() {
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["pi-risk"], queryFn: () => api<{ items: Row[]; count: number }>("/patient-intelligence/risk") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Ανίχνευση κινδύνου…", "Detecting risk…")}</div>;

  const cols: Column<Row>[] = [
    { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.amka || "—" },
    { key: "reasons", header: t("Λόγοι", "Reasons"), render: (r) => (
      <span className="flex flex-wrap gap-1">{r.reasons.map((x) => <span key={x} className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">{t(REASON[x]?.el ?? x, REASON[x]?.en ?? x)}</span>)}</span>
    ) },
    { key: "compliance", header: "Compliance", align: "right", sortValue: (r) => r.compliance ?? 100, render: (r) => r.compliance ?? "—" },
    { key: "missed", header: t("Χαμένες", "Missed"), align: "right", sortValue: (r) => r.missed, render: (r) => fmtNum(r.missed) },
    { key: "gap_days", header: t("Ημ. χωρίς", "Days idle"), align: "right", hideOnMobile: true, sortValue: (r) => r.gap_days, render: (r) => r.gap_days },
    { key: "recoverable", header: t("Αξία ρίσκου", "Value at risk"), align: "right", sortValue: (r) => r.recoverable, render: (r) => <b className="text-rose-600">{fmtEur(r.recoverable)}</b> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200">
        <AlertTriangle className="h-5 w-5 shrink-0" />
        <span><b>{fmtNum(data?.count ?? 0)}</b> {t("ασθενείς υψηλού κινδύνου — πιθανή διακοπή θεραπείας. Προτεραιότητα σε ενέργειες recall.", "high-risk patients — possible therapy discontinuation. Prioritize recall actions.")}</span>
      </div>
      <DataTable pageSize={20} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.patient_id}
        onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)} empty={t("Κανένας ασθενής σε κίνδυνο. 👍", "No patients at risk. 👍")} />
    </div>
  );
}
