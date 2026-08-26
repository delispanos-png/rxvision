"use client";

// Εκπτωτικές καμπάνιες e-shop — έκπτωση σε ΟΜΑΔΑ ειδών (κατηγορίες ή/και ετικέτες).
// ΚΑΝΟΝΑΣ: τα ΣΥΝΤΑΓΟΓΡΑΦΟΥΜΕΝΑ εξαιρούνται ΠΑΝΤΑ — ακόμη κι αν ανήκουν στην κατηγορία της
// καμπάνιας. Επιβάλλεται server-side στη μηχανή τιμολόγησης (δεν εξαρτάται από αυτό το UI).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tag, Plus, Trash2, Pencil, X, Search, Layers, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useCategoryTree } from "@/components/catalog/CategoryPicker";
import { DateInput } from "@/components/ui/DateInput";
const toDay = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");

export type Campaign = {
  _id?: string; name: string; discount_pct: number; categories: string[]; tags: string[];
  cat_ids?: string[]; barcodes?: string[];
  active: boolean; starts_at?: string | null; ends_at?: string | null;
};
const EMPTY: Campaign = { name: "", discount_pct: 10, categories: [], tags: [], cat_ids: [], barcodes: [], active: true };

export function CampaignsCard({ categories, tags }: { categories: string[]; tags: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const key = ["catalog", "campaigns"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ items: Campaign[] }>("/catalog/campaigns") });
  const [edit, setEdit] = useState<Campaign | null>(null);
  // Στόχευση σε κόμβους δέντρου κατηγοριών (π.χ. «Αντιγήρανση») + συγκεκριμένα είδη (αναζήτηση).
  const { data: catTree } = useCategoryTree();
  const cats = catTree?.items ?? [];
  const catById = new Map(cats.map((c) => [c.id, c]));
  const catLabel = (id: string) => { const parts: string[] = []; let cur = catById.get(id); let guard = 0; while (cur && guard++ < 5) { parts.unshift(cur.name); cur = cur.parent_id ? catById.get(cur.parent_id) : undefined; } return parts.join(" › ") || id; };
  const [prodQ, setProdQ] = useState("");
  const [pickNames, setPickNames] = useState<Record<string, string>>({});
  const prodSearch = useQuery({
    queryKey: ["camp-prod-search", prodQ],
    queryFn: () => api<{ items: { barcode: string; name: string }[] }>(`/catalog?q=${encodeURIComponent(prodQ.trim())}&for_sale=true&page_size=8`),
    enabled: prodQ.trim().length >= 2, retry: false,
  });

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
        <div className="flex items-center gap-2 font-semibold text-slate-800"><Tag className="h-4 w-4 text-rose-500" /> {t("Εκπτωτικές καμπάνιες", "Discount campaigns")}</div>
        <button onClick={() => setEdit({ ...EMPTY })} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
          <Plus className="h-3.5 w-3.5" /> {t("Νέα", "New")}
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">{t("Έκπτωση σε ομάδα ειδών (π.χ. «Περιποίηση προσώπου −20%»). ", "Discount on a group of items (e.g. «Facial care −20%»). ")}<b>{t("Τα συνταγογραφούμενα εξαιρούνται πάντα", "Prescription items are always excluded")}</b>{t(", ακόμη κι αν ανήκουν στην κατηγορία.", ", even if they belong to the category.")}</p>

      {items.length === 0 && <p className="py-4 text-center text-sm text-slate-400">{t("Καμία καμπάνια ακόμη.", "No campaigns yet.")}</p>}
      <div className="space-y-2">
        {items.map((c) => (
          <div key={c._id} className={`flex items-start justify-between gap-3 rounded-xl border p-3 ${c.active ? "border-rose-200 bg-rose-50/50" : "border-slate-200 bg-slate-50"}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-800">{c.name}</span>
                <span className="rounded-md bg-rose-600 px-1.5 py-0.5 text-[11px] font-bold text-white">−{c.discount_pct}%</span>
                {!c.active && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{t("Ανενεργή", "Off")}</span>}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {(c.categories.length + c.tags.length + (c.cat_ids?.length ?? 0) + (c.barcodes?.length ?? 0)) === 0
                  ? t("Όλο το κατάστημα (εκτός συνταγογραφούμενων)", "Whole store (except prescription items)")
                  : [...(c.cat_ids ?? []).map((id) => `🗂️ ${catLabel(id)}`), ...c.categories, ...c.tags.map((tg) => `#${tg}`), ...((c.barcodes?.length ?? 0) ? [t(`🎯 ${c.barcodes!.length} είδη`, `🎯 ${c.barcodes!.length} items`)] : [])].join(" · ")}
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
              <div className="font-semibold text-slate-800">{edit._id ? t("Επεξεργασία καμπάνιας", "Edit campaign") : t("Νέα καμπάνια", "New campaign")}</div>
              <button onClick={() => setEdit(null)} className="text-slate-400"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">{t("Όνομα", "Name")}</span>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={t("π.χ. Περιποίηση προσώπου", "e.g. Facial care")} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">{t("Έκπτωση:", "Discount:")} <b>{edit.discount_pct}%</b></span>
                <input type="range" min={1} max={90} value={edit.discount_pct} onChange={(e) => setEdit({ ...edit, discount_pct: +e.target.value })} className="w-full accent-rose-600" />
              </label>
              <div className="text-sm">
                <span className="mb-1 block text-slate-600">{t("Κατηγορίες", "Categories")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((c) => (
                    <button key={c} onClick={() => setEdit({ ...edit, categories: toggle(edit.categories, c) })}
                      className={`rounded-lg border px-2 py-1 text-xs ${edit.categories.includes(c) ? "border-rose-500 bg-rose-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>{c}</button>
                  ))}
                </div>
              </div>
              {tags.length > 0 && (
                <div className="text-sm">
                  <span className="mb-1 block text-slate-600">{t("Ετικέτες", "Labels")}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tg) => (
                      <button key={tg} onClick={() => setEdit({ ...edit, tags: toggle(edit.tags, tg) })}
                        className={`rounded-lg border px-2 py-1 text-xs ${edit.tags.includes(tg) ? "border-rose-500 bg-rose-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>#{tg}</button>
                    ))}
                  </div>
                </div>
              )}
              {cats.length > 0 && (
                <div className="text-sm">
                  <span className="mb-1 flex items-center gap-1 text-slate-600"><Layers className="h-3.5 w-3.5" /> {t("Κατηγορίες e-shop (δέντρο)", "e-shop categories (tree)")}</span>
                  <div className="max-h-40 space-y-0.5 overflow-auto rounded-lg border border-slate-200 p-2">
                    {cats.map((c) => {
                      const on = (edit.cat_ids ?? []).includes(c.id);
                      return (
                        <button key={c.id} onClick={() => setEdit({ ...edit, cat_ids: toggle(edit.cat_ids ?? [], c.id) })}
                          style={{ paddingLeft: `${(c.level - 1) * 14 + 8}px` }}
                          className={`block w-full rounded-md py-1 pr-2 text-left text-xs ${on ? "bg-rose-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                          {c.level === 1 ? "📂 " : c.level === 2 ? "› " : "» "}{c.name}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{t("Διαλέγοντας μια κατηγορία, η έκπτωση ισχύει σε ", "By picking a category, the discount applies to ")}<b>{t("όλα τα είδη του κλαδιού", "all items in its branch")}</b>{t(" της (π.χ. «Αντιγήρανση»).", " (e.g. «Anti-ageing»).")}</p>
                </div>
              )}
              <div className="text-sm">
                <span className="mb-1 flex items-center gap-1 text-slate-600"><Search className="h-3.5 w-3.5" /> {t("Συγκεκριμένα είδη (στόχευση)", "Specific items (targeting)")}</span>
                {!!edit.barcodes?.length && (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {edit.barcodes.map((bc) => (
                      <span key={bc} className="inline-flex items-center gap-1 rounded-lg bg-rose-100 px-2 py-1 text-xs text-rose-700">
                        {pickNames[bc] || bc}
                        <button onClick={() => setEdit({ ...edit, barcodes: (edit.barcodes ?? []).filter((x) => x !== bc) })}><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="relative">
                  <input value={prodQ} onChange={(e) => setProdQ(e.target.value)} placeholder={t("Αναζήτηση είδους (όνομα/barcode)…", "Search item (name/barcode)…")} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  {prodQ.trim().length >= 2 && (prodSearch.data?.items?.length ?? 0) > 0 && (
                    <div className="absolute z-10 mt-1 max-h-44 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                      {prodSearch.data!.items.map((p) => {
                        const on = (edit.barcodes ?? []).includes(p.barcode);
                        return (
                          <button key={p.barcode} onClick={() => { setPickNames((m) => ({ ...m, [p.barcode]: p.name })); setEdit({ ...edit, barcodes: on ? (edit.barcodes ?? []).filter((x) => x !== p.barcode) : [...(edit.barcodes ?? []), p.barcode] }); }}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50 ${on ? "bg-rose-50" : ""}`}>
                            <span className="min-w-0 truncate">{p.name}<span className="text-slate-400"> · {p.barcode}</span></span>
                            {on ? <Check className="h-3.5 w-3.5 shrink-0 text-rose-600" /> : <Plus className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              {edit.categories.length === 0 && edit.tags.length === 0 && (edit.cat_ids?.length ?? 0) === 0 && (edit.barcodes?.length ?? 0) === 0 && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{t("Χωρίς επιλογή → η έκπτωση ισχύει σε ", "No selection → the discount applies to the ")}<b>{t("όλο το κατάστημα", "whole store")}</b>{t(" (πάντα εκτός συνταγογραφούμενων).", " (always except prescription items).")}</p>
              )}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <label><span className="mb-1 block text-slate-600">{t("Έναρξη (προαιρετικά)", "Start (optional)")}</span><DateInput value={toDay(edit.starts_at)} onChange={(d) => setEdit({ ...edit, starts_at: d ? `${d}T00:00:00` : null })} /></label>
                <label><span className="mb-1 block text-slate-600">{t("Λήξη (προαιρετικά)", "End (optional)")}</span><DateInput value={toDay(edit.ends_at)} onChange={(d) => setEdit({ ...edit, ends_at: d ? `${d}T23:59:59` : null })} /></label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} className="h-4 w-4" />
                <span className="text-slate-700">{t("Ενεργή", "Active")}</span>
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setEdit(null)} className="px-3 py-2 text-sm text-slate-400">{t("Άκυρο", "Cancel")}</button>
                <button onClick={() => save.mutate(edit)} disabled={!edit.name.trim() || save.isPending}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{t("Αποθήκευση", "Save")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
