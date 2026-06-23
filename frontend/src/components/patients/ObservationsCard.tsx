"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { StickyNote, Save, Loader2, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";

// Πλήρες contact doc — το κρατάμε ώστε το PUT να μη «σβήνει» τα άλλα πεδία (το endpoint κάνει set όλα τα γνωστά).
type Contact = Record<string, unknown> & { observations?: string | null };

/** «Παρατηρήσεις» — ελεύθερο κείμενο φαρμακοποιού για τον πελάτη (pharmacist-controlled,
 *  δεν επηρεάζεται από συγχρονισμό ΗΔΥΚΑ). Μοιράζεται το ίδιο query/endpoint με την ContactCard. */
export function ObservationsCard({ patientId }: { patientId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["patient-contact", patientId],
    queryFn: () => api<Contact>(`/patients/${encodeURIComponent(patientId)}/contact`),
    retry: false,
  });
  const [f, setF] = useState<Contact>({});
  const [text, setText] = useState("");
  useEffect(() => { if (data) { setF(data); setText((data.observations as string) || ""); } }, [data]);

  const save = useMutation({
    mutationFn: () => api<Contact>(`/patients/${encodeURIComponent(patientId)}/contact`,
      { method: "PUT", body: JSON.stringify({ ...f, observations: text }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["patient-contact", patientId] }),
  });
  const dirty = text !== ((data?.observations as string) || "");

  return (
    <PanelCard title={t("Παρατηρήσεις", "Notes")}>
      <p className="-mt-1 mb-2 text-xs text-slate-400">{t("Ελεύθερο κείμενο φαρμακοποιού — δεν επηρεάζεται από συγχρονισμό ΗΔΥΚΑ.", "Free-text pharmacist notes — not affected by ΗΔΥΚΑ sync.")}</p>
      <div className="flex items-start gap-2">
        <StickyNote className="mt-2 h-4 w-4 shrink-0 text-amber-500" />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
          placeholder={t("π.χ. προτιμήσεις, αλλεργίες, οδηγίες εξυπηρέτησης, υπενθυμίσεις…", "e.g. preferences, allergies, service instructions, reminders…")}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
      </div>
      <div className="mt-2 flex justify-end">
        <button onClick={() => save.mutate()} disabled={save.isPending || !dirty}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess && !dirty ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {save.isSuccess && !dirty ? t("Αποθηκεύτηκε", "Saved") : t("Αποθήκευση", "Save")}
        </button>
      </div>
    </PanelCard>
  );
}
