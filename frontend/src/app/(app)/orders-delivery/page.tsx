"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Truck, Package, MapPin, Phone, Check, Loader2, Settings as Cog } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Item = { barcode: string; name: string; qty: number; line_cents: number; discount_pct: number; type: string };
type Order = {
  _id: string; patient_name: string; patient_phone: string; items: Item[];
  subtotal_cents: number; delivery_fee_cents: number; total_cents: number; mode: string;
  address?: { street?: string; area?: string; postal?: string; phone?: string; notes?: string } | null;
  has_medicine: boolean; status: string; created_at: string;
};
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const ST: Record<string, { label: string; cls: string }> = {
  new: { label: "Νέα", cls: "bg-rose-100 text-rose-700" },
  preparing: { label: "Σε ετοιμασία", cls: "bg-amber-100 text-amber-700" },
  ready: { label: "Έτοιμη", cls: "bg-sky-100 text-sky-700" },
  shipped: { label: "Καθ' οδόν", cls: "bg-violet-100 text-violet-700" },
  delivered: { label: "Παραδόθηκε", cls: "bg-emerald-100 text-emerald-700" },
  cancelled: { label: "Ακυρώθηκε", cls: "bg-slate-200 text-slate-500" },
};
const NEXT: Record<string, { to: string; label: string }[]> = {
  new: [{ to: "preparing", label: "Ετοιμασία" }, { to: "cancelled", label: "Ακύρωση" }],
  preparing: [{ to: "ready", label: "Έτοιμη (παραλαβή)" }, { to: "shipped", label: "Απεστάλη (αποστολή)" }],
  ready: [{ to: "delivered", label: "Παραδόθηκε" }],
  shipped: [{ to: "delivered", label: "Παραδόθηκε" }],
};

export default function OrdersDeliveryPage() {
  return <ModuleGuard module="order_delivery"><Orders /></ModuleGuard>;
}

