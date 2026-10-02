"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { RotateCcw, Wallet, Users } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { winbackPriority } from "@/lib/priority";

type Row = { patient_id: string; name?: string | null; amka?: string | null; last_seen?: string | null; days: number; value: number; rx_count: number; bucket: number };
type WB = {
  buckets: { bucket: number; count: number; lost_revenue: number; recoverable: number }[];
  items?: Row[];
  total_recoverable: number; total_lost: number;
};

export default function WinbackPage() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState<number | null>(null);   // κλικ σε κάρτα → οι ασφαλισμένοι της
  const { data, isLoading } = useQuery({ queryKey: ["pi-winback"], queryFn: () => api<WB>("/patient-intelligence/winback") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;

  const rows = (data?.items ?? []).filter((r) => r.bucket === open);
  const cols: Column<Row>[] = [
    { key: "name", header: t("Ασφαλισμένος", "Patient"), render: (r) => r.name || r.amka || "—" },
    { key: "amka", header: t("ΑΜΚΑ", "AMKA"), hideOnMobile: true, render: (r) => r.amka || "—" },
    { key: "last_seen", header: t("Τελ. επίσκεψη", "Last visit"), sortValue: (r) => r.days, render: (r) => r.last_seen ? fmtDate(r.last_seen) : "—" },
    { key: "days", header: t("Ημέρες αδράνειας", "Days inactive"), align: "right", sortValue: (r) => r.days, render: (r) => fmtNum(r.days) },
    { key: "value", header: t("Αξία", "Value"), align: "right", sortValue: (r) => r.value, render: (r) => <b>{fmtEur(r.value)}</b> },
    { key: "rx_count", header: t("Συνταγές", "Rx"), align: "right", hideOnMobile: true, sortValue: (r) => r.rx_count, render: (r) => fmtNum(r.rx_count) },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard label={t("Ανενεργοί ασθενείς", "Inactive patients")} help={t("Ασθενείς που σημάνθηκαν ανενεργοί (αποβίωσαν/μετακόμισαν/σταμάτησαν).", "Patients marked inactive.")} value={fmtNum((data?.buckets ?? []).reduce((s, b) => s + b.count, 0))} icon={Users} accent="rose" />
        <KpiCard label={t("Συνολικός χαμένος τζίρος", "Total lost revenue")} help={t("Συνολική αξία χαμένων (μη εκτελεσμένων) επαναλήψεων.", "Total lost turnover from missed refills.")} value={fmtEur(data?.total_lost ?? 0)} icon={Wallet} accent="amber" />
        <KpiCard label={t("Δυνητική ανάκτηση", "Potential recovery")} help={t("Αξία χαμένων/ανοιχτών επαναλήψεων που μπορείς να ανακτήσεις.", "Recoverable value of missed/open refills.")} value={fmtEur(data?.total_recoverable ?? 0)} icon={RotateCcw} accent="green" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(data?.buckets ?? []).map((b) => (
          <button key={b.bucket} type="button" onClick={() => setOpen(open === b.bucket ? null : b.bucket)}
            aria-pressed={open === b.bucket}
            className={`rx-card p-5 text-left transition hover:shadow-md ${open === b.bucket ? "ring-2 ring-brand-500" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{b.bucket} {t("ημέρες αδράνειας", "days inactive")}</div>
              {/* Όσο πιο πρόσφατη η αδράνεια, τόσο πιο επείγον: ο 60ήμερος γυρίζει ακόμη. */}
              <PriorityBadge level={winbackPriority(b.bucket)} />
            </div>
            <div className="mt-2 text-3xl font-bold text-slate-900 dark:text-slate-100">{fmtNum(b.count)}</div>
            <div className="text-xs text-slate-400">{t("ασθενείς", "patients")}</div>
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">{t("Χαμένος", "Lost")}</span><b className="text-rose-600">{fmtEur(b.lost_revenue)}</b></div>
              <div className="flex justify-between"><span className="text-slate-500">{t("Ανακτήσιμος", "Recoverable")}</span><b className="text-emerald-600">{fmtEur(b.recoverable)}</b></div>
            </div>
            <div className="mt-3 text-xs font-medium text-brand-600">{open === b.bucket ? t("Απόκρυψη λίστας ▴", "Hide list ▴") : t("Δες τους ασφαλισμένους ▾", "See patients ▾")}</div>
          </button>
        ))}
      </div>
      {open !== null && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            {open} {t("ημέρες αδράνειας", "days inactive")} · {fmtNum(rows.length)} {t("ασφαλισμένοι", "patients")}
          </div>
          <DataTable pageSize={20} columns={cols} rows={rows} rowKey={(r) => r.patient_id}
            onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)} empty={t("Καμία εγγραφή.", "No data.")} />
        </div>
      )}
      <p className="text-xs text-slate-400">{t("Η ανάκτηση εκτιμάται ως φθίνον ποσοστό της ιστορικής αξίας ανά διάστημα αδράνειας. Δες τη λίστα Recall για ασθενείς με στοιχεία επικοινωνίας.", "Recovery is estimated as a decaying fraction of historical value per inactivity window. See the Recall list for patients with contact details.")}</p>
    </div>
  );
}
