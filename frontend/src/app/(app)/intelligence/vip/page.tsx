"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Crown } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Tier = { tier: string; label: string; count: number; revenue: number };
type Row = { patient_id: string; name?: string | null; amka?: string | null; value: number; rx_count: number; last_seen?: string | null; tier: string };

const TIER_BG: Record<string, string> = { platinum: "from-slate-300 to-slate-500", gold: "from-amber-300 to-amber-500", silver: "from-slate-200 to-slate-400", bronze: "from-orange-300 to-orange-500" };
const TIER_BADGE: Record<string, string> = { platinum: "bg-slate-200 text-slate-700", gold: "bg-amber-100 text-amber-700", silver: "bg-slate-100 text-slate-600", bronze: "bg-orange-100 text-orange-700" };

export default function VipPage() {
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["pi-vip"], queryFn: () => api<{ tiers: Tier[]; items: Row[] }>("/patient-intelligence/vip") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Κατάταξη VIP…", "Ranking VIP…")}</div>;

  const cols: Column<Row>[] = [
    { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.amka || "—" },
    { key: "tier", header: t("Κατηγορία", "Tier"), render: (r) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${TIER_BADGE[r.tier]}`}>{r.tier}</span> },
    { key: "value", header: t("Αξία ζωής", "Lifetime value"), align: "right", sortValue: (r) => r.value, render: (r) => <b>{fmtEur(r.value)}</b> },
    { key: "rx_count", header: t("Συνταγές", "Rx"), align: "right", sortValue: (r) => r.rx_count, render: (r) => fmtNum(r.rx_count) },
    { key: "last_seen", header: t("Τελ. επίσκεψη", "Last visit"), hideOnMobile: true, render: (r) => r.last_seen ? fmtDate(r.last_seen) : "—" },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(data?.tiers ?? []).map((tr) => (
          <div key={tr.tier} className={`rounded-2xl bg-gradient-to-br ${TIER_BG[tr.tier]} p-4 text-white shadow`}>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase opacity-90"><Crown className="h-3.5 w-3.5" /> {tr.label}</div>
            <div className="mt-1 text-2xl font-bold">{fmtNum(tr.count)}</div>
            <div className="text-xs opacity-90">{fmtEur(tr.revenue)}</div>
          </div>
        ))}
      </div>
      <DataTable pageSize={20} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.patient_id}
        onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)} empty={t("Καμία εγγραφή.", "No data.")} />
    </div>
  );
}
