"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone, Mail, MessageSquare, Save, Loader2, Check, Pencil, X, ShieldCheck, AlertTriangle, DownloadCloud } from "lucide-react";
import { api, API_BASE } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appAlert } from "@/store/dialogStore";
import { PanelCard } from "@/components/ui/Card";
import { Tooltip } from "@/components/ui/Tooltip";

type Contact = {
  phone?: string | null; mobile?: string | null; email?: string | null;
  address?: string | null; city?: string | null; postal_code?: string | null;
  notes?: string | null; marketing_consent?: boolean; preferred_channel?: string | null;
  active?: boolean; inactive_reason?: string | null;
  height_cm?: number | string | null;
  updated_at?: string | null;
};

type ContactStatus = {
  verified?: boolean; needs_confirmation?: boolean; source?: string | null;
  contact_updated_at?: string | null; idyka_fetched_at?: string | null;
  has_email?: boolean; has_mobile?: boolean; has_contact?: boolean;
  avatar_url?: string | null;
};

const ddmmyyyy = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

const empty: Contact = { marketing_consent: false, preferred_channel: "mobile", active: true };

// ΠΡΟΣΟΧΗ: το Field ΠΡΕΠΕΙ να είναι σε module scope (σταθερή identity). Αν οριστεί inline μέσα στο
// ContactCard, κάθε keystroke → re-render → νέα συνάρτηση → React ξαναφτιάχνει το <input> → χάνεται το
// focus (αποθηκεύεται 1 ψηφίο και χρειάζεται νέο κλικ). Περνάμε f/set ως props.
function Field({ label, k, type = "text", ph, f, set }: {
  label: string; k: keyof Contact; type?: string; ph?: string;
  f: Contact; set: (k: keyof Contact, v: string | boolean) => void;
}) {
  return (
    <label className="text-sm">
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      <input type={type} value={(f[k] as string) || ""} onChange={(e) => set(k, e.target.value)} placeholder={ph}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
    </label>
  );
}

/** Στοιχεία επικοινωνίας πελάτη (pharmacist-controlled). Με `collapsible` ξεκινά κλειστή
 *  (μόνο σύνοψη) και ανοίγει η φόρμα με «Επεξεργασία» — για αλλαγή μόνο όταν χρειάζεται. */
