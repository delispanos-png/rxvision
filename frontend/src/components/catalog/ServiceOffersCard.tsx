"use client";

// Προσφορές ΥΠΗΡΕΣΙΩΝ φαρμακείου (π.χ. «−30% σπιρομέτρηση», «δωρεάν μέτρηση πίεσης»).
// Δεν είναι προϊόντα καταλόγου — δεν μπαίνουν στο καλάθι. Ο πελάτης τις «κλείνει» ως ραντεβού
// από το κύκλωμα «Προσφορές» στο my.rxvision.gr.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Plus, Trash2, Pencil, X, ImagePlus, Loader2 } from "lucide-react";
import { api, apiUpload, API_BASE } from "@/lib/apiClient";

export type ServiceOffer = {
  _id?: string; title: string; description?: string | null; photo_url?: string | null;
  image_id?: string | null; is_free: boolean; price_cents: number; compare_cents: number;
  cta: "reserve" | "info"; active: boolean; starts_at?: string | null; ends_at?: string | null;
};
const EMPTY: ServiceOffer = { title: "", description: "", is_free: false, price_cents: 0, compare_cents: 0, cta: "reserve", active: true };
const eur = (c?: number) => ((c || 0) / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const imgSrc = (o: ServiceOffer) => o.image_id ? `${API_BASE}/catalog/image/${o.image_id}` : (o.photo_url || "");

export function ServiceOffersCard() {
  const qc = useQueryClient();
  const key = ["catalog", "service-offers"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ items: ServiceOffer[] }>("/catalog/service-offers") });
  const [edit, setEdit] = useState<ServiceOffer | null>(null);
  const [uploading, setUploading] = useState(false);

  const save = useMutation({
    mutationFn: (o: ServiceOffer) => api("/catalog/service-offers", { method: "POST", body: JSON.stringify({ ...o, id: o._id ?? null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setEdit(null); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/catalog/service-offers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const items = data?.items ?? [];

  async function pickImage(file: File) {
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await apiUpload<{ ok: boolean; image_id?: string }>("/catalog/image", fd);
      if (r.ok && r.image_id) setEdit((s) => s ? { ...s, image_id: r.image_id, photo_url: null } : s);
    } finally { setUploading(false); }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-slate-800"><Sparkles className="h-4 w-4 text-fuchsia-500" /> Προσφορές υπηρεσιών</div>
        <button onClick={() => setEdit({ ...EMPTY })} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
          <Plus className="h-3.5 w-3.5" /> Νέα
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">Προσφορές σε <b>υπηρεσίες</b> (μέτρηση πίεσης, σπιρομέτρηση, φαρμακευτική συμβουλή…). Ο πελάτης τις βλέπει στις «Προσφορές» της πύλης και <b>κλείνει ραντεβού</b> — δεν μπαίνουν στο καλάθι.</p>

      {items.length === 0 && <p className="py-4 text-center text-sm text-slate-400">Καμία προσφορά υπηρεσίας ακόμη.</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((o) => (
          <div key={o._id} className={`flex items-start gap-3 rounded-xl border p-3 ${o.active ? "border-fuchsia-200 bg-fuchsia-50/40" : "border-slate-200 bg-slate-50"}`}>
            {imgSrc(o) ? <img src={imgSrc(o)} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" /> : <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-fuchsia-100 text-fuchsia-500"><Sparkles className="h-5 w-5" /></span>}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold text-slate-800">{o.title}</span>
                {!o.active && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Ανενεργή</span>}
              </div>
              <div className="mt-0.5 text-sm">
                {o.is_free ? <span className="font-bold text-emerald-600">Δωρεάν</span> : (
                  <><span className="font-bold text-slate-800">{eur(o.price_cents)}</span>{o.compare_cents > 0 && <span className="ml-1.5 text-xs text-slate-400 line-through">{eur(o.compare_cents)}</span>}</>
                )}
                <span className="ml-2 text-[11px] text-slate-400">{o.cta === "reserve" ? "· κράτηση ραντεβού" : "· ενημερωτική"}</span>
              </div>
              {o.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{o.description}</p>}
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <button onClick={() => setEdit(o)} className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" /></button>
              <button onClick={() => o._id && del.mutate(o._id)} className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-rose-500 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEdit(null)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold text-slate-800">{edit._id ? "Επεξεργασία προσφοράς" : "Νέα προσφορά υπηρεσίας"}</div>
              <button onClick={() => setEdit(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-3">
              <label className="block text-xs text-slate-500">Τίτλος
                <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="π.χ. Σπιρομέτρηση −30%" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
              <label className="block text-xs text-slate-500">Περιγραφή (προαιρετικό)
                <textarea value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
              <div className="flex items-center gap-4">
                {imgSrc(edit) && <img src={imgSrc(edit)} alt="" className="h-16 w-16 rounded-lg object-cover" />}
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />} Εικόνα
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && pickImage(e.target.files[0])} /></label>
                {imgSrc(edit) && <button onClick={() => setEdit({ ...edit, image_id: null, photo_url: null })} className="text-[11px] text-rose-500 hover:underline">Αφαίρεση</button>}
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_free} onChange={(e) => setEdit({ ...edit, is_free: e.target.checked })} /> Δωρεάν υπηρεσία</label>
              {!edit.is_free && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-slate-500">Τιμή τώρα (€)
                    <input type="number" step="0.01" value={edit.price_cents / 100} onChange={(e) => setEdit({ ...edit, price_cents: Math.round(+e.target.value * 100) })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                  <label className="text-xs text-slate-500">Τιμή πριν (€, προαιρετικό)
                    <input type="number" step="0.01" value={edit.compare_cents / 100} onChange={(e) => setEdit({ ...edit, compare_cents: Math.round(+e.target.value * 100) })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <label className="text-xs text-slate-500">Ενέργεια πελάτη
                  <select value={edit.cta} onChange={(e) => setEdit({ ...edit, cta: e.target.value as "reserve" | "info" })} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm">
                    <option value="reserve">Κράτηση ραντεβού</option>
                    <option value="info">Μόνο προβολή (ρώτα στο φαρμακείο)</option>
                  </select></label>
                <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Ενεργή</label>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Άκυρο</button>
              <button onClick={() => edit.title.trim().length >= 2 && save.mutate(edit)} disabled={save.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{save.isPending ? "Αποθήκευση…" : "Αποθήκευση"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
