"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { UserCheck, Wallet, Phone, MessageSquare } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";

type Row = {
  patient_id: string; name?: string | null; amka?: string | null; returned_at: string;
  gap_days: number; value: number; reactivation_reason?: string | null; mobile?: string | null; phone?: string | null;
};

const REASONS: { v: string; el: string; en: string }[] = [
  { v: "", el: "— λόγος —", en: "— reason —" },
  { v: "new_rx", el: "Νέα συνταγή γιατρού", en: "New doctor Rx" },
  { v: "promo", el: "Προσφορά / διαφήμιση", en: "Promo / ad" },
  { v: "referral", el: "Σύσταση", en: "Referral" },
  { v: "switched_back", el: "Γύρισε από άλλο φαρμακείο", en: "Switched back" },
  { v: "routine", el: "Επανέλαβε θεραπεία", en: "Resumed therapy" },
  { v: "other", el: "Άλλο", en: "Other" },
];

function ReasonSelect({ row, t }: { row: Row; t: (a: string, b: string) => string }) {
  const [val, setVal] = useState(row.reactivation_reason || "");
  const save = useMutation({
    mutationFn: (reason: string) => api(`/patients/${encodeURIComponent(row.patient_id)}/contact`, { method: "PUT", body: JSON.stringify({ reactivation_reason: reason || null }) }),
  });
  return (
    <select value={val} onClick={(e) => e.stopPropagation()} onChange={(e) => { setVal(e.target.value); save.mutate(e.target.value); }}
      className={`rounded-lg border px-2 py-1 text-xs ${val ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40" : "border-slate-300 text-slate-500"} dark:border-slate-600 dark:bg-slate-800`}>
      {REASONS.map((r) => <option key={r.v} value={r.v}>{t(r.el, r.en)}</option>)}
    </select>
  );
}

export default function ReturnsPage() {
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["pi-returns"], queryFn: () => api<{ items: Row[]; count: number; recovered_value: number }>("/patient-intelligence/returns") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Εντοπισμός επιστροφών…", "Detecting returns…")}</div>;

  const cols: Column<Row>[] = [
    { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.amka || "—" },
    { key: "returned_at", header: t("Επέστρεψε", "Returned"), sortValue: (r) => r.returned_at, render: (r) => fmtDate(r.returned_at) },
    { key: "gap_days", header: t("Αδράνεια", "Dormancy"), align: "right", sortValue: (r) => r.gap_days, render: (r) => `${fmtNum(r.gap_days)} ${t("μέρες", "days")}` },
    { key: "value", header: t("Αξία ζωής", "LTV"), align: "right", sortValue: (r) => r.value, render: (r) => <b>{fmtEur(r.value)}</b> },
    { key: "reason", header: t("Λόγος επιστροφής", "Return reason"), render: (r) => <ReasonSelect row={r} t={t} /> },
    { key: "contact", header: t("Επικ.", "Contact"), render: (r) => {
      const tel = r.mobile || r.phone;
      if (!tel) return <span className="text-xs text-slate-300">—</span>;
      return <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
        <a href={`tel:${tel}`} className="rounded-lg border border-slate-200 p-1.5 text-emerald-600 hover:bg-emerald-50 dark:border-slate-700"><Phone className="h-3.5 w-3.5" /></a>
        {r.mobile && <a href={`sms:${r.mobile}`} className="rounded-lg border border-slate-200 p-1.5 text-brand-600 hover:bg-brand-50 dark:border-slate-700"><MessageSquare className="h-3.5 w-3.5" /></a>}
      </span>;
    } },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard label={t("Επιστροφές", "Returns")} value={fmtNum(data?.count ?? 0)} icon={UserCheck} accent="green" sub={t("γύρισαν μετά 90+ μέρες αδράνειας", "returned after 90+ idle days")} />
        <KpiCard label={t("Ανακτημένη αξία", "Recovered value")} value={fmtEur(data?.recovered_value ?? 0)} icon={Wallet} accent="amber" sub={t("αξία ζωής επιστρεφόντων", "LTV of returners")} />
      </div>
      <p className="text-sm text-slate-500">{t("Ασθενείς που ήταν ανενεργοί 3+ μήνες και ξαναεμφανίστηκαν. Κατέγραψε τον λόγο επιστροφής για να μάθεις τι λειτουργεί.", "Patients dormant 3+ months who came back. Record the return reason to learn what works.")}</p>
      <DataTable pageSize={20} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.patient_id}
        onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)} empty={t("Καμία επιστροφή στο διάστημα.", "No returns in the window.")} />
    </div>
  );
}