export function ContactCard({ patientId, collapsible = false, extraAction, openEditSignal = 0 }: { patientId: string; collapsible?: boolean; extraAction?: ReactNode; openEditSignal?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["patient-contact", patientId],
    queryFn: () => api<Contact>(`/patients/${encodeURIComponent(patientId)}/contact`),
    retry: false,
  });
  const [f, setF] = useState<Contact>(empty);
  const [editing, setEditing] = useState(!collapsible);
  useEffect(() => { if (data) setF({ ...empty, ...data }); }, [data]);
  // Εξωτερικό σήμα (π.χ. pop-up ταμείου) για να ανοίξει η φόρμα σε λειτουργία επεξεργασίας.
  useEffect(() => { if (openEditSignal > 0) setEditing(true); }, [openEditSignal]);
  const set = (k: keyof Contact, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: () => api<Contact>(`/patients/${encodeURIComponent(patientId)}/contact`, { method: "PUT", body: JSON.stringify({ ...f, height_cm: f.height_cm ? Number(f.height_cm) : null }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient-contact", patientId] });
      qc.invalidateQueries({ queryKey: ["patient-contact-status", patientId] });
      if (collapsible) setEditing(false);
    },
  });

  // Κατάσταση επιβεβαίωσης (verified / μόνο-ΗΔΥΚΑ / παλιά) + ημ/νία τελευταίας ενημέρωσης.
  const { data: st } = useQuery({
    queryKey: ["patient-contact-status", patientId],
    queryFn: () => api<ContactStatus>(`/patients/${encodeURIComponent(patientId)}/contact-status`),
    retry: false,
  });

  // Άντληση στοιχείων από ΗΔΥΚΑ (γεμίζει μόνο κενά· χωρίς συγκατάθεση/επιβεβαίωση).
  const pull = useMutation({
    mutationFn: () => api<{ found: boolean; error?: string; filled?: string[] }>(`/patients/${encodeURIComponent(patientId)}/contact/from-hdika`, { method: "POST" }),
    onSuccess: async (r) => {
      qc.invalidateQueries({ queryKey: ["patient-contact", patientId] });
      qc.invalidateQueries({ queryKey: ["patient-contact-status", patientId] });
      if (!r.found) {
        const msg: Record<string, string> = {
          not_configured: t("Δεν έχουν ρυθμιστεί διαπιστευτήρια ΗΔΥΚΑ.", "ΗΔΥΚΑ credentials not configured."),
          invalid_amka: t("Μη έγκυρο ΑΜΚΑ.", "Invalid ΑΜΚΑ."),
          deceased: t("Η ΗΔΥΚΑ επισημαίνει αποβίωση.", "ΗΔΥΚΑ marks the patient as deceased."),
          hdika_unavailable: t("Η ΗΔΥΚΑ δεν είναι διαθέσιμη αυτή τη στιγμή.", "ΗΔΥΚΑ is currently unavailable."),
        };
        await appAlert(msg[r.error || ""] || t("Δεν βρέθηκαν στοιχεία στη ΗΔΥΚΑ.", "No details found in ΗΔΥΚΑ."), { title: t("Άντληση από ΗΔΥΚΑ", "Fetch from ΗΔΥΚΑ") });
      } else if (!(r.filled || []).length) {
        await appAlert(t("Δεν προστέθηκε κάτι — τα πεδία ήταν ήδη συμπληρωμένα.", "Nothing added — fields were already filled."), { title: t("Άντληση από ΗΔΥΚΑ", "Fetch from ΗΔΥΚΑ") });
      }
    },
  });

  const tel = (data?.mobile || data?.phone) ?? null;

  // Badge κατάστασης επιβεβαίωσης — για σύνοψη & φόρμα.
  const statusBadge = st && (data?.mobile || data?.phone || data?.email) ? (
    st.needs_confirmation ? (
      <Tooltip label={st.source === "idyka" ? t("Στοιχεία μόνο από ΗΔΥΚΑ — ζήτησε επιβεβαίωση από τον πελάτη.", "ΗΔΥΚΑ-only data — ask the patient to confirm.") : t("Τα στοιχεία θέλουν (επαν)επιβεβαίωση.", "Details need (re)confirmation.")}>
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
          <AlertTriangle className="h-3 w-3" />{st.source === "idyka" ? t("Μόνο ΗΔΥΚΑ", "ΗΔΥΚΑ-only") : t("Θέλει επιβεβαίωση", "Needs confirmation")}
        </span>
      </Tooltip>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
        <ShieldCheck className="h-3 w-3" />{t("Επιβεβαιωμένα", "Verified")}{ddmmyyyy(st.contact_updated_at) ? ` · ${ddmmyyyy(st.contact_updated_at)}` : ""}
      </span>
    )
  ) : null;

  // Φωτογραφία προφίλ που ανέβασε ο πελάτης από την πύλη my.rxvision.
  const avatar = st?.avatar_url ? (
    <Tooltip label={t("Φωτογραφία από my.rxvision (ανέβασμα πελάτη)", "Photo from my.rxvision (patient upload)")}>
      <img src={`${API_BASE}${st.avatar_url}`} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover ring-2 ring-brand-200 dark:ring-brand-800" />
    </Tooltip>
  ) : null;

  // Κουμπί «Άντληση από ΗΔΥΚΑ»
  const hdikaBtn = (
    <Tooltip label={t("Συμπλήρωση κενών στοιχείων από ΗΔΥΚΑ", "Fill empty details from ΗΔΥΚΑ")}>
      <button onClick={() => pull.mutate()} disabled={pull.isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300">
        {pull.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />} {t("Άντληση ΗΔΥΚΑ", "Fetch ΗΔΥΚΑ")}
      </button>
    </Tooltip>
  );

  // quick call/SMS/email actions (κοινά και στις δύο προβολές)
  const quickActions = (
    <div className="flex gap-1.5">
      {tel && <Tooltip label={t("Κλήση", "Call")}><a href={`tel:${tel}`} aria-label={t("Κλήση", "Call")} className="rounded-lg border border-slate-200 p-1.5 text-emerald-600 hover:bg-emerald-50"><Phone className="h-4 w-4" /></a></Tooltip>}
      {data?.mobile && <Tooltip label="SMS"><a href={`sms:${data.mobile}`} aria-label="SMS" className="rounded-lg border border-slate-200 p-1.5 text-brand-600 hover:bg-brand-50"><MessageSquare className="h-4 w-4" /></a></Tooltip>}
      {data?.email && <Tooltip label="Email"><a href={`mailto:${data.email}`} aria-label="Email" className="rounded-lg border border-slate-200 p-1.5 text-amber-600 hover:bg-amber-50"><Mail className="h-4 w-4" /></a></Tooltip>}
    </div>
  );

  // ── ΚΛΕΙΣΤΗ προβολή: σύνοψη + «Επεξεργασία» ──
  if (collapsible && !editing) {
    const hasAny = !!(data?.mobile || data?.phone || data?.email);
    return (
      <PanelCard title={t("Στοιχεία επικοινωνίας", "Contact details")} action={
        <div className="flex flex-wrap items-center gap-1.5">
          {quickActions}
          {extraAction}
          {hdikaBtn}
          <button onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300">
            <Pencil className="h-3.5 w-3.5" /> {t("Επεξεργασία", "Edit")}
          </button>
        </div>
      }>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-slate-600 dark:text-slate-300">
          {avatar}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${data?.active === false ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
            {data?.active === false ? t("Ανενεργός", "Inactive") : t("Ενεργός", "Active")}
          </span>
          {statusBadge}
          {tel && <span className="inline-flex items-center gap-1.5"><Phone className="h-4 w-4 text-slate-400" />{tel}</span>}
          {data?.email && <span className="inline-flex items-center gap-1.5"><Mail className="h-4 w-4 text-slate-400" />{data.email}</span>}
          {data?.marketing_consent && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{t("Συγκατάθεση marketing", "Marketing consent")}</span>}
          {!hasAny && <span className="text-slate-400">{t("Χωρίς στοιχεία — «Επεξεργασία» ή «Άντληση ΗΔΥΚΑ».", "No details — Edit or Fetch ΗΔΥΚΑ.")}</span>}
        </div>
      </PanelCard>
    );
  }

  // ── ΑΝΟΙΧΤΗ προβολή: πλήρης φόρμα ── (Field = module-level, βλ. σχόλιο πάνω για το focus bug)

  return (
    <PanelCard title={t("Στοιχεία επικοινωνίας", "Contact details")} action={
      <div className="flex flex-wrap items-center gap-1.5">
        {quickActions}
        {extraAction}
        {hdikaBtn}
        {collapsible && (
          <Tooltip label={t("Κλείσιμο", "Close")}>
            <button onClick={() => { setEditing(false); if (data) setF({ ...empty, ...data }); }} aria-label={t("Κλείσιμο", "Close")}
              className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 dark:border-slate-700"><X className="h-4 w-4" /></button>
          </Tooltip>
        )}
      </div>
    }>
      <div className="-mt-1 mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          {avatar}
          <p className="text-xs text-slate-400">{t("Καταχωρείς εσύ", "You enter it")} — <b>{t("δεν επηρεάζονται", "not affected")}</b> {t("από συγχρονισμό ΗΔΥΚΑ.", "by ΗΔΥΚΑ sync.")}</p>
        </div>
        {statusBadge}
      </div>
      {st?.needs_confirmation && st?.source === "idyka" && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          {t("Τα στοιχεία προέρχονται μόνο από τη ΗΔΥΚΑ (παγωμένα από την εγγραφή). Επιβεβαίωσέ τα με τον πελάτη και πάτησε «Αποθήκευση».", "Details come only from ΗΔΥΚΑ (frozen at registration). Confirm them with the patient and click Save.")}
        </p>
      )}

      {/* lifecycle — pharmacist-controlled, survives ΗΔΥΚΑ re-ingest */}
      <div className={`mb-3 rounded-lg border p-3 ${f.active === false ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40" : "border-slate-200 dark:border-slate-700"}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{t("Κατάσταση πελάτη", "Patient status")}</span>
          <span className="inline-flex items-center gap-1">
            <button type="button" onClick={() => set("active", true)} className={`rounded-lg px-3 py-1 text-xs font-semibold ${f.active !== false ? "bg-emerald-100 text-emerald-700" : "text-slate-400 hover:bg-slate-100"}`}>{t("Ενεργός", "Active")}</button>
            <button type="button" onClick={() => set("active", false)} className={`rounded-lg px-3 py-1 text-xs font-semibold ${f.active === false ? "bg-rose-100 text-rose-700" : "text-slate-400 hover:bg-slate-100"}`}>{t("Ανενεργός", "Inactive")}</button>
          </span>
        </div>
        {f.active === false && (
          <div className="mt-2">
            <select value={f.inactive_reason || "stopped"} onChange={(e) => set("inactive_reason", e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
              <option value="deceased">{t("Αποβίωσε", "Deceased")}</option>
              <option value="moved">{t("Μετακόμισε", "Moved away")}</option>
              <option value="stopped">{t("Σταμάτησε να ψωνίζει", "Stopped purchasing")}</option>
              <option value="other">{t("Άλλο", "Other")}</option>
            </select>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t("Εξαιρείται από recall, win-back & καμπάνιες.", "Excluded from recall, win-back & campaigns.")}</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("Κινητό", "Mobile")} k="mobile" type="tel" ph="69········" f={f} set={set} />
        <Field label={t("Σταθερό", "Landline")} k="phone" type="tel" f={f} set={set} />
        <Field label="Email" k="email" type="email" ph="name@example.gr" f={f} set={set} />
        <label className="text-sm">
          <span className="mb-1 block text-xs text-slate-500">{t("Προτιμώμενο κανάλι", "Preferred channel")}</span>
          <select value={f.preferred_channel || "mobile"} onChange={(e) => set("preferred_channel", e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
            <option value="mobile">{t("SMS (κινητό)", "SMS (mobile)")}</option>
            <option value="email">Email</option>
            <option value="phone">{t("Τηλέφωνο", "Phone")}</option>
          </select>
        </label>
        <Field label={t("Διεύθυνση", "Address")} k="address" f={f} set={set} />
        <div className="grid grid-cols-3 gap-3">
          <Field label={t("Πόλη", "City")} k="city" f={f} set={set} />
          <Field label={t("Τ.Κ.", "Postal code")} k="postal_code" f={f} set={set} />
          <Field label={t("Ύψος (cm)", "Height (cm)")} k="height_cm" type="number" ph="175" f={f} set={set} />
        </div>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-xs text-slate-500">{t("Σημειώσεις", "Notes")}</span>
          <textarea value={f.notes || ""} onChange={(e) => set("notes", e.target.value)} rows={2}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={!!f.marketing_consent} onChange={(e) => set("marketing_consent", e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
          {t("Συγκατάθεση για ενημερώσεις (newsletter/SMS)", "Consent for updates (newsletter/SMS)")}
        </label>
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {save.isSuccess ? t("Αποθηκεύτηκε", "Saved") : t("Αποθήκευση", "Save")}
        </button>
      </div>
    </PanelCard>
  );
}
