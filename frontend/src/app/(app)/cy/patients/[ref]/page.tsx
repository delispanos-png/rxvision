"use client";

/* RxVision Κύπρος — Καρτέλα πελάτη (ΓεΣΥ).
   Ό,τι ξέρουμε για τον πελάτη από τις εκτελέσεις του σε ΑΥΤΟ το φαρμακείο: ανοιχτές/χαμένες
   συνταγές (ίδιος ορισμός με τις λίστες), ιστορικό, γιατροί, απαλλαγή, διαβήτης (από αναλώσιμα). */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Calendar, CalendarRange, Loader2, Pill, Receipt, Target, Wallet } from "lucide-react";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { BarChart } from "@/components/charts/BarChart";
import { api, ApiError } from "@/lib/apiClient";
import { fmtDate, fmtDateTime, fmtDec, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";
import { ageOf, STATUS_STYLE, type ChainStatus } from "@/lib/cy";

type Amounts = { hio: number; beneficiary: number; pc2: number; total: number };
type Chain = { prescription_id: string; kind: string; doctor: string | null; next_due: string; days_to_due: number;
  instance: number; instances: number; items: string[]; value_at_stake_cents: number; status: ChainStatus | "closed" };
type Card = {
  patient: { ref: string; full_name: string | null; gender: string | null; dob: string | null; hio_code: string | null;
    first_seen: string | null; last_seen: string | null };
  flags: { exemption: "exempt" | "pays" | "unknown"; diabetic: boolean };
  totals: Amounts & { visits: number };
  doctors: { id: string | null; name: string; visits: number }[];
  kpis: { ltv: number; visits: number; per_month: number; value_per_month: number; this_month: number; gap_days: number | null;
    rank: { rank: number; of: number } | null };
  monthly: { month: string; visits: number; value: number }[];
  adherence: { compliance: number | null; missed: number; open: number; lost_value_cents: number; next_due: string | null };
  medicines: { name: string; kind: string; times: number; value: number; last: string; days_since: number; dosage: string | null }[];
  portal?: { invited: boolean; email: string | null };
  prescriptions: Chain[];
  history: { dispensing_id: string; kind: string; dispensed_at: string; doctor: string | null; instance: number; instances: number;
    totals: Amounts; lines: { description: string; qty_presc: number; qty_disp: number; total: number; pc2: number; days_covered: number | null }[] }[];
};

export default function CyPatientCardPage() {
  const t = useT();
  const { ref } = useParams<{ ref: string }>();
  const q = useQuery({ queryKey: ["cy", "patient", ref], queryFn: () => api<Card>(`/cy/patients/${encodeURIComponent(ref)}`) });
  const c = q.data;
  if (q.isLoading) return <Loader2 className="h-5 w-5 animate-spin text-slate-400" />;
  if (!c) return <p className="text-sm text-slate-500">{t("Ο πελάτης δεν βρέθηκε.", "Customer not found.")}</p>;
  const age = ageOf(c.patient.dob);
  const open = c.prescriptions.filter((p) => p.status !== "closed");
  const k = c.kpis, a = c.adherence;
  const MONTHS = t("Ιαν,Φεβ,Μαρ,Απρ,Μαϊ,Ιουν,Ιουλ,Αυγ,Σεπ,Οκτ,Νοε,Δεκ", "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec").split(",");

  return (
    <div className="space-y-5">
      <Link href="/cy/patients" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-indigo-600">
        <ArrowLeft className="h-4 w-4" />{t("Πίσω", "Back")}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{c.patient.full_name || "—"}</h1>
          <p className="text-sm text-slate-500">
            {age != null ? `${age} ${t("ετών", "yrs")}` : ""}
            {c.patient.gender ? ` · ${c.patient.gender === "F" ? t("Γυναίκα", "Female") : t("Άνδρας", "Male")}` : ""}
            {c.patient.dob ? ` · ${fmtDate(c.patient.dob)}` : ""}
            {c.patient.first_seen ? ` · ${t("πελάτης από", "customer since")} ${fmtDate(c.patient.first_seen)}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {c.flags.exemption === "exempt" && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">{t("Απαλλαγή συμμετοχής", "Co-payment exempt")}</span>}
            {c.flags.diabetic && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">{t("Διαβητικός (από αναλώσιμα)", "Diabetic (from consumables)")}</span>}
          </div>
          <PortalInvite refId={c.patient.ref} portal={c.portal} />
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("Τελευταία επίσκεψη", "Last visit")}</div>
          <div className="text-lg font-bold text-slate-900 dark:text-slate-100">
            {c.patient.last_seen ? fmtDate(c.patient.last_seen) : "—"}
            {k.gap_days != null && <span className={`ml-2 text-sm font-medium ${k.gap_days > 60 ? "text-rose-600" : k.gap_days > 35 ? "text-amber-600" : "text-emerald-600"}`}>
              {k.gap_days === 0 ? t("σήμερα", "today") : `${k.gap_days}${t("η πριν", "d ago")}`}</span>}
          </div>
          {k.rank && <div className="mt-1 text-xs text-slate-500">{t("Κατάταξη αξίας", "Value rank")}: #{k.rank.rank}/{fmtNum(k.rank.of)} ({t("top", "top")} {Math.max(1, Math.round(k.rank.rank / k.rank.of * 100))}%)</div>}
          <div className="mt-1 text-xs text-slate-500">{t("Πλήρωσε ο ίδιος", "Paid by customer")} {fmtEur(c.totals.beneficiary)}{c.totals.pc2 > 0 ? ` · PC2 ${fmtEur(c.totals.pc2)}` : ""}</div>
          <Link href={`/cy/dispensings?patient_ref=${encodeURIComponent(c.patient.ref)}`} className="mt-1 inline-block text-xs font-medium text-indigo-600 hover:underline">{t("Όλες οι εκτελέσεις του →", "All their dispensings →")}</Link>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("Αξία πελάτη (LTV)", "Lifetime value")} value={fmtEur(k.ltv)} icon={Wallet} accent="green"
          help={t("Συνολική αξία όλων των εκτελέσεων του πελάτη στο φαρμακείο σου.", "Total value of all the customer's dispensings at your pharmacy.")} />
        <KpiCard label={t("Αριθμός εκτελέσεων", "Dispensings")} value={fmtNum(k.visits)} icon={Receipt} accent="indigo" />
        <KpiCard label={t("Εκτελέσεις / μήνα", "Dispensings / month")} value={fmtDec(k.per_month, 1)} icon={CalendarRange} accent="indigo"
          help={t("Μέσος όρος εκτελέσεων ανά μήνα από την 1η εκτέλεση.", "Average dispensings per month since the first one.")} />
        <KpiCard label={t("Εκτελέσεις τρέχοντος μήνα", "This month")} value={fmtNum(k.this_month)} icon={Calendar} accent="sky" />
        <KpiCard label={t("Αξία / μήνα", "Value / month")} value={fmtEur(k.value_per_month)} icon={Wallet} accent="green" />
        <KpiCard label={t("Συμμόρφωση", "Adherence")} value={a.compliance != null ? `${a.compliance}%` : "—"} icon={Target}
          accent={a.compliance == null ? "sky" : a.compliance >= 80 ? "green" : a.compliance >= 50 ? "amber" : "rose"}
          help={t("Φάσεις συνταγών που εκτέλεσε εδώ ÷ φάσεις που έπρεπε να έχει εκτελέσει ως σήμερα (με περιθώριο 14 ημερών, όπως το «χάθηκε»).",
            "Prescription steps dispensed here ÷ steps that were due by today (with the same 14-day margin as «lost»).")} />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-900">
        <span>{t("Φάσεις που δεν ήρθε να πάρει", "Steps not picked up")}: <b className="text-rose-600">{a.missed}</b></span>
        <span>{t("Ανοιχτές συνταγές", "Open prescriptions")}: <b className="text-amber-600">{a.open}</b></span>
        <span>{t("Αξία προς ανάκτηση", "Recoverable value")}: <b className="text-rose-600">{fmtEur(a.lost_value_cents)}</b></span>
        {a.next_due && <span className="ml-auto text-slate-500">{t("Επόμενη επίσκεψη", "Next visit")}: {fmtDate(a.next_due)}</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title={t("Εκτελέσεις ανά μήνα (12 μήνες)", "Dispensings per month (12 months)")} className="lg:col-span-2">
          <BarChart height={240} name={t("Εκτελέσεις", "Dispensings")}
            labels={c.monthly.map((m) => { const [y, mo] = m.month.split("-"); return `${MONTHS[Number(mo) - 1]} ${y.slice(2)}`; })}
            data={c.monthly.map((m) => m.visits)} />
        </PanelCard>
        <PanelCard title={t("Συχνότερα σκευάσματα", "Most frequent products")}>
          <ul className="space-y-1.5 text-sm">
            {c.medicines.map((m) => (
              <li key={m.name} className="flex items-center gap-2" title={m.dosage ?? ""}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${m.days_since <= 30 ? "bg-emerald-500" : m.days_since <= 60 ? "bg-amber-400" : "bg-slate-300"}`} />
                <Pill className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span className="shrink-0 text-xs text-slate-500">{m.times}× · {m.days_since}{t("ημ.", "d")}</span>
              </li>
            ))}
            {c.medicines.length === 0 && <li className="text-slate-400">—</li>}
          </ul>
          <div className="mt-3 flex gap-3 text-[11px] text-slate-400">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> {t("≤30 ημ.", "≤30d")}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" /> {t("≤60 ημ.", "≤60d")}</span>
          </div>
        </PanelCard>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Ανοιχτές συνταγές", "Open prescriptions")} · {open.length}</h2>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {open.map((p) => (
            <li key={p.prescription_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate">{p.items.join(" · ")}</div>
                <div className="text-xs text-slate-400">{t("φάση", "step")} {p.instance}/{p.instances}{p.doctor ? ` · ${p.doctor}` : ""}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">{t("επόμενη", "next")} {fmtDate(p.next_due)}</span>
                {p.status !== "closed" && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status].cls}`}>{t(STATUS_STYLE[p.status].el, STATUS_STYLE[p.status].en)}</span>}
              </div>
            </li>
          ))}
          {open.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">{t("Καμία ανοιχτή συνταγή.", "No open prescriptions.")}</li>}
        </ul>
      </section>

      {c.doctors.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-2 font-semibold">{t("Συνταγογράφοι", "Prescribers")}</h2>
          <div className="flex flex-wrap gap-2">{c.doctors.map((d) => d.id
            ? <Link key={d.id} href={`/cy/doctors/${encodeURIComponent(d.id)}`} className="rounded-lg bg-slate-100 px-2 py-1 text-xs hover:bg-indigo-50 hover:text-indigo-700 dark:bg-slate-800">{d.name} · {d.visits}</Link>
            : <span key={d.name} className="rounded-lg bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{d.name} · {d.visits}</span>)}</div>
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Ιστορικό εκτελέσεων", "Dispensing history")}</h2>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {c.history.map((h) => (
            <li key={h.dispensing_id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">{fmtDateTime(h.dispensed_at)} · {h.kind === "drug" ? t("Φάρμακα", "Drugs") : t("Αναλώσιμα", "Consumables")} · {h.instance}/{h.instances}</span>
                <span className="text-slate-500">{h.doctor || ""} · {fmtEur(h.totals.total)}</span>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                {h.lines.map((l, i) => (
                  <li key={i} className={l.qty_disp === 0 ? "text-amber-700" : ""}>
                    {l.description} — {l.qty_disp}/{l.qty_presc}
                    {l.qty_disp === 0 ? ` · ${t("δεν δόθηκε", "not given")}` : ` · ${fmtEur(l.total)}`}
                    {l.pc2 > 0 ? ` · PC2 ${fmtEur(l.pc2)}` : ""}
                    {l.days_covered ? ` · ${t("καλύπτει", "covers")} ${l.days_covered} ${t("ημ.", "d")}` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const ERR: Record<string, [string, string]> = {
  id_mismatch: ["Η ταυτότητα δεν ταιριάζει με αυτή των συνταγών του πελάτη. Έλεγξε τον αριθμό και τον τύπο εγγράφου.", "The ID does not match the customer's prescriptions. Check the number and document type."],
  no_id_on_file: ["Δεν υπάρχει ταυτότητα στις συνταγές αυτού του πελάτη. Ανέβασε ξανά τα XML του.", "No ID on file for this customer. Re-upload their XML files."],
  already_invited: ["Ο πελάτης έχει ήδη λογαριασμό στην πύλη.", "The customer already has a portal account."],
  email_exists: ["Υπάρχει ήδη λογαριασμός με αυτό το email.", "An account with this email already exists."],
  bad_email: ["Το email δεν είναι έγκυρο.", "The email is not valid."],
  email_failed: ["Ο λογαριασμός δημιουργήθηκε, αλλά το email δεν στάλθηκε. Δοκίμασε ξανά αργότερα.", "The account was created but the email was not sent."],
  portal_not_enabled: ["Η πύλη πελατών δεν είναι ενεργή για το φαρμακείο σου.", "The customer portal is not enabled for your pharmacy."],
};

/** Πρόσκληση πελάτη ΓεΣΥ στην πύλη: ο φαρμακοποιός επιβεβαιώνει την ταυτότητα/ARC που βλέπει μπροστά του. */
function PortalInvite({ refId, portal }: { refId: string; portal?: { invited: boolean; email: string | null } }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ doc_type: "NID", doc_number: "", email: "", phone: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (portal?.invited) {
    return <p className="mt-2 text-xs text-emerald-700">✓ {t("Έχει λογαριασμό στην πύλη", "Has a portal account")} ({portal.email})</p>;
  }
  async function send() {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ ok: boolean; error?: string; email?: string }>(`/cy/patients/${encodeURIComponent(refId)}/portal-invite`,
        { method: "POST", body: JSON.stringify({ ...f, phone: f.phone || null }) });
      if (r.ok) { setMsg({ ok: true, text: t(`Στάλθηκε πρόσκληση στο ${r.email}.`, `Invitation sent to ${r.email}.`) }); qc.invalidateQueries({ queryKey: ["cy", "patient", refId] }); }
      else { const e = ERR[r.error || ""]; setMsg({ ok: false, text: e ? t(e[0], e[1]) : t("Η πρόσκληση απέτυχε.", "The invitation failed.") }); }
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: string })?.detail : "";
      const m = ERR[d || ""]; setMsg({ ok: false, text: m ? t(m[0], m[1]) : t("Η πρόσκληση απέτυχε.", "The invitation failed.") });
    } finally { setBusy(false); }
  }
  const inp = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800";
  return (
    <div className="mt-3">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">
          {t("Πρόσκληση στην πύλη πελατών", "Invite to the customer portal")}
        </button>
      ) : (
        <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-xs text-slate-500">{t("Γράψε την ταυτότητα (ή ARC) που σου δείχνει ο πελάτης: πρέπει να ταιριάζει με αυτή των συνταγών του. Ο πελάτης θα πάρει email με τα στοιχεία σύνδεσης.",
            "Enter the ID card (or ARC) the customer shows you: it must match their prescriptions. The customer will receive an email with login details.")}</p>
          <div className="flex flex-wrap gap-2">
            <select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })} className={inp}>
              <option value="NID">{t("Ταυτότητα", "ID card")}</option><option value="ARC">ARC</option>
            </select>
            <input value={f.doc_number} onChange={(e) => setF({ ...f, doc_number: e.target.value })} placeholder={t("Αριθμός", "Number")} className={inp} />
            <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="email" type="email" className={inp} />
            <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder={t("Κινητό (προαιρετικό)", "Mobile (optional)")} className={inp} />
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy || !f.doc_number.trim() || !f.email.includes("@")} onClick={send}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "…" : t("Αποστολή πρόσκλησης", "Send invitation")}</button>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500">{t("Άκυρο", "Cancel")}</button>
          </div>
          {msg && <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
        </div>
      )}
    </div>
  );
}
