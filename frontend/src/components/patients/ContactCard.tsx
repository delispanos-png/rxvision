"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone, Mail, MessageSquare, Save, Loader2, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";
import { Tooltip } from "@/components/ui/Tooltip";

type Contact = {
  phone?: string | null; mobile?: string | null; email?: string | null;
  address?: string | null; city?: string | null; postal_code?: string | null;
  notes?: string | null; marketing_consent?: boolean; preferred_channel?: string | null;
  active?: boolean; inactive_reason?: string | null;
  updated_at?: string | null;
};

const empty: Contact = { marketing_consent: false, preferred_channel: "mobile", active: true };

export function ContactCard({ patientId }: { patientId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["patient-contact", patientId],
    queryFn: () => api<Contact>(`/patients/${encodeURIComponent(patientId)}/contact`),
    retry: false,
  });
  const [f, setF] = useState<Contact>(empty);
  useEffect(() => { if (data) setF({ ...empty, ...data }); }, [data]);
  const set = (k: keyof Contact, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: () => api<Contact>(`/patients/${encodeURIComponent(patientId)}/contact`, { method: "PUT", body: JSON.stringify(f) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["patient-contact", patientId] }),
  });

  const Field = ({ label, k, type = "text", ph }: { label: string; k: keyof Contact; type?: string; ph?: string }) => (
    <label className="text-sm">
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      <input type={type} value={(f[k] as string) || ""} onChange={(e) => set(k, e.target.value)} placeholder={ph}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
    </label>
  );

  const tel = f.mobile || f.phone;
  return (
    <PanelCard title={t("Στοιχεία επικοινωνίας", "Contact details")} action={
      <div className="flex gap-1.5">
        {tel && <Tooltip label={t("Κλήση", "Call")}><a href={`tel:${tel}`} aria-label={t("Κλήση", "Call")} className="rounded-lg border border-slate-200 p-1.5 text-emerald-600 hover:bg-emerald-50"><Phone className="h-4 w-4" /></a></Tooltip>}
        {f.mobile && <Tooltip label="SMS"><a href={`sms:${f.mobile}`} aria-label="SMS" className="rounded-lg border border-slate-200 p-1.5 text-brand-600 hover:bg-brand-50"><MessageSquare className="h-4 w-4" /></a></Tooltip>}
        {f.email && <Tooltip label="Email"><a href={`mailto:${f.email}`} aria-label="Email" className="rounded-lg border border-slate-200 p-1.5 text-amber-600 hover:bg-amber-50"><Mail className="h-4 w-4" /></a></Tooltip>}
      </div>
    }>
      <p className="-mt-1 mb-3 text-xs text-slate-400">{t("Καταχωρείς εσύ", "You enter it")} — <b>{t("δεν επηρεάζονται", "not affected")}</b> {t("από συγχρονισμό ΗΔΥΚΑ.", "by ΗΔΥΚΑ sync.")}</p>

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
        <Field label={t("Κινητό", "Mobile")} k="mobile" type="tel" ph="69········" />
        <Field label={t("Σταθερό", "Landline")} k="phone" type="tel" />
        <Field label="Email" k="email" type="email" ph="name@example.gr" />
        <label className="text-sm">
          <span className="mb-1 block text-xs text-slate-500">{t("Προτιμώμενο κανάλι", "Preferred channel")}</span>
          <select value={f.preferred_channel || "mobile"} onChange={(e) => set("preferred_channel", e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
            <option value="mobile">{t("SMS (κινητό)", "SMS (mobile)")}</option>
            <option value="email">Email</option>
            <option value="phone">{t("Τηλέφωνο", "Phone")}</option>
          </select>
        </label>
        <Field label={t("Διεύθυνση", "Address")} k="address" />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Πόλη", "City")} k="city" />
          <Field label={t("Τ.Κ.", "Postal code")} k="postal_code" />
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