function Orders() {
  const [tab, setTab] = useState<"orders" | "done" | "settings">("orders");
  const list = useQuery({ queryKey: ["od-orders"], queryFn: () => api<{ items: Order[] }>("/orders/delivery"), refetchInterval: 20000, retry: false });
  const [busy, setBusy] = useState<string | null>(null);
  async function advance(id: string, status: string) {
    setBusy(id);
    try { await api(`/orders/delivery/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }); await list.refetch(); }
    finally { setBusy(null); }
  }
  const orders = (list.data?.items ?? []).filter((o) => !["delivered", "cancelled"].includes(o.status));
  const done = (list.data?.items ?? []).filter((o) => ["delivered", "cancelled"].includes(o.status));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-800"><Truck className="h-6 w-6 text-brand-600" /> Παραγγελίες & Αποστολή</div>
      <p className="mb-4 text-sm text-slate-500">Παραγγελίες πελατών από τον κατάλογό σου (OTC + παραφάρμακα).</p>

      <div className="mb-4 flex gap-2">
        {([["orders", `Ενεργές${orders.length ? ` (${orders.length})` : ""}`], ["done", `Ολοκληρωμένες${done.length ? ` (${done.length})` : ""}`], ["settings", "Ρυθμίσεις αποστολής"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === k ? "bg-brand-600 text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{l}</button>
        ))}
      </div>

      {tab === "settings" && <SettingsTab />}
      {tab === "orders" && (
        <div className="space-y-3">
          {list.isLoading && <div className="py-8 text-center text-sm text-slate-400">Φόρτωση…</div>}
          {!list.isLoading && orders.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Καμία ενεργή παραγγελία.</div>}
          {orders.map((o) => (
            <div key={o._id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    {o.mode === "delivery" ? <Truck className="h-4 w-4 text-violet-500" /> : <Package className="h-4 w-4 text-sky-500" />}
                    {o.patient_name || "Πελάτης"} <span className={`rounded-full px-2 py-0.5 text-[11px] ${ST[o.status]?.cls}`}>{ST[o.status]?.label}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{new Date(o.created_at).toLocaleString("el-GR")} · {o.mode === "delivery" ? "Αποστολή" : "Παραλαβή"}</div>
                </div>
                <div className="text-right"><div className="text-base font-bold text-slate-800">{eur(o.total_cents)}</div>{o.delivery_fee_cents > 0 && <div className="text-[11px] text-slate-400">(+{eur(o.delivery_fee_cents)} μεταφορικά)</div>}</div>
              </div>
              <div className="mt-2 space-y-0.5 text-sm text-slate-600">
                {o.items.map((it, i) => <div key={i} className="flex justify-between"><span>{it.qty}× {it.name}{it.discount_pct > 0 && <span className="ml-1 text-emerald-600">-{it.discount_pct}%</span>}</span><span>{eur(it.line_cents)}</span></div>)}
              </div>
              {o.mode === "delivery" && o.address && (
                <div className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
                  <div className="flex items-center gap-1 font-medium"><MapPin className="h-3.5 w-3.5" /> {o.address.street}, {o.address.area} {o.address.postal}</div>
                  {o.address.phone && <div className="mt-0.5 flex items-center gap-1"><Phone className="h-3 w-3" /> {o.address.phone}</div>}
                  {o.address.notes && <div className="mt-0.5 italic">«{o.address.notes}»</div>}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {(NEXT[o.status] ?? []).map((n) => (
                  <button key={n.to} onClick={() => advance(o._id, n.to)} disabled={busy === o._id}
                    className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${n.to === "cancelled" ? "border border-rose-300 text-rose-600 hover:bg-rose-50" : "bg-brand-600 text-white hover:bg-brand-700"}`}>
                    {busy === o._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {n.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === "done" && (
        <div className="space-y-2">
          {done.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Καμία ολοκληρωμένη παραγγελία ακόμη.</div>}
          {done.map((o) => (
            <div key={o._id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-sm text-slate-500">
              <span className="min-w-0 truncate">{o.patient_name} · {o.items.length} είδη · {new Date(o.created_at).toLocaleDateString("el-GR")}</span>
              <span className="flex shrink-0 items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-[11px] ${ST[o.status]?.cls}`}>{ST[o.status]?.label}</span> {eur(o.total_cents)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsTab() {
  const s = useQuery({ queryKey: ["od-settings"], queryFn: () => api<Record<string, number | boolean | string>>("/orders/delivery/settings"), retry: false });
  const [f, setF] = useState<Record<string, number | boolean | string> | null>(null);
  const cur = f ?? s.data;
  const [saved, setSaved] = useState(false);
  if (!cur) return <div className="py-8 text-center text-sm text-slate-400">Φόρτωση…</div>;
  const set = (k: string, v: number | boolean | string) => { setF({ ...cur, [k]: v }); setSaved(false); };
  async function save() { await api("/orders/delivery/settings", { method: "POST", body: JSON.stringify(cur) }); setSaved(true); }
  const eurIn = (k: string) => (
    <input type="number" step="0.01" value={Number(cur[k] as number) / 100} onChange={(e) => set(k, Math.round(+e.target.value * 100))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
  );
  return (
    <div className="max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cur.delivery_enabled} onChange={(e) => set("delivery_enabled", e.target.checked)} /> Αποστολή κατ’ οίκον</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cur.pickup_enabled} onChange={(e) => set("pickup_enabled", e.target.checked)} /> Παραλαβή από το φαρμακείο</label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-slate-500">Μεταφορικά (€){eurIn("delivery_fee_cents")}</label>
        <label className="text-xs text-slate-500">Δωρεάν αποστολή άνω (€){eurIn("free_over_cents")}</label>
        <label className="text-xs text-slate-500">Ελάχιστη παραγγελία (€){eurIn("min_order_cents")}</label>
      </div>
      <label className="block text-xs text-slate-500">Αναφορά πιστοποίησης ΠΦΣ (e-φαρμακείο — εμφανίζεται με το λογότυπο ΕΕ)
        <input value={String(cur.pps_cert ?? "")} onChange={(e) => set("pps_cert", e.target.value)} placeholder="π.χ. αρ. μητρώου / σύνδεσμος" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
      <p className="text-[11px] text-slate-400">Για online πώληση φαρμάκων (OTC) απαιτείται πιστοποίηση ΠΦΣ + το κοινό λογότυπο ΕΕ. Τα παραφάρμακα δεν το χρειάζονται.</p>

      <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-violet-900"><input type="checkbox" checked={!!cur.subscription_enabled} onChange={(e) => set("subscription_enabled", e.target.checked)} /> 🔁 Επαναλαμβανόμενες παραγγελίες (συνδρομές)</label>
        <p className="mt-1 text-[11px] text-violet-700">Ο πελάτης μπορεί να ορίσει παραγγελία που επαναλαμβάνεται αυτόματα. Δώσε επιπλέον κίνητρο με μεγαλύτερη έκπτωση (μόνο σε παραφάρμακα — τα φάρμακα μένουν χωρίς έκπτωση).</p>
        {!!cur.subscription_enabled && (
          <label className="mt-2 block text-xs text-slate-500">Επιπλέον έκπτωση συνδρομής % (στα παραφάρμακα)
            <input type="number" value={Number(cur.subscription_discount_pct ?? 0)} onChange={(e) => set("subscription_discount_pct", Math.max(0, Math.min(90, +e.target.value)))} className="mt-1 w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
        )}
      </div>

      <button onClick={save} className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700">{saved ? "✓ Αποθηκεύτηκε" : "Αποθήκευση"}</button>
    </div>
  );
}
