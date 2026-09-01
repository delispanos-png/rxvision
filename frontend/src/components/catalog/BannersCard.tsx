"use client";

// Θεματικά banners προσφορών (slider «🔥 Προσφορές» της πύλης). Ο φαρμακοποιός φτιάχνει
// χειροκίνητα banners (εικόνα/τίτλος/στόχος)· επιπλέον, η πύλη παράγει ΚΑΙ αυτόματα banners
// από τις υπάρχουσες προσφορές. Κάθε banner είναι clickable → φιλτραρισμένη λίστα προϊόντων.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Images, Plus, Trash2, Pencil, X, ImagePlus, Loader2 } from "lucide-react";
import { api, apiUpload, API_BASE } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

export type OfferBanner = {
  _id?: string; title: string; subtitle?: string | null; badge?: string | null;
  image_id?: string | null; accent: string;
  target_type: "on_sale" | "brand" | "tag" | "bundles"; target_value?: string | null;
  sort_order: number; active: boolean;
};
const EMPTY: OfferBanner = { title: "", subtitle: "", badge: "", accent: "rose", target_type: "on_sale", target_value: "", sort_order: 0, active: true };
const imgSrc = (o: OfferBanner) => o.image_id ? `${API_BASE}/catalog/image/${o.image_id}` : "";
const ACCENTS: [string, string][] = [["rose", "bg-gradient-to-r from-rose-500 to-orange-500"], ["violet", "bg-gradient-to-r from-violet-500 to-indigo-500"], ["amber", "bg-gradient-to-r from-amber-500 to-yellow-500"], ["emerald", "bg-gradient-to-r from-emerald-500 to-teal-500"], ["sky", "bg-gradient-to-r from-sky-500 to-cyan-500"]];
const accentCls = (a: string) => ACCENTS.find(([k]) => k === a)?.[1] ?? ACCENTS[0][1];

