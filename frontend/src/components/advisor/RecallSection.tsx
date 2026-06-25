"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Phone, MessageSquare, Mail, PhoneCall, Users, AlertTriangle, Wallet, Pill, ExternalLink } from "lucide-react";
import { fmtEur, fmtDate, fmtMoney} from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { KpiCard } from "@/components/kpi/KpiCard";
import { ExportMenu } from "@/components/export/ExportMenu";
import { PanelCard } from "@/components/ui/Card";
import { Tooltip } from "@/components/ui/Tooltip";
import { Modal } from "@/components/ui/Modal";

type RecallPat = {
  patient_id: string; name?: string | null; amka?: string | null; age_group?: string | null;
  last_seen?: string | null; missed: number; available: number; value: number;
  mobile?: string | null; phone?: string | null; email?: string | null; consent?: boolean; has_contact: boolean;
};
type Recall = {
  items: RecallPat[]; patients: number; total_value: number; total_missed: number;
  total_available: number; with_contact: number;
};
type Win = { due: string; status: string };
type Intent = { decision?: string | null; visit_date?: string | null; reason?: string | null } | null;
type Chain = { key?: string | null; medicine?: string | null; valid_from: string; valid_until: string; missed: number; available: number; value: number; windows: Win[]; intent?: Intent };
type RecallDetail = { found: boolean; name?: string | null; amka?: string | null; coverage_start?: string | null; chains: Chain[] };

