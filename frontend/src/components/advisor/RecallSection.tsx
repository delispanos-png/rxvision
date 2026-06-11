"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Phone, MessageSquare, Mail, PhoneCall, Users, AlertTriangle, Wallet } from "lucide-react";
import { fmtEur, fmtDate, fmtMoney} from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { ExportMenu } from "@/components/export/ExportMenu";
import { PanelCard } from "@/components/ui/Card";

type RecallPat = {
  patient_id: string; name?: string | null; amka?: string | null; age_group?: string | null;
  last_seen?: string | null; missed: number; available: number; value: number;
  mobile?: string | null; phone?: string | null; email?: string | null; consent?: boolean; has_contact: boolean;
};
type Recall = {
  items: RecallPat[]; patients: number; total_value: number; total_missed: number;
  total_available: number; with_contact: number;
};

export function RecallSection() {
  const t = useT();
  const router = useRouter();
  const q = useQuery({ queryKey: ["recall"], queryFn: () => api<Recall>("/advisor/recall"), retry: false });
  const d = q.data;
  if (!d || d.patients === 0) return null;

  const cols: Column<RecallPat>[] = [
    { key: "name", header: t("Ασθενής", "Patient"), render: (r) => r.name || r.amka || "—", sortValue: (r) => r.name || "" },
    { key: "available", header: t("Διαθέσιμες τώρα", "Available now"), align: "right", sortValue: (r) => r.available,
      render: (r) => r.available ? <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">{r.available}</span> : <span className="text-slate-300">—</span> },
    { key: "missed", header: t("Χαμένες", "Missed"), align: "right", sortValue: (r) => r.missed,
      render: (r) => r.missed ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">{r.missed}</span> : <span className="text-slate-300">—</span> },
    { key: "value", header: t("Αξία ρίσκου", "Value at risk"), align: "right", sortValue: (r) => r.value,
      render: (r) => <b className="text-slate-800 dark:text-slate-100">{fmtEur(r.value)}</b> },
    { key: "last_seen", header: t("Τελ. επίσκεψη", "Last visit"), hideOnMobile: true, sortValue: (r) => r.last_seen || "",
      render: (r) => r.last_seen ? fmtDate(r.last_seen) : "—" },
    { key: "contact", header: t("Επικοινωνία", "Contact"), fullWidthOnMobile: true, render: (r) => {
      const tel = r.mobile || r.phone;
      if (!tel && !r.email) return <span className="text-xs text-slate-300">— {t("πρόσθεσε στοιχεία", "add details")}</span>;
      return (
        <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {tel && <a href={`tel:${tel}`} title={t("Κλήση", "Call")} aria-label={t("Κλήση", "Call")} className="rounded-lg border border-slate-200 p-1.5 text-emerald-600 hover:bg-emerald-50 dark:border-slate-700"><Phone className="h-3.5 w-3.5" /></a>}
          {r.mobile && <a href={`sms:${r.mobile}`} title="SMS" aria-label="SMS" className="rounded-lg border border-slate-200 p-1.5 text-brand-600 hover:bg-brand-50 dark:border-slate-700"><MessageSquare className="h-3.5 w-3.5" /></a>}
          {r.email && <a href={`mailto:${r.email}`} title="Email" aria-label="Email" className="rounded-lg border border-slate-200 p-1.5 text-amber-600 hover:bg-amber-50 dark:border-slate-700"><Mail className="h-3.5 w-3.5" /></a>}
          {r.consent && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">{t("συγκατάθεση", "consent")}</span>}
        </span>
      );
    } },
  ];

  return (
    <PanelCard title={t("📞 Λίστα Recall — ασθενείς με χαμένες/διαθέσιμες επαναλήψεις", "📞 Recall list — patients with missed/available repeats")} defaultOpen
      action={<ExportMenu filename="lista-recall" title={t("Λίστα Recall", "Recall list")} rows={d.items} columns={[
        { key: "name", header: t("Ασθενής", "Patient"), value: (r) => r.name || r.amka || "" },
        { key: "amka", header: "ΑΜΚΑ" },
        { key: "available", header: t("Διαθέσιμες τώρα", "Available now") },
        { key: "missed", header: t("Χαμένες", "Missed") },
        { key: "value", header: t("Αξία ρίσκου (€)", "Value at risk (€)"), value: (r) => fmtMoney(r.value) },
        { key: "mobile", header: t("Κινητό", "Mobile"), value: (r) => r.mobile || r.phone || "" },
        { key: "email", header: "Email", value: (r) => r.email || "" },
      ]} />}>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("Ασθενείς για recall", "Patients to recall")} value={`${d.patients}`} sub={t("με χαμένη/διαθέσιμη επανάληψη", "with a missed/available repeat")} icon={Users} accent="indigo" />
        <KpiCard label={t("Αξία σε ρίσκο", "Value at risk")} value={fmtEur(d.total_value)} sub={t("ανακτήσιμος τζίρος", "recoverable turnover")} icon={Wallet} accent="amber" />
        <KpiCard label={t("Διαθέσιμες τώρα", "Available now")} value={`${d.total_available}`} sub={t("μπορούν να εκτελεστούν", "can be executed")} icon={PhoneCall} accent="sky" />
        <KpiCard label={t("Χαμένες", "Missed")} value={`${d.total_missed}`} sub={t("πέρασε το παράθυρο", "window has passed")} icon={AlertTriangle} accent="rose" />
      </div>

      {d.with_contact < d.patients && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <PhoneCall className="h-4 w-4 shrink-0" />
          {t(`Μόνο ${d.with_contact}/${d.patients} έχουν στοιχεία επικοινωνίας — πρόσθεσέ τα (κλικ στον ασθενή) για 1-click κλήση/SMS/email και αυτόματες καμπάνιες.`,
             `Only ${d.with_contact}/${d.patients} have contact details — add them (click a patient) for 1-click call/SMS/email and automated campaigns.`)}
        </div>
      )}

      <DataTable pageSize={15} columns={cols} rows={d.items} rowKey={(r) => r.patient_id}
        onRowClick={(r) => router.push(`/patients/${encodeURIComponent(r.patient_id)}`)}
        empty={t("Καμία εκκρεμή επανάληψη.", "No pending repeats.")} />
    </PanelCard>
  );
}
