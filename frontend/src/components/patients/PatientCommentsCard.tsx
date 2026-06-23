"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { MessageSquare, Send, Trash2, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";

type Note = { id: string; text: string; by: string | null; at: string | null };

/** «Σχόλια» — log χρονολογημένων σχολίων φαρμακοποιού για τον πελάτη. Κάθε σχόλιο κρατιέται
 *  στο ιστορικό (δεν αντικαθίσταται), με ημερομηνία· διαγραφή ανά σχόλιο. Keyed by ΑΜΚΑ. */
export function PatientCommentsCard({ amka }: { amka: string }) {
  const t = useT();
  const q = useQuery({
    queryKey: ["patient-notes", amka],
    queryFn: () => api<{ items: Note[] }>(`/patient-intelligence/profile/notes?amka=${encodeURIComponent(amka)}`),
    enabled: !!amka,
  });
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api("/patient-intelligence/profile/notes", { method: "POST", body: JSON.stringify({ amka, text: text.trim() }) }),
    onSuccess: () => { setText(""); q.refetch(); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/patient-intelligence/profile/notes/${id}`, { method: "DELETE" }),
    onSuccess: () => q.refetch(),
  });
  const items = q.data?.items ?? [];

  return (
    <PanelCard title={t("Σχόλια", "Comments")}>
      <p className="-mt-1 mb-2 text-xs text-slate-400">{t("Χρονολογημένα σχόλια φαρμακοποιού — μένουν στο ιστορικό, δεν αντικαθίστανται.", "Dated pharmacist comments — kept in history, never overwritten.")}</p>
      <div className="flex items-start gap-2">
        <MessageSquare className="mt-2 h-4 w-4 shrink-0 text-brand-500" />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) add.mutate(); }}
          placeholder={t("Γράψε σχόλιο… (Ctrl+Enter για προσθήκη)", "Write a comment… (Ctrl+Enter to add)")}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
      </div>
      <div className="mt-2 flex justify-end">
        <button onClick={() => text.trim() && add.mutate()} disabled={add.isPending || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Προσθήκη", "Add")}
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {!q.isLoading && items.length === 0 && <div className="text-sm text-slate-400">{t("Κανένα σχόλιο ακόμη.", "No comments yet.")}</div>}
        {items.map((n) => (
          <div key={n.id} className="group rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/50">
            <div className="flex items-start justify-between gap-2">
              <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{n.text}</p>
              <button onClick={() => del.mutate(n.id)} className="text-slate-300 opacity-0 transition hover:text-rose-500 group-hover:opacity-100" title={t("Διαγραφή", "Delete")}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">{n.at ? new Date(n.at).toLocaleString("el-GR") : ""}</div>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}
