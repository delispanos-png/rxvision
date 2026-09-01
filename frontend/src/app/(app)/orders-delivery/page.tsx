"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Truck, Package, MapPin, Phone, Check, Loader2, Clock, X, Trash2, Plus, ImagePlus, Eye, MessageSquare, StickyNote, Send, Search } from "lucide-react";
import { api, apiUpload, API_BASE } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DateInput } from "@/components/ui/DateInput";
import { useT } from "@/store/prefStore";

type T = (el: string, en: string) => string;

type Item = { barcode: string; name: string; qty: number; line_cents: number; discount_pct: number; type: string; backorder?: boolean };
type Msg = { text: string; at: string; from?: string };
type Order = {
  _id: string; patient_name: string; patient_phone: string; items: Item[];
  subtotal_cents: number; delivery_fee_cents: number; total_cents: number; mode: string;
  address?: { street?: string; area?: string; postal?: string; phone?: string; notes?: string } | null;
  courier_auth?: { name?: string; id_number?: string } | null;
  has_medicine: boolean; has_backorder?: boolean; available_date?: string | null; status: string; created_at: string;
  available_from?: string | null; available_to?: string | null; payment_method?: string | null;
  note?: string | null; internal_note?: string | null; customer_message?: string | null; messages?: Msg[];
};
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const oidOf = (o: Order) => (o._id || "").slice(-6).toUpperCase();
const dmy = (s?: string | null) => { if (!s) return ""; const p = s.split("T")[0].split("-"); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s; };
const availWindow = (o: Order) => o.available_date ? `${dmy(o.available_date)}${o.available_from && o.available_to ? `, ${o.available_from}–${o.available_to}` : ""}` : "";
const payLabelOf = (t: T, o: Order) => o.payment_method === "online" ? t("Online (κάρτα/IRIS)", "Online (card/IRIS)") : o.payment_method === "cod" ? t("Με την παράδοση", "On delivery") : t("Στο κατάστημα", "In store");
const TIMES = Array.from({ length: 27 }, (_, i) => { const m = 8 * 60 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });
const stMap = (t: T): Record<string, { label: string; cls: string }> => ({
  pending: { label: t("Σε αναμονή έγκρισης", "Awaiting approval"), cls: "bg-amber-100 text-amber-800" },
  new: { label: t("Νέα", "New"), cls: "bg-rose-100 text-rose-700" },
  preparing: { label: t("Σε ετοιμασία", "Preparing"), cls: "bg-amber-100 text-amber-700" },
  ready: { label: t("Έτοιμη", "Ready"), cls: "bg-sky-100 text-sky-700" },
  shipped: { label: t("Καθ' οδόν", "In transit"), cls: "bg-violet-100 text-violet-700" },
  delivered: { label: t("Παραδόθηκε", "Delivered"), cls: "bg-emerald-100 text-emerald-700" },
  declined: { label: t("Απορρίφθηκε", "Declined"), cls: "bg-slate-200 text-slate-500" },
  cancelled: { label: t("Ακυρώθηκε", "Cancelled"), cls: "bg-slate-200 text-slate-500" },
});
const DONE_ST = ["delivered", "cancelled", "declined"];
const nextMap = (t: T): Record<string, { to: string; label: string }[]> => ({
  new: [{ to: "preparing", label: t("Ετοιμασία", "Prepare") }, { to: "cancelled", label: t("Ακύρωση", "Cancel") }],
  preparing: [{ to: "ready", label: t("Έτοιμη (παραλαβή)", "Ready (pickup)") }, { to: "shipped", label: t("Απεστάλη (αποστολή)", "Shipped (delivery)") }],
  ready: [{ to: "delivered", label: t("Παραδόθηκε", "Delivered") }],
  shipped: [{ to: "delivered", label: t("Παραδόθηκε", "Delivered") }],
});

export default function OrdersDeliveryPage() {
  return <ModuleGuard module="order_delivery"><Orders /></ModuleGuard>;
}