export function RecallSection() {
  const t = useT();
  const router = useRouter();
  const q = useQuery({ queryKey: ["recall"], queryFn: () => api<Recall>("/advisor/recall"), retry: false });
  const [sel, setSel] = useState<RecallPat | null>(null);
  const det = useQuery({
    queryKey: ["recall-detail", sel?.patient_id],
    queryFn: () => api<RecallDetail>(`/advisor/recall/${encodeURIComponent(sel!.patient_id)}`),
    enabled: !!sel,
  });
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
          {tel && <Tooltip label={t("Κλήση", "Call")}><a href={`tel:${tel}`} aria-label={t("Κλήση", "Call")} className="rounded-lg border border-slate-200 p-1.5 text-emerald-600 hover:bg-emerald-50 dark:border-slate-700"><Phone className="h-3.5 w-3.5" /></a></Tooltip>}
          {r.mobile && <Tooltip label="SMS"><a href={`sms:${r.mobile}`} aria-label="SMS" className="rounded-lg border border-slate-200 p-1.5 text-brand-600 hover:bg-brand-50 dark:border-slate-700"><MessageSquare className="h-3.5 w-3.5" /></a></Tooltip>}
          {r.email && <Tooltip label="Email"><a href={`mailto:${r.email}`} aria-label="Email" className="rounded-lg border border-slate-200 p-1.5 text-amber-600 hover:bg-amber-50 dark:border-slate-700"><Mail className="h-3.5 w-3.5" /></a></Tooltip>}
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
        onRowClick={(r) => setSel(r)}
        empty={t("Καμία εκκρεμή επανάληψη.", "No pending repeats.")} />

      <Modal open={!!sel} onClose={() => setSel(null)} size="2xl"
        title={`${t("Χαμένες/διαθέσιμες επαναλήψεις", "Missed/available repeats")} · ${sel?.name || sel?.amka || ""}`}>
        {det.isLoading ? <div className="p-6 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : !det.data?.chains?.length ? (
          <div className="p-6 text-center text-sm text-slate-400">{t("Δεν βρέθηκαν λεπτομέρειες.", "No details found.")}</div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              {t("Διαθέσιμες τώρα (εκτελέσιμες) πρώτες. Για τις οριστικά χαμένες κρατάμε μόνο ιστορικό. Επαναλήψεις πριν την έναρξη των δεδομένων μας δεν προσμετρώνται.",
                 "Available-now (executable) first. Definitively missed ones are kept as history only. Renewals before our data coverage start are not counted.")}
              {det.data?.coverage_start ? ` ${t("Κάλυψη δεδομένων από", "Data coverage from")}: ${fmtDate(det.data.coverage_start)}.` : ""}
            </p>

            {/* Εύκολη ειδοποίηση πελάτη για τις ΔΙΑΘΕΣΙΜΕΣ ανανεώσεις (SMS/email, prefilled) */}
            {(() => {
              const avail = det.data.chains.filter((c) => c.available > 0).map((c) => c.medicine || "").filter(Boolean);
              if (!avail.length) return null;
              const tel = sel?.mobile || sel?.phone;
              const msg = t(
                `Καλησπέρα${sel?.name ? " " + sel.name : ""}, στο φαρμακείο σας είναι διαθέσιμες προς εκτέλεση οι επαναλήψεις: ${avail.join(", ")}. Περάστε να τις παραλάβετε ή δείτε τις στο my.rxvision.gr`,
                `Hello${sel?.name ? " " + sel.name : ""}, these repeat prescriptions are available to dispense at your pharmacy: ${avail.join(", ")}. Visit us or check my.rxvision.gr`);
              return (
                <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 dark:border-sky-900 dark:bg-sky-950/30">
                  <div className="mb-2 text-sm font-semibold text-sky-800 dark:text-sky-200">{t("Ενημέρωσε τον πελάτη για τις διαθέσιμες ανανεώσεις", "Notify the patient about available renewals")}</div>
                  {tel || sel?.email ? (
                    <div className="flex flex-wrap gap-2">
                      {sel?.mobile && <a href={`sms:${sel.mobile}?&body=${encodeURIComponent(msg)}`} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"><MessageSquare className="h-4 w-4" /> SMS</a>}
                      {sel?.email && <a href={`mailto:${sel.email}?subject=${encodeURIComponent(t("Διαθέσιμες ανανεώσεις συνταγών", "Available prescription renewals"))}&body=${encodeURIComponent(msg)}`} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"><Mail className="h-4 w-4" /> Email</a>}
                      {tel && <a href={`tel:${tel}`} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50"><Phone className="h-4 w-4" /> {t("Κλήση", "Call")}</a>}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">{t("Δεν υπάρχουν στοιχεία επικοινωνίας — πρόσθεσέ τα στην καρτέλα του ασθενή. Αν είναι εγγεγραμμένος στο my.rxvision, τα βλέπει αυτόματα εκεί.", "No contact details — add them in the patient profile. If registered on my.rxvision, they see these automatically there.")}</div>
                  )}
                  <div className="mt-1.5 text-[11px] text-sky-700 dark:text-sky-300">{t("Αν ο πελάτης είναι εγγεγραμμένος στο my.rxvision, βλέπει τις διαθέσιμες ανανεώσεις και στην εφαρμογή του.", "If registered on my.rxvision, the patient also sees these in their app.")}</div>
                </div>
              );
            })()}
            {det.data.chains.map((c, i) => (
              <div key={i} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100"><Pill className="h-4 w-4 text-brand-600" /> {c.medicine || t("Φάρμακο", "Medicine")}</span>
                  <span className="text-sm"><b className="text-rose-600">{fmtEur(c.value)}</b> <span className="text-slate-400">{t("σε ρίσκο", "at risk")}</span></span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {c.windows.filter((w) => w.status === "missed" || w.status === "available").map((w, j) => (
                    <span key={j} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${w.status === "missed" ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300" : "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"}`}>
                      {fmtDate(w.due)} · {w.status === "missed" ? t("χάθηκε", "missed") : t("διαθέσιμη", "available")}
                    </span>
                  ))}
                </div>
                <div className="mt-1.5 text-[11px] text-slate-400">
                  {c.missed ? t(`${c.missed} χαμένες (πέρασε το παράθυρο επανάληψης χωρίς εκτέλεση)`, `${c.missed} missed (repeat window passed unexecuted)`) : ""}
                  {c.missed && c.available ? " · " : ""}
                  {c.available ? t(`${c.available} διαθέσιμη τώρα (μπορεί να εκτελεστεί)`, `${c.available} available now`) : ""}
                </div>
                {c.intent?.decision === "take" && <div className="mt-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">🟢 {t("Ο πελάτης δήλωσε ότι θα το παραλάβει", "Patient will pick up")}{c.intent.visit_date ? ` — ${fmtDate(c.intent.visit_date)}` : ""} <span className="text-emerald-500">({t("προγραμμάτισε διαθεσιμότητα", "plan availability")})</span></div>}
                {c.intent?.decision === "skip" && <div className="mt-1.5 rounded-lg bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">🔴 {t("Ο πελάτης δήλωσε ότι ΔΕΝ θα το παραλάβει", "Patient will NOT pick up")}{c.intent.reason ? `: ${c.intent.reason}` : ""}</div>}
              </div>
            ))}
            <button onClick={() => router.push(`/patients/${encodeURIComponent(sel!.patient_id)}`)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">
              <ExternalLink className="h-4 w-4" /> {t("Πλήρης καρτέλα ασθενή", "Full patient profile")}
            </button>
          </div>
        )}
      </Modal>
    </PanelCard>
  );
}
