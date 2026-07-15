"use client";

// Εκπτωτικές καμπάνιες e-shop — έκπτωση σε ΟΜΑΔΑ ειδών (κατηγορίες ή/και ετικέτες).
// ΚΑΝΟΝΑΣ: τα ΣΥΝΤΑΓΟΓΡΑΦΟΥΜΕΝΑ εξαιρούνται ΠΑΝΤΑ — ακόμη κι αν ανήκουν στην κατηγορία της
// καμπάνιας. Επιβάλλεται server-side στη μηχανή τιμολόγησης (δεν εξαρτάται από αυτό το UI).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tag, Plus, Trash2, Pencil, X } from "lucide-react";
import { api } from "@/lib/apiClient";

export type Campaign = {
  _id?: string; name: string; discount_pct: number; categories: string[]; tags: string[];
  active: boolean; starts_at?: string | null; ends_at?: string | null;
};
const EMPTY: Campaign = { name: "", discount_pct: 10, categories: [], tags: [], active: true };

export function CampaignsCard({ categories, tags }: { categories: string[]; tags: string[] }) {
  const qc = useQueryClient();
  const key = ["catalog", "campaigns"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ items: Campaign[] }>("/catalog/campaigns") });
  const [edit, setEdit] = useState<Campaign | null>(null);

  const save = useMutation({
    mutationFn: (c: Campaign) => api("/catalog/campaigns", { method: "POST", body: JSON.stringify({ ...c, id: c._id ?? null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setEdit(null); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/catalog/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const items = data?.items ?? [];
  const toggle = (list: string[], v: string) => list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-slate-800"><Tag className="h-4 w-4 text-rose-500" /> Εκπτωτικές καμπάνιες</div>
        <button onClick={() => setEdit({ ...EMPTY })} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
          <Plus className="h-3.5 w-3.5" /> Νέα
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">Έκπτωση σε ομάδα ειδών (π.χ. «Περιποίηση προσώπου −20%»). <b>Τα συνταγογραφούμενα εξαιρούνται πάντα</b>, ακόμη κι αν ανήκουν στην κατηγορία.</p>

      {items.length === 0 && <p className="py-4 text-center text-sm text-slate-400">Καμία καμπάνια ακόμη.</p>}
      <div className="space-y-2">
        {items.map((c) => (
          <div key={c._id} className={`flex items-start justify-between gap-3 rounded-xl border p-3 ${c.active ? "border-rose-200 bg-rose-50/50" : "border-slate-200 bg-slate-50"}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-800">{c.name}</span>
                <span className="rounded-md bg-rose-600 px-1.5 py-0.5 text-[11px] font-bold text-white">−{c.discount_pct}%</span>
                {!c.active && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Ανενεργή</span>}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {c.categories.length === 0 && c.tags.length === 0
                  ? "Όλο το κατάστημα (εκτός συνταγογραφούμενων)"
                  : [...c.categories, ...c.tags.map((t) => `#${t}`)].join(" · ")}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button onClick={() => setEdit(c)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" /></button>
              <button onClick={() => c._id && del.mutate(c._id)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-rose-500 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setEdit(null)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold text-slate-800">{edit._id ? "Επεξεργασία καμπάνιας" : "Νέα καμπάνια"}</div>
              <button onClick={() => setEdit(null)} className="text-slate-400"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">Όνομα</span>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="π.χ. Περιποίηση προσώπου" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">Έκπτωση: <b>{edit.discount_pct}%</b></span>
                <input type="range" min={1} max={90} value={edit.discount_pct} onChange={(e) => setEdit({ ...edit, discount_pct: +e.target.value })} className="w-full accent-rose-600" />
              </label>
              <div className="text-sm">
                <span className="mb-1 block text-slate-600">Κατηγορίες</span>
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((c) => (
                    <button key={c} onClick={() => setEdit({ ...edit, categories: toggle(edit.categories, c) })}
                      className={`rounded-lg border px-2 py-1 text-xs ${edit.categories.includes(c) ? "border-rose-500 bg-rose-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>{c}</button>
                  ))}
                </div>
              </div>
              {tags.length > 0 && (
                <div className="text-sm">
                  <span className="mb-1 block text-slate-600">Ετικέτες</span>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((t) => (
                      <button key={t} onClick={() => setEdit({ ...edit, tags: toggle(edit.tags, t) })}
                        className={`rounded-lg border px-2 py-1 text-xs ${edit.tags.includes(t) ? "border-rose-500 bg-rose-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>#{t}</button>
                    ))}
                  </div>
                </div>
              )}
              {edit.categories.length === 0 && edit.tags.length === 0 && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Χωρίς επιλογή → η έκπτωση ισχύει σε <b>όλο το κατάστημα</b> (πάντα εκτός συνταγογραφούμενων).</p>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} className="h-4 w-4" />
                <span className="text-slate-700">Ενεργή</span>
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setEdit(null)} className="px-3 py-2 text-sm text-slate-400">Άκυρο</button>
                <button onClick={() => save.mutate(edit)} disabled={!edit.name.trim() || save.isPending}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">Αποθήκευση</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