export function BannersCard() {
  const t = useT();
  const qc = useQueryClient();
  const key = ["catalog", "offer-banners"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ items: OfferBanner[] }>("/catalog/offer-banners") });
  const [edit, setEdit] = useState<OfferBanner | null>(null);
  const [uploading, setUploading] = useState(false);

  const save = useMutation({
    mutationFn: (o: OfferBanner) => api("/catalog/offer-banners", { method: "POST", body: JSON.stringify({ ...o, id: o._id ?? null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setEdit(null); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/catalog/offer-banners/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const items = data?.items ?? [];

  async function pickImage(file: File) {
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await apiUpload<{ ok: boolean; image_id?: string }>("/catalog/image", fd);
      if (r.ok && r.image_id) setEdit((s) => s ? { ...s, image_id: r.image_id } : s);
    } finally { setUploading(false); }
  }

  const targetLabel = (o: OfferBanner) => o.target_type === "brand" ? t(`Μάρκα: ${o.target_value}`, `Brand: ${o.target_value}`)
    : o.target_type === "tag" ? t(`Ετικέτα: ${o.target_value}`, `Tag: ${o.target_value}`)
    : o.target_type === "bundles" ? t("Πακέτα", "Bundles") : t("Όλα σε προσφορά", "All on sale");
  const needsValue = edit?.target_type === "brand" || edit?.target_type === "tag";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-slate-800"><Images className="h-4 w-4 text-rose-500" /> {t("Banners προσφορών", "Offer banners")}</div>
        <button onClick={() => setEdit({ ...EMPTY })} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
          <Plus className="h-3.5 w-3.5" /> {t("Νέο", "New")}
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">{t("Θεματικά banners («−50%», «1+1», «Καλοκαίρι»…) στο slider «Προσφορές» της πύλης. Κάθε banner είναι ", "Themed banners («−50%», «1+1», «Summer»…) in the portal «Offers» slider. Each banner is ")}<b>{t("clickable", "clickable")}</b>{t(" και οδηγεί σε φιλτραρισμένη λίστα προϊόντων. Επιπλέον, η πύλη δείχνει ΚΑΙ ", " and opens a filtered product list. The portal also shows ")}<b>{t("αυτόματα banners", "auto banners")}</b>{t(" από τις τρέχουσες προσφορές.", " from your current offers.")}</p>

      {items.length === 0 && <p className="py-4 text-center text-sm text-slate-400">{t("Κανένα χειροκίνητο banner (η πύλη δείχνει αυτόματα από τις προσφορές σου).", "No manual banners yet (the portal shows auto ones from your offers).")}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((o) => (
          <div key={o._id} className={`overflow-hidden rounded-xl border ${o.active ? "border-slate-200" : "border-slate-200 opacity-60"}`}>
            <div className={`relative flex items-center gap-2 px-3 py-2.5 text-white ${o.image_id ? "" : accentCls(o.accent)}`}>
              {o.image_id && <img src={imgSrc(o)} alt="" className="absolute inset-0 h-full w-full object-cover" />}
              <div className="relative z-10 min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {o.badge && <span className="rounded bg-white/25 px-1.5 py-0.5 text-[10px] font-extrabold">{o.badge}</span>}
                  <span className="truncate text-sm font-extrabold drop-shadow">{o.title}</span>
                </div>
                {o.subtitle && <div className="truncate text-[11px] opacity-90 drop-shadow">{o.subtitle}</div>}
              </div>
              <div className="relative z-10 flex shrink-0 gap-1">
                <button onClick={() => setEdit(o)} className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-slate-600 hover:bg-white"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => o._id && del.mutate(o._id)} className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-rose-500 hover:bg-white"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
              <span>→ {targetLabel(o)}</span>
              {!o.active && <span className="rounded-full bg-slate-200 px-2 py-0.5 font-semibold text-slate-600">{t("Ανενεργό", "Off")}</span>}
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEdit(null)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold text-slate-800">{edit._id ? t("Επεξεργασία banner", "Edit banner") : t("Νέο banner", "New banner")}</div>
              <button onClick={() => setEdit(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>
            {/* Ζωντανή προεπισκόπηση */}
            <div className={`relative mb-3 flex items-center gap-2 overflow-hidden rounded-xl px-4 py-3 text-white ${edit.image_id ? "" : accentCls(edit.accent)}`}>
              {edit.image_id && <img src={imgSrc(edit)} alt="" className="absolute inset-0 h-full w-full object-cover" />}
              <div className="relative z-10">
                <div className="flex items-center gap-1.5">{edit.badge && <span className="rounded bg-white/25 px-1.5 py-0.5 text-[10px] font-extrabold">{edit.badge}</span>}<span className="text-sm font-extrabold drop-shadow">{edit.title || t("Τίτλος", "Title")}</span></div>
                {edit.subtitle && <div className="text-[11px] opacity-90 drop-shadow">{edit.subtitle}</div>}
              </div>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <label className="col-span-2 block text-xs text-slate-500">{t("Τίτλος", "Title")}
                  <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder={t("π.χ. Καλοκαιρινές προσφορές", "e.g. Summer deals")} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                <label className="block text-xs text-slate-500">{t("Σήμα", "Badge")}
                  <input value={edit.badge ?? ""} onChange={(e) => setEdit({ ...edit, badge: e.target.value })} placeholder="-50%" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
              </div>
              <label className="block text-xs text-slate-500">{t("Υπότιτλος (προαιρετικό)", "Subtitle (optional)")}
                <input value={edit.subtitle ?? ""} onChange={(e) => setEdit({ ...edit, subtitle: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
              <div className="flex items-center gap-4">
                {imgSrc(edit) && <img src={imgSrc(edit)} alt="" className="h-14 w-24 rounded-lg object-cover" />}
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />} {t("Εικόνα (προαιρετικό)", "Image (optional)")}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && pickImage(e.target.files[0])} /></label>
                {imgSrc(edit) && <button onClick={() => setEdit({ ...edit, image_id: null })} className="text-[11px] text-rose-500 hover:underline">{t("Αφαίρεση", "Remove")}</button>}
              </div>
              {!edit.image_id && (
                <label className="block text-xs text-slate-500">{t("Χρώμα", "Colour")}
                  <div className="mt-1 flex gap-2">{ACCENTS.map(([k, cls]) => <button key={k} type="button" onClick={() => setEdit({ ...edit, accent: k })} className={`h-8 w-8 rounded-lg ${cls} ${edit.accent === k ? "ring-2 ring-slate-800 ring-offset-1" : ""}`} />)}</div></label>
              )}
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-slate-500">{t("Οδηγεί σε", "Opens")}
                  <select value={edit.target_type} onChange={(e) => setEdit({ ...edit, target_type: e.target.value as OfferBanner["target_type"], target_value: "" })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                    <option value="on_sale">{t("Όλα τα προϊόντα σε προσφορά", "All products on sale")}</option>
                    <option value="bundles">{t("Πακέτα (1+1 κ.λπ.)", "Bundles (1+1 etc.)")}</option>
                    <option value="brand">{t("Συγκεκριμένη μάρκα", "A specific brand")}</option>
                    <option value="tag">{t("Συγκεκριμένη ετικέτα", "A specific tag")}</option>
                  </select></label>
                {needsValue && (
                  <label className="block text-xs text-slate-500">{edit.target_type === "brand" ? t("Μάρκα", "Brand") : t("Ετικέτα", "Tag")}
                    <input value={edit.target_value ?? ""} onChange={(e) => setEdit({ ...edit, target_value: e.target.value })} placeholder={edit.target_type === "brand" ? "π.χ. BETADINE" : t("π.χ. Νέο", "e.g. New")} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="block text-xs text-slate-500">{t("Σειρά", "Order")}
                  <input type="number" value={edit.sort_order} onChange={(e) => setEdit({ ...edit, sort_order: +e.target.value })} className="mt-1 w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> {t("Ενεργό", "Active")}</label>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">{t("Άκυρο", "Cancel")}</button>
              <button onClick={() => edit.title.trim().length >= 2 && (!needsValue || (edit.target_value ?? "").trim()) && save.mutate(edit)} disabled={save.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{save.isPending ? t("Αποθήκευση…", "Saving…") : t("Αποθήκευση", "Save")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
