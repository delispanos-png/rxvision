"use client";

// Shopify-style ΑΥΤΟΜΑΤΕΣ προσφορές καλαθιού: έκπτωση σε ΟΛΗ την παραγγελία + δωρεάν μεταφορικά.
// Κανόνες (ελάχιστο ποσό/ποσότητα, όρια χρήσης), προγραμματισμός (ημ/νίες) & κατάσταση.
// ΚΑΝΟΝΑΣ: η order-έκπτωση εφαρμόζεται ΜΟΝΟ στα μη-συνταγογραφούμενα (server-side).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Truck, Plus, Trash2, Pencil, X } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { DateInput } from "@/components/ui/DateInput";

type OD = {
  _id?: string; name: string; discount_type: "order" | "free_shipping"; value_type: "pct" | "fixed";
  value: number; min_cents: number; min_qty: number; usage_limit: number; used_count?: number;
  active: boolean; starts_at?: string | null; ends_at?: string | null; status?: string;
};
const EMPTY: OD = { name: "", discount_type: "order", value_type: "pct", value: 10, min_cents: 0, min_qty: 0, usage_limit: 0, active: true };
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const statusMap = (t: (a: string, b: string) => string): Record<string, [string, string]> => ({
  active: [t("Ενεργή", "Active"), "bg-emerald-100 text-emerald-700"],
  scheduled: [t("Προγραμματισμένη", "Scheduled"), "bg-sky-100 text-sky-700"],
  expired: [t("Έληξε", "Expired"), "bg-slate-200 text-slate-500"],
  used_up: [t("Εξαντλήθηκε", "Used up"), "bg-amber-100 text-amber-800"],
  inactive: [t("Ανενεργή", "Off"), "bg-slate-200 text-slate-500"],
});
const toDay = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");

