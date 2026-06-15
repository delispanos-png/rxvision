"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Tooltip } from "@/components/ui/Tooltip";

type Dist = { band: string; label: string; count: number };
type Row = { patient_id: string; name?: string | null; amka?: string | null; compliance: number; band: string; band_label: string; executed: number; expected: number; missed: number; value: number };

const BAND: Record<string, string> = { excellent: "bg-emerald-500", good: "bg-lime-500", medium: "bg-amber-500", risk: "bg-orange-500", critical: "bg-rose-500" };
const BAND_TXT: Record<string, string> = { excellent: "text-emerald-700 bg-emerald-100", good: "text-lime-700 bg-lime-100", medium: "text-amber-700 bg-amber-100", risk: "text-orange-700 bg-orange-100", critical: "text-rose-700 bg-rose-100" };

export default function CompliancePage() {
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["pi-compliance"], queryFn: () => api<{ distribution: Dist[]; items: Row[] }>("/patient-intelligence/compliance") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Υπολογισμός compliance…", "Computing compliance…")}</div>;
  const total = (data?.distribution ?? []).reduce((s, b) => s + b.count, 0) || 1;

  const cols: Column<Row>[] = [
    { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.amka || "—" },
    { key: "compliance", header: "Score", align: "right", sortValue: (r) => r.compliance, render: (r) => (
      <span className="inline-flex items-center gap-2">
        <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 sm:inline-block"><span className={`block h-full ${BAND[r.band]}`} style={{ width: `${r.compliance}%` }} /></span>
        <b>{r.compliance}</b>
      </span>
    ) },
    { key: "band", header: t("Κατηγορία", "Band"), render: (r) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${BAND_TXT[r.band]}`}>{r.band_label}</span> },
    { key: "ratio", header: t("Εκτελ./Αναμ.", "Done/Exp."), align: "right", hideOnMobile: true, render: (r) => `${r.executed}/${r.expected}` },
    { key: "missed", header: t("Χαμένες", "Missed"), align: "right", sortValue: (r) => r.missed, render: (r) => fmtNum(r.missed) },
    { key: "value", header: t("Αξία", "Value"), align: "right", sortValue: (r) => r.value, render: (r) => fmtEur(r.value) },
  ];

  return (
    <div className="space-y-5">
      <div className="rx-card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Κατανομή συμμόρφωσης", "Compliance distribution")}</h3>
        <div className="mb-2 flex h-5 overflow-hidden rounded-full">
          {(data?.distribution ?? []).map((b) => b.count > 0 && <Tooltip key={b.band} label={`${b.label}: ${b.count}`}><div className={BAND[b.band]} style={{ width: `${(b.count / total) * 100}%` }} /></Tooltip>)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {(data?.distribution ?? []).map((b) => <span key={b.band} className="inline-flex items-center gap-1.5 text-slate-500"><span className={`h-2.5 w-2.5 rounded-full ${BAND[b.band]}`} /> {b.label}: <b className="text-slate-700 dark:text-slate-200">{b.count}</b></span>)}
        </div>
      </div>
      <DataTable pageSize={20} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.patient_id}
        onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)} empty={t("Καμία εγγραφή.", "No data.")} />
    </div>
  );
}
