"use client";

/* RxVision Κύπρος: Καρτέλα γιατρού (όπως στην Ελλάδα). Τι φέρνει στο φαρμακείο, πώς αλλάζει
   μέσα στους 12 μήνες, ποιοι πελάτες του έρχονται εδώ και τι συνταγογραφεί συχνότερα.
   Το XML ΓεΣΥ δεν έχει ειδικότητα, μόνο κωδικό, όνομα και τηλέφωνα. */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, Loader2, Receipt, Users, Wallet } from "lucide-react";
import { api } from "@/lib/apiClient";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { BarChart } from "@/components/charts/BarChart";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { fmtDate, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Pat = { patient_ref: string; full_name: string | null; rx: number; value: number; last: string };
type Doc = {
  doctor: { id: string; name: string | null; phones: string[] };
  totals: { executions: number; value: number; hio: number; prescriptions: number; patient_count: number };
  open_prescriptions: number; lost_prescriptions: number;
  monthly: { bucket: string; value: number; executions: number }[];
  patients: Pat[];
  items: { key: string | null; name: string | null; times: number; value: number }[];
};

export default function CyDoctorPage() {
  const t = useT();
  const router = useRouter();
  const id = decodeURIComponent(useParams<{ id: string }>().id);
  const q = useQuery({ queryKey: ["cy", "doctor", id], queryFn: () => api<Doc>(`/cy/doctors/${encodeURIComponent(id)}`), retry: false });
  if (q.isLoading) return <Loader2 className="h-5 w-5 animate-spin text-slate-400" />;
  const d = q.data;
  if (!d) return <p className="text-sm text-slate-500">{t("Ο γιατρός δεν βρέθηκε.", "Doctor not found.")}</p>;
  const MONTHS = t("Ιαν,Φεβ,Μαρ,Απρ,Μαϊ,Ιουν,Ιουλ,Αυγ,Σεπ,Οκτ,Νοε,Δεκ", "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec").split(",");
  const cols: Column<Pat>[] = [
    { key: "full_name", header: t("Πελάτης", "Customer"), render: (r) => <span className="font-medium">{r.full_name || "—"}</span> },
    { key: "rx", header: t("Εκτελέσεις", "Dispensings"), align: "right", render: (r) => fmtNum(r.rx) },
    { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value) },
    { key: "last", header: t("Τελευταία", "Last"), hideOnMobile: true, render: (r) => fmtDate(r.last) },
  ];

  return (
    <div className="space-y-4">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> {t("Πίσω", "Back")}
      </button>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">🩺 {d.doctor.name || d.doctor.id}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Κωδικός", "Code")} {d.doctor.id}{d.doctor.phones.length ? ` · ☎ ${d.doctor.phones.join(", ")}` : ""}</p>
        </div>
        <Link href={`/cy/dispensings?doctor_id=${encodeURIComponent(d.doctor.id)}`} className="text-sm font-medium text-brand-600 hover:underline">
          {t("Όλες οι εκτελέσεις του →", "All their dispensings →")}
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label={t("Αξία που φέρνει", "Value brought")} value={fmtEur(d.totals.value)} icon={Wallet} accent="green"
          sub={`${t("ΟΑΥ", "HIO")} ${fmtEur(d.totals.hio)}`} help={t("Συνολική αξία των εκτελέσεων με συνταγές αυτού του γιατρού, σε όλο το ιστορικό.", "Total value of dispensings of this doctor's prescriptions, all history.")} />
        <KpiCard label={t("Πελάτες", "Customers")} value={fmtNum(d.totals.patient_count)} icon={Users} accent="sky" />
        <KpiCard label={t("Εκτελέσεις", "Dispensings")} value={fmtNum(d.totals.executions)} icon={Receipt} accent="indigo"
          sub={`${fmtNum(d.totals.prescriptions)} ${t("συνταγές", "prescriptions")}`} />
        <KpiCard label={t("Ανοιχτές συνταγές", "Open prescriptions")} value={fmtNum(d.open_prescriptions)} icon={CalendarClock} accent="amber"
          sub={`${fmtNum(d.lost_prescriptions)} ${t("χάθηκαν", "lost")}`}
          help={t("Συνταγές του γιατρού που έχουν κι άλλες φάσεις να εκτελεστούν εδώ. «Χάθηκαν»: δεν συνεχίστηκαν εδώ.", "This doctor's prescriptions with steps still to dispense here. «Lost»: not continued here.")} />
      </div>

      <PanelCard title={t("Αξία ανά μήνα (12 μήνες)", "Value per month (12 months)")}>
        <BarChart height={260} name="€"
          labels={d.monthly.map((m) => { const [y, mo] = m.bucket.split("-"); return `${MONTHS[Number(mo) - 1]} ${y.slice(2)}`; })}
          data={d.monthly.map((m) => Math.round(m.value / 100))} />
      </PanelCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title={t("Οι πελάτες του", "Their customers")} className="lg:col-span-2">
          <DataTable pageSize={15} columns={cols} rows={d.patients} rowKey={(r) => r.patient_ref}
            onRowClick={(r) => router.push(`/cy/patients/${encodeURIComponent(r.patient_ref)}`)} />
        </PanelCard>
        <PanelCard title={t("Συχνότερα σκευάσματα", "Most frequent products")}>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {d.items.map((i) => (
              <li key={i.key ?? i.name ?? "?"} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate" title={i.name ?? ""}>{i.name || "—"}</span>
                <span className="shrink-0 text-xs text-slate-500">{i.times}× · {fmtEur(i.value)}</span>
              </li>
            ))}
          </ul>
        </PanelCard>
      </div>
    </div>
  );
}
