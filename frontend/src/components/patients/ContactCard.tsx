"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone, Mail, MessageSquare, Save, Loader2, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";

type Contact = {
  phone?: string | null; mobile?: string | null; email?: string | null;
  address?: string | null; city?: string | null; postal_code?: string | null;
  notes?: string | null; marketing_consent?: boolean; preferred_channel?: string | null;
  updated_at?: string | null;
};

const empty: Contact = { marketing_consent: false, preferred_channel: "mobile" };

export function ContactCard({ patientId }: { patientId: string }) {
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
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none" />
    </label>
  );

  const tel = f.mobile || f.phone;
  return (
    <PanelCard title="Στοιχεία επικοινωνίας" action={
      <div className="flex gap-1.5">
        {tel && <a href={`tel:${tel}`} title="Κλήση" className="rounded-lg border border-slate-200 p-1.5 text-emerald-600 hover:bg-emerald-50"><Phone className="h-4 w-4" /></a>}
        {f.mobile && <a href={`sms:${f.mobile}`} title="SMS" className="rounded-lg border border-slate-200 p-1.5 text-brand-600 hover:bg-brand-50"><MessageSquare className="h-4 w-4" /></a>}
        {f.email && <a href={`mailto:${f.email}`} title="Email" className="rounded-lg border border-slate-200 p-1.5 text-amber-600 hover:bg-amber-50"><Mail className="h-4 w-4" /></a>}
      </div>
    }>
      <p className="-mt-1 mb-3 text-xs text-slate-400">Καταχωρείς εσύ — <b>δεν επηρεάζονται</b> από συγχρονισμό ΗΔΙΚΑ.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Κινητό" k="mobile" type="tel" ph="69········" />
        <Field label="Σταθερό" k="phone" type="tel" />
        <Field label="Email" k="email" type="email" ph="name@example.gr" />
        <label className="text-sm">
          <span className="mb-1 block text-xs text-slate-500">Προτιμώμενο κανάλι</span>
          <select value={f.preferred_channel || "mobile"} onChange={(e) => set("preferred_channel", e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none">
            <option value="mobile">SMS (κινητό)</option>
            <option value="email">Email</option>
            <option value="phone">Τηλέφωνο</option>
          </select>
        </label>
        <Field label="Διεύθυνση" k="address" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Πόλη" k="city" />
          <Field label="Τ.Κ." k="postal_code" />
        </div>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-xs text-slate-500">Σημειώσεις</span>
          <textarea value={f.notes || ""} onChange={(e) => set("notes", e.target.value)} rows={2}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none" />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={!!f.marketing_consent} onChange={(e) => set("marketing_consent", e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
          Συγκατάθεση για ενημερώσεις (newsletter/SMS)
        </label>
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {save.isSuccess ? "Αποθηκεύτηκε" : "Αποθήκευση"}
        </button>
      </div>
    </PanelCard>
  );
}