export function OrderDiscountsCard() {
  const t = useT();
  const STATUS = statusMap(t);
  const qc = useQueryClient();
  const key = ["catalog", "order-discounts"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ items: OD[] }>("/catalog/order-discounts") });
  const [edit, setEdit] = useState<OD | null>(null);
  const save = useMutation({
    mutationFn: (c: OD) => api("/catalog/order-discounts", { method: "POST", body: JSON.stringify({ ...c, id: c._id ?? null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setEdit(null); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/catalog/order-discounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const items = data?.items ?? [];
  const summary = (c: OD) => {
    const rules: string[] = [];
    if (c.min_cents) rules.push(t(`ελάχ. ${eur(c.min_cents)}`, `min. ${eur(c.min_cents)}`));
    if (c.min_qty) rules.push(t(`≥${c.min_qty} τεμ.`, `≥${c.min_qty} pcs`));
    if (c.usage_limit) rules.push(t(`${c.used_count ?? 0}/${c.usage_limit} χρήσεις`, `${c.used_count ?? 0}/${c.usage_limit} uses`));
    return rules.join(" · ");
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-slate-800"><ShoppingCart className="h-4 w-4 text-indigo-500" /> {t("Προσφορές καλαθιού (αυτόματες)", "Cart offers (automatic)")}</div>
        <button onClick={() => setEdit({ ...EMPTY })} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"><Plus className="h-3.5 w-3.5" /> {t("Νέα", "New")}</button>
      </div>
      <p className="mb-3 text-xs text-slate-500">{t("Έκπτωση σε ", "Discount on the ")}<b>{t("όλο το καλάθι", "whole cart")}</b>{t(" ή ", " or ")}<b>{t("δωρεάν μεταφορικά", "free shipping")}</b>{t(", χωρίς κωδικό (αυτόματα στο ταμείο). ", ", no code (applied automatically at checkout). ")}<b>{t("Τα συνταγογραφούμενα εξαιρούνται πάντα", "Prescription items are always excluded")}</b>{t(" από την έκπτωση καλαθιού.", " from the cart discount.")}</p>

      {items.length === 0 && <p className="py-4 text-center text-sm text-slate-400">{t("Καμία προσφορά καλαθιού ακόμη.", "No cart offers yet.")}</p>}
      <div className="space-y-2">
        {items.map((c) => {
          const [lbl, cls] = STATUS[c.status || "inactive"] || STATUS.inactive;
          return (
            <div key={c._id} className={`flex items-start justify-between gap-3 rounded-xl border p-3 ${c.status === "active" ? "border-indigo-200 bg-indigo-50/40" : "border-slate-200 bg-slate-50"}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {c.discount_type === "free_shipping" ? <Truck className="h-4 w-4 text-emerald-600" /> : <ShoppingCart className="h-4 w-4 text-indigo-600" />}
                  <span className="font-semibold text-slate-800">{c.name}</span>
                  {c.discount_type === "order"
                    ? <span className="rounded-md bg-indigo-600 px-1.5 py-0.5 text-[11px] font-bold text-white">{c.value_type === "pct" ? `−${c.value}%` : `−${eur(c.value)}`}</span>
                    : <span className="rounded-md bg-emerald-600 px-1.5 py-0.5 text-[11px] font-bold text-white">{t("Δωρεάν μεταφορικά", "Free shipping")}</span>}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{lbl}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">{summary(c) || t("χωρίς όρους", "no conditions")}{(c.starts_at || c.ends_at) && <span> · {toDay(c.starts_at) || "…"} → {toDay(c.ends_at) || "…"}</span>}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => setEdit(c)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => c._id && del.mutate(c._id)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-rose-500 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          );
        })}
      </div>

      {edit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setEdit(null)}>
          <div className="max-h-[88vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold text-slate-800">{edit._id ? t("Επεξεργασία προσφοράς", "Edit offer") : t("Νέα προσφορά καλαθιού", "New cart offer")}</div>
              <button onClick={() => setEdit(null)} className="text-slate-400"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              <label className="block text-sm"><span className="mb-1 block text-slate-600">{t("Όνομα", "Name")}</span>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={t("π.χ. −10% σε όλο το καλάθι", "e.g. −10% on the whole cart")} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <label><span className="mb-1 block text-slate-600">{t("Τύπος", "Type")}</span>
                  <select value={edit.discount_type} onChange={(e) => setEdit({ ...edit, discount_type: e.target.value as OD["discount_type"] })} className="w-full rounded-lg border border-slate-300 px-3 py-2">
                    <option value="order">{t("Έκπτωση σε όλη την παραγγελία", "Discount on the whole order")}</option>
                    <option value="free_shipping">{t("Δωρεάν μεταφορικά", "Free shipping")}</option>
                  </select></label>
                {edit.discount_type === "order" && (
                  <label><span className="mb-1 block text-slate-600">{t("Μέθοδος", "Method")}</span>
                    <select value={edit.value_type} onChange={(e) => setEdit({ ...edit, value_type: e.target.value as OD["value_type"] })} className="w-full rounded-lg border border-slate-300 px-3 py-2">
                      <option value="pct">{t("Ποσοστό %", "Percent %")}</option>
                      <option value="fixed">{t("Σταθερό €", "Fixed €")}</option>
                    </select></label>
                )}
              </div>

              {edit.discount_type === "order" && (
                <label className="block text-sm"><span className="mb-1 block text-slate-600">{edit.value_type === "pct" ? t("Έκπτωση %", "Discount %") : t("Έκπτωση (€)", "Discount (€)")}</span>
                  {edit.value_type === "pct"
                    ? <input type="range" min={1} max={90} value={edit.value} onChange={(e) => setEdit({ ...edit, value: +e.target.value })} className="w-full accent-indigo-600" />
                    : <input type="number" step="0.01" value={edit.value / 100} onChange={(e) => setEdit({ ...edit, value: Math.round(+e.target.value * 100) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" />}
                  {edit.value_type === "pct" && <div className="mt-1 text-center text-sm font-bold text-indigo-700">−{edit.value}%</div>}
                </label>
              )}

              <div className="grid grid-cols-2 gap-2 text-sm">
                <label><span className="mb-1 block text-slate-600">{t("Ελάχιστο καλάθι (€)", "Minimum cart (€)")}</span>
                  <input type="number" step="0.01" value={edit.min_cents / 100} onChange={(e) => setEdit({ ...edit, min_cents: Math.round(+e.target.value * 100) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                <label><span className="mb-1 block text-slate-600">{t("Ελάχιστα τεμάχια", "Minimum units")}</span>
                  <input type="number" value={edit.min_qty} onChange={(e) => setEdit({ ...edit, min_qty: Math.max(0, +e.target.value) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <label><span className="mb-1 block text-slate-600">{t("Έναρξη", "Start")}</span><DateInput value={toDay(edit.starts_at)} onChange={(d) => setEdit({ ...edit, starts_at: d ? `${d}T00:00:00` : null })} /></label>
                <label><span className="mb-1 block text-slate-600">{t("Λήξη", "End")}</span><DateInput value={toDay(edit.ends_at)} onChange={(d) => setEdit({ ...edit, ends_at: d ? `${d}T23:59:59` : null })} /></label>
              </div>

              <label className="block text-sm"><span className="mb-1 block text-slate-600">{t("Όριο χρήσεων (0 = απεριόριστο)", "Usage limit (0 = unlimited)")}</span>
                <input type="number" value={edit.usage_limit} onChange={(e) => setEdit({ ...edit, usage_limit: Math.max(0, +e.target.value) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>

              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} className="h-4 w-4" /><span className="text-slate-700">{t("Ενεργή", "Active")}</span></label>

              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setEdit(null)} className="px-3 py-2 text-sm text-slate-400">{t("Άκυρο", "Cancel")}</button>
                <button onClick={() => save.mutate(edit)} disabled={!edit.name.trim() || save.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{t("Αποθήκευση", "Save")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