function Orders() {
  const t = useT();
  const ST = stMap(t);
  const NEXT = nextMap(t);
  const [tab, setTab] = useState<"orders" | "done" | "settings">("orders");
  // Η καρτέλα οδηγείται ΚΑΙ από το URL hash → κάθε tab = αυτόνομο entry στο μενού «eShop».
  useEffect(() => {
    const read = () => { const h = window.location.hash.slice(1); if (h === "orders" || h === "done" || h === "settings") setTab(h); };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const list = useQuery({ queryKey: ["od-orders"], queryFn: () => api<{ items: Order[] }>("/orders/delivery"), refetchInterval: 20000, retry: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>({});
  const [times, setTimes] = useState<Record<string, { from: string; to: string }>>({});
  const [openOrder, setOpenOrder] = useState<Order | null>(null);   // πλήρης προβολή (5.5/6.2)
  const [quickBc, setQuickBc] = useState<string | null>(null);      // γρήγορη προβολή προϊόντος (5.4)
  // Φίλτρα ολοκληρωμένων (6.1)
  const [fq, setFq] = useState({ text: "", status: "", pay: "", mode: "", from: "", to: "" });
  async function advance(id: string, status: string) {
    setBusy(id);
    try { await api(`/orders/delivery/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }); await list.refetch(); }
    finally { setBusy(null); }
  }
  async function respond(id: string, accept: boolean) {
    setBusy(id);
    const tm = times[id];
    try { await api(`/orders/delivery/${id}/backorder`, { method: "POST", body: JSON.stringify({ accept, available_date: dates[id] || null, available_from: tm?.from || null, available_to: tm?.to || null }) }); await list.refetch(); }
    finally { setBusy(null); }
  }
  const orders = (list.data?.items ?? []).filter((o) => !DONE_ST.includes(o.status));
  const doneAll = (list.data?.items ?? []).filter((o) => DONE_ST.includes(o.status));
  const done = doneAll.filter((o) => {
    if (fq.text) { const q = fq.text.toLowerCase(); if (!(o.patient_name || "").toLowerCase().includes(q) && !oidOf(o).toLowerCase().includes(q)) return false; }
    if (fq.status && o.status !== fq.status) return false;
    if (fq.pay && (o.payment_method || "store") !== fq.pay) return false;
    if (fq.mode && o.mode !== fq.mode) return false;
    const d = o.created_at?.split("T")[0] ?? "";
    if (fq.from && d < fq.from) return false;
    if (fq.to && d > fq.to) return false;
    return true;
  });
  // Ζωντανή ενημέρωση του ανοιχτού modal μετά από refetch (νέα σημείωση/μήνυμα)
  const openLive = openOrder ? (list.data?.items ?? []).find((o) => o._id === openOrder._id) ?? openOrder : null;

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-800"><Truck className="h-6 w-6 text-brand-600" /> {t("Παραγγελίες & Αποστολή", "Orders & Delivery")} <span className="text-slate-300">·</span> <span className="text-brand-700">{tab === "orders" ? t(`Ενεργές${orders.length ? ` (${orders.length})` : ""}`, `Active${orders.length ? ` (${orders.length})` : ""}`) : tab === "done" ? t(`Ολοκληρωμένες${done.length ? ` (${done.length})` : ""}`, `Completed${done.length ? ` (${done.length})` : ""}`) : t("Ρυθμίσεις αποστολής", "Delivery settings")}</span></div>
      <p className="mb-4 text-sm text-slate-500">{t("Επίλεξε ενότητα από το μενού «eShop» αριστερά.", "Pick a section from the «eShop» menu on the left.")}</p>

      {tab === "settings" && <SettingsTab />}
      {tab === "orders" && (
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {list.isLoading && <div className="py-8 text-center text-sm text-slate-400 xl:col-span-2">{t("Φόρτωση…", "Loading…")}</div>}
          {!list.isLoading && orders.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400 xl:col-span-2">{t("Καμία ενεργή παραγγελία.", "No active orders.")}</div>}
          {orders.map((o) => (
            <div key={o._id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    {o.mode === "delivery" ? <Truck className="h-4 w-4 text-violet-500" /> : <Package className="h-4 w-4 text-sky-500" />}
                    {o.patient_name || t("Πελάτης", "Customer")} <span className={`rounded-full px-2 py-0.5 text-[11px] ${ST[o.status]?.cls}`}>{ST[o.status]?.label}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400"><span className="font-mono font-semibold text-slate-500">#{oidOf(o)}</span><span>· {new Date(o.created_at).toLocaleString("el-GR")}</span><span>· {o.mode === "delivery" ? t("Αποστολή", "Delivery") : t("Παραλαβή", "Pickup")}</span><span>· 💳 {payLabelOf(t, o)}</span></div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className="text-base font-bold text-slate-800">{eur(o.total_cents)}</div>
                  {o.delivery_fee_cents > 0 && <div className="text-[11px] text-slate-400">(+{eur(o.delivery_fee_cents)} {t("μεταφορικά", "delivery")})</div>}
                  <button onClick={() => setOpenOrder(o)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"><Eye className="h-3.5 w-3.5" /> {t("Προβολή", "View")}</button>
                </div>
              </div>
              <div className="mt-2 space-y-0.5 text-sm text-slate-600">
                {o.items.map((it, i) => <div key={i} className="flex justify-between gap-2"><button onClick={() => setQuickBc(it.barcode)} className="min-w-0 truncate text-left hover:text-brand-700 hover:underline">{it.qty}× {it.name}{it.discount_pct > 0 && <span className="ml-1 text-emerald-600">-{it.discount_pct}%</span>}{it.backorder && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-700">{t("κατόπιν παραγγελίας", "backorder")}</span>}</button><span className="shrink-0">{eur(it.line_cents)}</span></div>)}
              </div>
              {o.note && <div className="mt-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600 dark:bg-slate-800"><b>{t("Σημείωση πελάτη:", "Customer note:")}</b> {o.note}</div>}
              {o.mode === "delivery" && o.address && (
                <div className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
                  <div className="flex items-center gap-1 font-medium"><MapPin className="h-3.5 w-3.5" /> {o.address.street}, {o.address.area} {o.address.postal}</div>
                  {o.address.phone && <div className="mt-0.5 flex items-center gap-1"><Phone className="h-3 w-3" /> {o.address.phone}</div>}
                  {o.address.notes && <div className="mt-0.5 italic">«{o.address.notes}»</div>}
                </div>
              )}
              {o.mode === "delivery" && o.courier_auth?.name && (
                <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <div className="font-semibold">{t("Εξουσιοδότηση παραλαβής", "Pickup authorization")}</div>
                  <div className="mt-0.5">{o.courier_auth.name} · {t("Ταυτ./Διαβατ.", "ID/Passport")}: <b>{o.courier_auth.id_number}</b></div>
                </div>
              )}
              {o.status === "pending" ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-800"><Clock className="h-3.5 w-3.5" /> {t("Κατόπιν παραγγελίας — αποδέξου (με ημερομηνία διαθεσιμότητας) ή απόρριψε.", "Backorder — accept (with an availability date) or decline.")}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500">{t("Διαθέσιμο:", "Available:")}</span>
                    <DateInput value={dates[o._id] ?? ""} onChange={(v) => setDates((d) => ({ ...d, [o._id]: v }))} />
                    <span className="text-xs text-slate-400">{t("από", "from")}</span>
                    <select value={times[o._id]?.from ?? ""} onChange={(e) => setTimes((s) => ({ ...s, [o._id]: { from: e.target.value, to: s[o._id]?.to ?? "" } }))} className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800"><option value="">—</option>{TIMES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}</select>
                    <span className="text-xs text-slate-400">{t("έως", "to")}</span>
                    <select value={times[o._id]?.to ?? ""} onChange={(e) => setTimes((s) => ({ ...s, [o._id]: { from: s[o._id]?.from ?? "", to: e.target.value } }))} className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800"><option value="">—</option>{TIMES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}</select>
                    <button onClick={() => respond(o._id, true)} disabled={busy === o._id} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{busy === o._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {t("Αποδοχή", "Accept")}</button>
                    <button onClick={() => respond(o._id, false)} disabled={busy === o._id} className="inline-flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50"><X className="h-3.5 w-3.5" /> {t("Απόρριψη", "Decline")}</button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {o.available_date && <span className="rounded-lg bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">📦 {t("Διαθέσιμο", "Available")} {availWindow(o)}</span>}
                  {(NEXT[o.status] ?? []).map((n) => (
                    <button key={n.to} onClick={() => advance(o._id, n.to)} disabled={busy === o._id}
                      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${n.to === "cancelled" ? "border border-rose-300 text-rose-600 hover:bg-rose-50" : "bg-brand-600 text-white hover:bg-brand-700"}`}>
                      {busy === o._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {n.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {tab === "done" && (
        <div className="space-y-3">
          {/* Φίλτρα (6.1): Order ID/πελάτης, κατάσταση, πληρωμή, αποστολή, ημερομηνία */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900">
            <div className="relative min-w-[160px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={fq.text} onChange={(e) => setFq({ ...fq, text: e.target.value })} placeholder={t("Order ID ή πελάτης…", "Order ID or customer…")} className="w-full rounded-lg border border-slate-300 py-1.5 pl-8 pr-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            </div>
            <select value={fq.status} onChange={(e) => setFq({ ...fq, status: e.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"><option value="">{t("Κατάσταση", "Status")}</option>{DONE_ST.map((s) => <option key={s} value={s}>{ST[s]?.label}</option>)}</select>
            <select value={fq.pay} onChange={(e) => setFq({ ...fq, pay: e.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"><option value="">{t("Πληρωμή", "Payment")}</option><option value="store">{t("Στο κατάστημα", "In store")}</option><option value="cod">{t("Με την παράδοση", "On delivery")}</option><option value="online">Online</option></select>
            <select value={fq.mode} onChange={(e) => setFq({ ...fq, mode: e.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"><option value="">{t("Παράδοση", "Delivery")}</option><option value="delivery">{t("Αποστολή", "Delivery")}</option><option value="pickup">{t("Παραλαβή", "Pickup")}</option></select>
            <DateInput value={fq.from} onChange={(v) => setFq({ ...fq, from: v })} />
            <span className="text-xs text-slate-400">→</span>
            <DateInput value={fq.to} onChange={(v) => setFq({ ...fq, to: v })} />
            {(fq.text || fq.status || fq.pay || fq.mode || fq.from || fq.to) && <button onClick={() => setFq({ text: "", status: "", pay: "", mode: "", from: "", to: "" })} className="rounded-lg px-2 py-1 text-xs font-medium text-slate-400 hover:text-slate-600">{t("Καθαρισμός", "Clear")}</button>}
          </div>
          <div className="grid items-start gap-2 xl:grid-cols-2">
            {doneAll.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400 xl:col-span-2">{t("Καμία ολοκληρωμένη παραγγελία ακόμη.", "No completed orders yet.")}</div>}
            {doneAll.length > 0 && done.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400 xl:col-span-2">{t("Καμία παραγγελία με αυτά τα φίλτρα.", "No orders match these filters.")}</div>}
            {done.map((o) => (
              <button key={o._id} onClick={() => setOpenOrder(o)} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-left text-sm text-slate-500 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800/60 dark:hover:bg-slate-800">
                <span className="min-w-0 truncate"><span className="font-mono font-semibold text-slate-600 dark:text-slate-300">#{oidOf(o)}</span> · {o.patient_name} · {o.items.length} {t("είδη", "items")} · {new Date(o.created_at).toLocaleDateString("el-GR")}</span>
                <span className="flex shrink-0 items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-[11px] ${ST[o.status]?.cls}`}>{ST[o.status]?.label}</span> {eur(o.total_cents)} <Eye className="h-4 w-4 text-slate-400" /></span>
              </button>
            ))}
          </div>
        </div>
      )}
      {openLive && <OrderModal order={openLive} t={t} ST={ST} onClose={() => setOpenOrder(null)} onChanged={() => list.refetch()} onQuick={(bc) => setQuickBc(bc)} />}
      {quickBc && <ProductQuick barcode={quickBc} t={t} onClose={() => setQuickBc(null)} />}
    </div>
  );
}

// ── Πλήρης προβολή παραγγελίας (5.5/6.2) + εσωτερική σημείωση (5.2) + μήνυμα πελάτη (5.3) + clickable προϊόντα (5.4) ──
function OrderModal({ order: o, t, ST, onClose, onChanged, onQuick }: { order: Order; t: T; ST: Record<string, { label: string; cls: string }>; onClose: () => void; onChanged: () => void; onQuick: (bc: string) => void }) {
  const [note, setNote] = useState(o.internal_note ?? "");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  async function saveNote() { setBusy(true); try { await api(`/orders/delivery/${o._id}/note`, { method: "POST", body: JSON.stringify({ note }) }); setSavedNote(true); onChanged(); } finally { setBusy(false); } }
  async function sendMsg() { if (!msg.trim()) return; setBusy(true); try { await api(`/orders/delivery/${o._id}/message`, { method: "POST", body: JSON.stringify({ text: msg.trim() }) }); setMsg(""); onChanged(); } finally { setBusy(false); } }
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-4 w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100"><Package className="h-5 w-5 text-brand-600" /> {t("Παραγγελία", "Order")} <span className="font-mono text-brand-700">#{oidOf(o)}</span> <span className={`rounded-full px-2 py-0.5 text-[11px] ${ST[o.status]?.cls}`}>{ST[o.status]?.label}</span></div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-700"><div className="text-[11px] font-semibold uppercase text-slate-400">{t("Πελάτης", "Customer")}</div><div className="font-medium text-slate-800 dark:text-slate-100">{o.patient_name || "—"}</div>{o.patient_phone && <div className="flex items-center gap-1 text-xs text-slate-500"><Phone className="h-3 w-3" /> {o.patient_phone}</div>}</div>
          <div className="space-y-0.5 rounded-lg border border-slate-200 p-2.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
            <div>{o.mode === "delivery" ? <><Truck className="inline h-3.5 w-3.5" /> {t("Αποστολή", "Delivery")}</> : <><Package className="inline h-3.5 w-3.5" /> {t("Παραλαβή", "Pickup")}</>}</div>
            <div>💳 {payLabelOf(t, o)}</div>
            <div>🗓️ {new Date(o.created_at).toLocaleString("el-GR")}</div>
            {o.available_date && <div className="font-semibold text-emerald-700">📦 {t("Διαθέσιμο", "Available")} {availWindow(o)}</div>}
          </div>
        </div>
        {o.mode === "delivery" && o.address && <div className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800 dark:bg-violet-950/30 dark:text-violet-200"><MapPin className="mr-1 inline h-3.5 w-3.5" />{o.address.street}, {o.address.area} {o.address.postal}{o.address.phone ? ` · ${o.address.phone}` : ""}{o.address.notes ? ` · «${o.address.notes}»` : ""}</div>}
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          {o.items.map((it, i) => (
            <button key={i} onClick={() => onQuick(it.barcode)} title={t("Δες προϊόν", "View product")} className="flex w-full items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800">
              <span className="min-w-0 truncate text-slate-700 hover:text-brand-700 dark:text-slate-200">{it.qty}× {it.name}{it.discount_pct > 0 && <span className="ml-1 text-emerald-600">-{it.discount_pct}%</span>}{it.backorder && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-700">{t("κατόπιν παραγγελίας", "backorder")}</span>}</span>
              <span className="shrink-0 font-medium">{eur(it.line_cents)}</span>
            </button>
          ))}
          <div className="flex justify-between border-t border-slate-100 px-3 py-2 text-sm font-bold text-slate-800 dark:border-slate-800 dark:text-slate-100"><span>{t("Σύνολο", "Total")}{o.delivery_fee_cents > 0 && <span className="ml-1 text-[11px] font-normal text-slate-400">(+{eur(o.delivery_fee_cents)} {t("μεταφορικά", "delivery")})</span>}</span><span>{eur(o.total_cents)}</span></div>
        </div>
        {o.note && <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800"><b>{t("Σημείωση πελάτη:", "Customer note:")}</b> {o.note}</div>}
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300"><StickyNote className="h-3.5 w-3.5 text-amber-500" /> {t("Εσωτερική σημείωση (δεν τη βλέπει ο πελάτης)", "Internal note (not shown to the customer)")}</div>
          <div className="flex gap-2"><textarea value={note} onChange={(e) => { setNote(e.target.value); setSavedNote(false); }} rows={2} className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /><button onClick={saveNote} disabled={busy} className="shrink-0 self-start rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">{savedNote ? t("✓", "✓") : t("Αποθήκευση", "Save")}</button></div>
        </div>
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300"><MessageSquare className="h-3.5 w-3.5 text-brand-500" /> {t("Μήνυμα προς τον πελάτη", "Message to the customer")}</div>
          {!!o.messages?.length && <div className="mb-1.5 space-y-1">{o.messages.map((m, i) => <div key={i} className="rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs text-brand-800 dark:bg-brand-950/30 dark:text-brand-200">{m.text} <span className="text-[10px] text-brand-400">· {new Date(m.at).toLocaleString("el-GR")}</span></div>)}</div>}
          <div className="flex gap-2"><input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendMsg(); }} placeholder={t("Γράψε μήνυμα… (ο πελάτης λαμβάνει ειδοποίηση)", "Write a message… (the customer gets a notification)")} className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /><button onClick={sendMsg} disabled={busy || !msg.trim()} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"><Send className="h-3.5 w-3.5" /> {t("Αποστολή", "Send")}</button></div>
        </div>
      </div>
    </div>
  );
}

type QP = { barcode: string; name: string; image_id?: string | null; photo_url?: string | null; price_cents: number; stock_qty: number; type: string; category?: string | null };
function ProductQuick({ barcode, t, onClose }: { barcode: string; t: T; onClose: () => void }) {
  const q = useQuery({ queryKey: ["od-quick", barcode], queryFn: () => api<{ items: QP[] }>(`/catalog/warehouse?q=${encodeURIComponent(barcode)}&page_size=1`), retry: false });
  const p = q.data?.items?.[0];
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between"><div className="text-sm font-bold text-slate-800 dark:text-slate-100">{t("Προϊόν", "Product")}</div><button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button></div>
        {q.isLoading ? <div className="py-6 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : !p ? <div className="py-6 text-center text-sm text-slate-400">{t("Δεν βρέθηκε στην αποθήκη.", "Not found in the warehouse.")}<div className="mt-1 font-mono text-xs">{barcode}</div></div> : (
          <div className="flex gap-3">
            <span className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-50 dark:bg-slate-800">{p.image_id || p.photo_url ? <img src={p.image_id ? `${API_BASE}/catalog/image/${p.image_id}` : (p.photo_url || "")} alt="" className="h-full w-full object-contain" /> : <Package className="h-7 w-7 text-slate-300" />}</span>
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold text-slate-800 dark:text-slate-100">{p.name}</div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400">{p.barcode}</div>
              {p.category && <div className="text-xs text-slate-500">{p.category}</div>}
              <div className="mt-1 flex items-center gap-2"><span className="font-bold text-slate-900 dark:text-slate-100">{eur(p.price_cents)}</span><span className={`text-xs ${p.stock_qty > 0 ? "text-emerald-600" : "text-amber-600"}`}>{t("Απόθεμα", "Stock")}: {p.stock_qty}</span></div>
              <a href={`/warehouse?q=${encodeURIComponent(p.barcode)}`} className="mt-2 inline-block text-xs font-semibold text-brand-700 hover:underline">{t("Άνοιγμα στην Αποθήκη →", "Open in Warehouse →")}</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type Tier = { min_cents: number; pct: number };
type Settings = Record<string, number | boolean | string | string[] | Tier[]>;

function SettingsTab() {
  const t = useT();
  const s = useQuery({ queryKey: ["od-settings"], queryFn: () => api<Settings>("/orders/delivery/settings"), retry: false });
  const [f, setF] = useState<Settings | null>(null);
  const cur = f ?? s.data;
  const [saved, setSaved] = useState(false);
  const [heroUp, setHeroUp] = useState(false);
  if (!cur) return <div className="py-8 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;
  const set = (k: string, v: number | boolean | string | string[] | Tier[]) => { setF({ ...cur, [k]: v }); setSaved(false); };
  const reducedAreas: string[] = Array.isArray(cur.reduced_vat_areas) ? (cur.reduced_vat_areas as string[]) : [];
  const tiers: Tier[] = Array.isArray(cur.cart_tiers) ? (cur.cart_tiers as Tier[]) : [];
  const setTier = (i: number, patch: Partial<Tier>) => set("cart_tiers", tiers.map((t, j) => j === i ? { ...t, ...patch } : t));
  async function save() { await api("/orders/delivery/settings", { method: "POST", body: JSON.stringify(cur) }); setSaved(true); }
  async function uploadHero(file: File) {
    setHeroUp(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await apiUpload<{ ok: boolean; image_id?: string }>("/catalog/image", fd);
      if (r.ok && r.image_id) set("hero_image_id", r.image_id);
    } finally { setHeroUp(false); }
  }
  const eurIn = (k: string) => (
    <input type="number" step="0.01" value={Number(cur[k] as number) / 100} onChange={(e) => set(k, Math.round(+e.target.value * 100))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
  );
  return (
    <div className="w-full space-y-4">
      {/* responsive masonry: 1 στήλη (mobile) → 2 (lg) → 3 (2xl)· κάθε ενότητα δεν σπάει μεταξύ στηλών */}
      <div className="gap-4 [column-fill:balance] sm:columns-1 lg:columns-2 2xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cur.delivery_enabled} onChange={(e) => set("delivery_enabled", e.target.checked)} /> {t("Αποστολή κατ’ οίκον", "Home delivery")}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cur.pickup_enabled} onChange={(e) => set("pickup_enabled", e.target.checked)} /> {t("Παραλαβή από το φαρμακείο", "Pickup at the pharmacy")}</label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-slate-500">{t("Μεταφορικά (€)", "Delivery fee (€)")}{eurIn("delivery_fee_cents")}</label>
        <label className="text-xs text-slate-500">{t("Δωρεάν αποστολή άνω (€)", "Free delivery over (€)")}{eurIn("free_over_cents")}</label>
        <label className="text-xs text-slate-500">{t("Ελάχιστη παραγγελία (€)", "Minimum order (€)")}{eurIn("min_order_cents")}</label>
      </div>
      <label className="block text-xs text-slate-500">{t("Αναφορά πιστοποίησης ΠΦΣ (e-φαρμακείο — εμφανίζεται με το λογότυπο ΕΕ)", "ΠΦΣ certification reference (e-pharmacy — shown with the EU logo)")}
        <input value={String(cur.pps_cert ?? "")} onChange={(e) => set("pps_cert", e.target.value)} placeholder={t("π.χ. αρ. μητρώου / σύνδεσμος", "e.g. registry no. / link")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
      <p className="text-[11px] text-slate-400">{t("Για online πώληση φαρμάκων (OTC) απαιτείται πιστοποίηση ΠΦΣ + το κοινό λογότυπο ΕΕ. Τα παραφάρμακα δεν το χρειάζονται.", "Online sale of OTC medicines requires ΠΦΣ certification + the common EU logo. Parapharmaceuticals don't need it.")}</p>
      </div>

      {/* Περιοχές μειωμένου ΦΠΑ (νησιά) — παράδοση εκεί → μειωμένος συντελεστής στα είδη */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <div className="text-sm font-semibold text-slate-700">🏝️ {t("Περιοχές μειωμένου ΦΠΑ", "Reduced-ΦΠΑ areas")}</div>
        <p className="text-[11px] text-slate-400">{t("Μία περιοχή ανά γραμμή. Παράδοση σε αυτές → μειωμένος συντελεστής (24→17, 13→9, 6→4) στις αποδείξεις/τιμολόγια.", "One area per line. Delivery to these → reduced rate (24→17, 13→9, 6→4) on receipts/invoices.")}</p>
        <textarea value={reducedAreas.join("\n")} onChange={(e) => set("reduced_vat_areas", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} rows={4} placeholder={t("π.χ.\nΛέρος\nΛέσβος\nΚως\nΣάμος\nΧίος", "e.g.\nLeros\nLesbos\nKos\nSamos\nChios")} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
      </div>

      <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-violet-900"><input type="checkbox" checked={!!cur.subscription_enabled} onChange={(e) => set("subscription_enabled", e.target.checked)} /> 🔁 {t("Επαναλαμβανόμενες παραγγελίες (συνδρομές)", "Recurring orders (subscriptions)")}</label>
        <p className="mt-1 text-[11px] text-violet-700">{t("Ο πελάτης μπορεί να ορίσει παραγγελία που επαναλαμβάνεται αυτόματα. Δώσε επιπλέον κίνητρο με μεγαλύτερη έκπτωση (μόνο σε παραφάρμακα — τα φάρμακα μένουν χωρίς έκπτωση).", "The customer can set an order that repeats automatically. Add an extra incentive with a bigger discount (parapharmaceuticals only — medicines stay without discount).")}</p>
        {!!cur.subscription_enabled && (
          <label className="mt-2 block text-xs text-slate-500">{t("Επιπλέον έκπτωση συνδρομής % (στα παραφάρμακα)", "Extra subscription discount % (on parapharmaceuticals)")}
            <input type="number" value={Number(cur.subscription_discount_pct ?? 0)} onChange={(e) => set("subscription_discount_pct", Math.max(0, Math.min(90, +e.target.value)))} className="mt-1 w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
        )}
      </div>

      {/* Κλιμακωτή έκπτωση καλαθιού — ΜΟΝΟ στα μη-συνταγογραφούμενα (επιβάλλεται server-side) */}
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
        <div className="text-sm font-semibold text-amber-900">📈 {t("Κλιμακωτή έκπτωση καλαθιού", "Tiered cart discount")}</div>
        <p className="mt-1 text-[11px] text-amber-800">{t("Όσο μεγαλώνει το καλάθι, μεγαλύτερη έκπτωση (π.χ. άνω των 30 € → −5%). Μετράει και ισχύει", "The bigger the cart, the bigger the discount (e.g. over €30 → −5%). It counts and applies to")} <b>{t("μόνο η αξία των μη-συνταγογραφούμενων", "the non-prescription value only")}</b>. {t("Αν ο πελάτης έχει και κουπόνι, εφαρμόζεται", "If the customer also has a coupon, we apply")} <b>{t("το καλύτερο από τα δύο", "the better of the two")}</b> — {t("όχι και τα δύο μαζί.", "not both together.")}</p>
        <div className="mt-2 space-y-1.5">
          {tiers.map((tier, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">{t("άνω των", "over")}</span>
              <input type="number" step="0.01" value={tier.min_cents / 100} onChange={(e) => setTier(i, { min_cents: Math.round(+e.target.value * 100) })} className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              <span className="text-xs text-slate-500">€ →</span>
              <input type="number" value={tier.pct} onChange={(e) => setTier(i, { pct: Math.max(1, Math.min(90, +e.target.value)) })} className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              <span className="text-xs text-slate-500">%</span>
              <button onClick={() => set("cart_tiers", tiers.filter((_, j) => j !== i))} className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
        {tiers.length < 6 && (
          <button onClick={() => set("cart_tiers", [...tiers, { min_cents: 3000, pct: 5 }])} className="mt-2 inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-800"><Plus className="h-3 w-3" /> {t("Κλίμακα", "Tier")}</button>
        )}
      </div>

      {/* Υπενθύμιση ξεχασμένου καλαθιού — opt-in (στέλνει push στον πελάτη) */}
      <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-sky-900">
          <input type="checkbox" checked={!!cur.abandoned_cart_enabled} onChange={(e) => set("abandoned_cart_enabled", e.target.checked)} /> 🛒 {t("Υπενθύμιση ξεχασμένου καλαθιού", "Abandoned-cart reminder")}
        </label>
        <p className="mt-1 text-[11px] text-sky-800">{t("Αν ο πελάτης αφήσει είδη στο καλάθι χωρίς να παραγγείλει, του στέλνουμε", "If the customer leaves items in the cart without ordering, we send them")} <b>{t("ένα", "one")}</b> push. {t("Σταματά αυτόματα μόλις παραγγείλει ή αδειάσει το καλάθι.", "It stops automatically once they order or empty the cart.")}</p>
        {!!cur.abandoned_cart_enabled && (
          <label className="mt-2 block text-xs text-slate-500">{t("Μετά από πόσες ώρες", "After how many hours")}
            <input type="number" min={1} max={72} value={Number(cur.abandoned_cart_hours ?? 6)} onChange={(e) => set("abandoned_cart_hours", Math.max(1, Math.min(72, +e.target.value)))} className="mt-1 w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
        )}
      </div>

      {/* Hero banner — merchandising στην αρχική του e-shop (πύλη πελατών) */}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-indigo-900">
          <input type="checkbox" checked={!!cur.hero_enabled} onChange={(e) => set("hero_enabled", e.target.checked)} /> 🖼️ {t("Banner προβολής (hero)", "Showcase banner (hero)")}
        </label>
        <p className="mt-1 text-[11px] text-indigo-700">{t("Μεγάλη εικόνα στην κορυφή του e-Καταστήματος (πύλη). Με το κλικ ο πελάτης πάει στις «Προσφορές».", "A large image at the top of the e-Shop (portal). Clicking it takes the customer to «Offers».")}</p>
        {!!cur.hero_enabled && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-3">
              <div className="grid h-16 w-28 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {cur.hero_image_id ? <img src={`${API_BASE}/catalog/image/${String(cur.hero_image_id)}`} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6 text-slate-300" />}
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                  {heroUp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} {t("Εικόνα banner", "Banner image")}
                  <input type="file" accept="image/*" hidden onChange={(e) => { const fl = e.target.files?.[0]; if (fl) uploadHero(fl); }} /></label>
                {cur.hero_image_id ? <button onClick={() => set("hero_image_id", "")} className="text-left text-[11px] text-rose-500 hover:underline">{t("Αφαίρεση", "Remove")}</button> : null}
              </div>
            </div>
            <label className="block text-xs text-slate-500">{t("Τίτλος", "Title")}
              <input value={String(cur.hero_title ?? "")} onChange={(e) => set("hero_title", e.target.value)} placeholder={t("π.χ. Καλοκαιρινές προσφορές", "e.g. Summer offers")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="block text-xs text-slate-500">{t("Υπότιτλος", "Subtitle")}
              <input value={String(cur.hero_subtitle ?? "")} onChange={(e) => set("hero_subtitle", e.target.value)} placeholder={t("π.χ. Έως −40% σε αντηλιακά", "e.g. Up to −40% on sunscreens")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
          </div>
        )}
      </div>
      {/* Online πληρωμή e-shop — Viva (κάρτα + IRIS), ανά φαρμακείο */}
      {(() => {
        const viva = (cur.viva as unknown as Record<string, unknown>) || {};
        const setViva = (k: string, v: string) => { setF({ ...cur, viva: { ...viva, [k]: v } as unknown as Tier[] }); setSaved(false); };
        const inp = "mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm";
        return (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-indigo-900">
              <input type="checkbox" checked={!!cur.online_payment_enabled} onChange={(e) => set("online_payment_enabled", e.target.checked)} /> 💳 {t("Online πληρωμή (κάρτα / IRIS μέσω Viva)", "Online payment (card / IRIS via Viva)")}
            </label>
            <p className="mt-1 text-[11px] text-indigo-700">{t("Τα χρήματα πάνε", "The money goes")} <b>{t("κατευθείαν στον δικό σου λογαριασμό Viva", "straight to your own Viva account")}</b>. {t("Το IRIS εμφανίζεται αυτόματα αν είναι ενεργό στο Viva σου.", "IRIS appears automatically if it's enabled on your Viva.")}</p>
            {!!cur.online_payment_enabled && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-slate-500">Smart Checkout Client ID
                  <input value={String(viva.client_id ?? "")} onChange={(e) => setViva("client_id", e.target.value)} className={inp} /></label>
                <label className="text-xs text-slate-500">Client Secret {viva.client_secret_set ? <span className="text-emerald-600">✓ {t("αποθηκευμένο", "saved")}</span> : ""}
                  <input type="password" value={String(viva.client_secret ?? "")} onChange={(e) => setViva("client_secret", e.target.value)} placeholder={viva.client_secret_set ? t("•••• (κενό = αμετάβλητο)", "•••• (blank = unchanged)") : ""} className={inp} /></label>
                <label className="text-xs text-slate-500">Source Code
                  <input value={String(viva.source_code ?? "")} onChange={(e) => setViva("source_code", e.target.value)} className={inp} /></label>
                <label className="text-xs text-slate-500">{t("Περιβάλλον", "Environment")}
                  <select value={String(viva.mode ?? "demo")} onChange={(e) => setViva("mode", e.target.value)} className={inp}>
                    <option value="demo">{t("Demo (δοκιμές)", "Demo (testing)")}</option><option value="live">Live</option></select></label>
                <label className="text-xs text-slate-500">Merchant ID <span className="text-slate-400">{t("(για επιβεβαίωση)", "(for verification)")}</span>
                  <input value={String(viva.merchant_id ?? "")} onChange={(e) => setViva("merchant_id", e.target.value)} className={inp} /></label>
                <label className="text-xs text-slate-500">API key {viva.api_key_set ? <span className="text-emerald-600">✓</span> : ""}
                  <input type="password" value={String(viva.api_key ?? "")} onChange={(e) => setViva("api_key", e.target.value)} placeholder={viva.api_key_set ? t("•••• (κενό = αμετάβλητο)", "•••• (blank = unchanged)") : ""} className={inp} /></label>
                <p className="text-[11px] text-slate-500 sm:col-span-2">{t("Webhook URL (βάλε το στο Viva):", "Webhook URL (paste it into Viva):")} <code className="text-indigo-700">https://app.rxvision.gr/api/v1/patient/shop/viva-webhook?t={String((cur.tenant_id ?? "TENANT"))}</code></p>
              </div>
            )}
          </div>
        );
      })()}
      </div>

      <div className="sticky bottom-0 -mx-1 flex justify-end border-t border-slate-100 bg-white/80 px-1 py-3 backdrop-blur">
        <button onClick={save} className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700">{saved ? t("✓ Αποθηκεύτηκε", "✓ Saved") : t("Αποθήκευση", "Save")}</button>
      </div>
    </div>
  );
}
