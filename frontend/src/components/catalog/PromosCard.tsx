"use client";

// Κουπόνια + Πακέτα (bundles) e-shop.
// ΚΑΝΟΝΑΣ: ισχύουν ΜΟΝΟ σε μη-συνταγογραφούμενα — επιβάλλεται server-side (shop_pricing.py).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ticket, Package, Plus, Trash2, Pencil, X } from "lucide-react";
import { api } from "@/lib/apiClient";

type Coupon = {
  _id?: string; code: string; kind: "pct" | "amount"; value: number;
  min_order_cents: number; max_uses: number; used_count?: number;
  expires_at?: string | null; active: boolean;
};
type BundleLine = { barcode: string; qty: number };
type Bundle = {
  _id?: string; name: string; kind: "combo" | "nplusm"; active: boolean;
  barcode?: string | null; buy_qty?: number; free_qty?: number;
  lines?: BundleLine[]; discount_pct?: number;
};
const EMPTY_C: Coupon = { code: "", kind: "pct", value: 10, min_order_cents: 0, max_uses: 0, active: true };
const EMPTY_B: Bundle = { name: "", kind: "nplusm", active: true, barcode: "", buy_qty: 2, free_qty: 1, lines: [{ barcode: "", qty: 1 }, { barcode: "", qty: 1 }], discount_pct: 10 };
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";

export function PromosCard() {
  const qc = useQueryClient();
  const cKey = ["catalog", "coupons"], bKey = ["catalog", "bundles"];
  const coupons = useQuery({ queryKey: cKey, queryFn: () => api<{ items: Coupon[] }>("/catalog/coupons") });
  const bundles = useQuery({ queryKey: bKey, queryFn: () => api<{ items: Bundle[] }>("/catalog/bundles") });
  const [ec, setEc] = useState<Coupon | null>(null);
  const [eb, setEb] = useState<Bundle | null>(null);
  const [err, setErr] = useState("");

  const saveC = useMutation({
    mutationFn: (c: Coupon) => api<{ ok: boolean; error?: string }>("/catalog/coupons", { method: "POST", body: JSON.stringify({ ...c, id: c._id ?? null }) }),
    onSuccess: (r) => { if (r?.ok === false) { setErr(r.error === "code_exists" ? "Ο κωδικός υπάρχει ήδη." : "Σφάλμα."); return; } qc.invalidateQueries({ queryKey: cKey }); setEc(null); setErr(""); },
  });
  const delC = useMutation({ mutationFn: (id: string) => api(`/catalog/coupons/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: cKey }) });
  const saveB = useMutation({
    mutationFn: (b: Bundle) => api<{ ok: boolean; error?: string }>("/catalog/bundles", { method: "POST", body: JSON.stringify({ ...b, id: b._id ?? null }) }),
    onSuccess: (r) => { if (r?.ok === false) { setErr(r.error === "need_two_lines" ? "Το combo θέλει ≥2 barcodes." : "Σφάλμα — έλεγξε το barcode."); return; } qc.invalidateQueries({ queryKey: bKey }); setEb(null); setErr(""); },
  });
  const delB = useMutation({ mutationFn: (id: string) => api(`/catalog/bundles/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: bKey }) });

  const cs = coupons.data?.items ?? [], bs = bundles.data?.items ?? [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* ── Κουπόνια ── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-slate-800"><Ticket className="h-4 w-4 text-violet-500" /> Κουπόνια</div>
          <button onClick={() => { setEc({ ...EMPTY_C }); setErr(""); }} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"><Plus className="h-3.5 w-3.5" /> Νέο</button>
        </div>
        <p className="mb-3 text-xs text-slate-500">Κωδικός έκπτωσης στο καλάθι. Ισχύει μόνο στα μη-συνταγογραφούμενα.</p>
        {cs.length === 0 && <p className="py-3 text-center text-sm text-slate-400">Κανένα κουπόνι.</p>}
        <div className="space-y-2">
          {cs.map((c) => (
            <div key={c._id} className={`flex items-center justify-between gap-2 rounded-xl border p-2.5 ${c.active ? "border-violet-200 bg-violet-50/50" : "border-slate-200 bg-slate-50"}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-slate-900 px-1.5 py-0.5 text-[11px] font-bold text-white">{c.code}</code>
                  <span className="text-sm font-semibold text-violet-700">{c.kind === "pct" ? `−${c.value}%` : `−${eur(c.value)}`}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {c.min_order_cents > 0 && <>ελάχ. {eur(c.min_order_cents)} · </>}
                  {c.max_uses > 0 ? `${c.used_count ?? 0}/${c.max_uses} χρήσεις` : `${c.used_count ?? 0} χρήσεις`}
                  {c.expires_at && <> · λήγει {new Date(c.expires_at).toLocaleDateString("el-GR")}</>}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => { setEc(c); setErr(""); }} className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500"><Pencil className="h-3 w-3" /></button>
                <button onClick={() => c._id && delC.mutate(c._id)} className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-rose-500"><Trash2 className="h-3 w-3" /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Πακέτα ── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-slate-800"><Package className="h-4 w-4 text-emerald-500" /> Πακέτα</div>
          <button onClick={() => { setEb({ ...EMPTY_B }); setErr(""); }} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"><Plus className="h-3.5 w-3.5" /> Νέο</button>
        </div>
        <p className="mb-3 text-xs text-slate-500">«2+1» στο ίδιο είδος ή combo (μαζί φθηνότερα). Μόνο μη-συνταγογραφούμενα.</p>
        {bs.length === 0 && <p className="py-3 text-center text-sm text-slate-400">Κανένα πακέτο.</p>}
        <div className="space-y-2">
          {bs.map((b) => (
            <div key={b._id} className={`flex items-center justify-between gap-2 rounded-xl border p-2.5 ${b.active ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-slate-50"}`}>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">{b.name}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {b.kind === "nplusm"
                    ? `${b.buy_qty}+${b.free_qty} · barcode ${b.barcode}`
                    : `${(b.lines ?? []).map((l) => `${l.qty}× ${l.barcode}`).join(" + ")} → −${b.discount_pct}%`}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => { setEb(b); setErr(""); }} className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500"><Pencil className="h-3 w-3" /></button>
                <button onClick={() => b._id && delB.mutate(b._id)} className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-rose-500"><Trash2 className="h-3 w-3" /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── modal κουπονιού ── */}
      {ec && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setEc(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><div className="font-semibold text-slate-800">{ec._id ? "Επεξεργασία κουπονιού" : "Νέο κουπόνι"}</div><button onClick={() => setEc(null)} className="text-slate-400"><X className="h-4 w-4" /></button></div>
            <div className="space-y-3">
              <label className="block text-sm"><span className="mb-1 block text-slate-600">Κωδικός</span>
                <input value={ec.code} onChange={(e) => setEc({ ...ec, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "") })} placeholder="WELCOME10" className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono" /></label>
              <div className="flex gap-2">
                {(["pct", "amount"] as const).map((k) => (
                  <button key={k} onClick={() => setEc({ ...ec, kind: k, value: k === "pct" ? 10 : 500 })} className={`flex-1 rounded-lg border px-2 py-2 text-sm font-semibold ${ec.kind === k ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>{k === "pct" ? "Ποσοστό %" : "Ποσό €"}</button>
                ))}
              </div>
              <label className="block text-sm"><span className="mb-1 block text-slate-600">{ec.kind === "pct" ? "Έκπτωση %" : "Έκπτωση (€)"}</span>
                <input type="number" min={1} value={ec.kind === "pct" ? ec.value : ec.value / 100}
                  onChange={(e) => setEc({ ...ec, value: ec.kind === "pct" ? Math.max(1, Math.min(90, +e.target.value)) : Math.round(+e.target.value * 100) })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
              <label className="block text-sm"><span className="mb-1 block text-slate-600">Ελάχιστη αξία καλαθιού (€) — 0 = καμία</span>
                <input type="number" min={0} value={ec.min_order_cents / 100} onChange={(e) => setEc({ ...ec, min_order_cents: Math.round(+e.target.value * 100) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
              <label className="block text-sm"><span className="mb-1 block text-slate-600">Μέγιστες χρήσεις — 0 = απεριόριστες</span>
                <input type="number" min={0} value={ec.max_uses} onChange={(e) => setEc({ ...ec, max_uses: Math.max(0, +e.target.value) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ec.active} onChange={(e) => setEc({ ...ec, active: e.target.checked })} className="h-4 w-4" /><span className="text-slate-700">Ενεργό</span></label>
              {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
              <div className="flex justify-end gap-2"><button onClick={() => setEc(null)} className="px-3 py-2 text-sm text-slate-400">Άκυρο</button>
                <button onClick={() => saveC.mutate(ec)} disabled={ec.code.length < 3 || saveC.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">Αποθήκευση</button></div>
            </div>
          </div>
        </div>
      )}

      {/* ── modal πακέτου ── */}
      {eb && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setEb(null)}>
          <div className="max-h-[85vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><div className="font-semibold text-slate-800">{eb._id ? "Επεξεργασία πακέτου" : "Νέο πακέτο"}</div><button onClick={() => setEb(null)} className="text-slate-400"><X className="h-4 w-4" /></button></div>
            <div className="space-y-3">
              <label className="block text-sm"><span className="mb-1 block text-slate-600">Όνομα</span>
                <input value={eb.name} onChange={(e) => setEb({ ...eb, name: e.target.value })} placeholder="π.χ. 2+1 σε αντηλιακά" className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
              <div className="flex gap-2">
                {([["nplusm", "«2+1» ίδιο είδος"], ["combo", "Combo (μαζί)"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setEb({ ...eb, kind: k })} className={`flex-1 rounded-lg border px-2 py-2 text-xs font-semibold ${eb.kind === k ? "border-emerald-500 bg-emerald-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>{l}</button>
                ))}
              </div>
              {eb.kind === "nplusm" ? (
                <>
                  <label className="block text-sm"><span className="mb-1 block text-slate-600">Barcode προϊόντος</span>
                    <input value={eb.barcode ?? ""} onChange={(e) => setEb({ ...eb, barcode: e.target.value.trim() })} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono" /></label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-sm"><span className="mb-1 block text-slate-600">Αγοράζει</span>
                      <input type="number" min={1} value={eb.buy_qty} onChange={(e) => setEb({ ...eb, buy_qty: Math.max(1, +e.target.value) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                    <label className="block text-sm"><span className="mb-1 block text-slate-600">Δωρεάν</span>
                      <input type="number" min={1} value={eb.free_qty} onChange={(e) => setEb({ ...eb, free_qty: Math.max(1, +e.target.value) })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                  </div>
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">Ανά {(eb.buy_qty ?? 2) + (eb.free_qty ?? 1)} τεμάχια στο καλάθι, τα {eb.free_qty} είναι δωρεάν.</p>
                </>
              ) : (
                <>
                  <div className="text-sm"><span className="mb-1 block text-slate-600">Barcodes που πρέπει να είναι ΟΛΑ στο καλάθι</span>
                    <div className="space-y-1.5">
                      {(eb.lines ?? []).map((l, i) => (
                        <div key={i} className="flex gap-1.5">
                          <input value={l.barcode} onChange={(e) => { const ls = [...(eb.lines ?? [])]; ls[i] = { ...ls[i], barcode: e.target.value.trim() }; setEb({ ...eb, lines: ls }); }} placeholder="barcode" className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-sm" />
                          <input type="number" min={1} value={l.qty} onChange={(e) => { const ls = [...(eb.lines ?? [])]; ls[i] = { ...ls[i], qty: Math.max(1, +e.target.value) }; setEb({ ...eb, lines: ls }); }} className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                          <button onClick={() => setEb({ ...eb, lines: (eb.lines ?? []).filter((_, j) => j !== i) })} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setEb({ ...eb, lines: [...(eb.lines ?? []), { barcode: "", qty: 1 }] })} className="mt-1.5 inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600"><Plus className="h-3 w-3" /> Γραμμή</button>
                  </div>
                  <label className="block text-sm"><span className="mb-1 block text-slate-600">Έκπτωση στα είδη του πακέτου: <b>{eb.discount_pct}%</b></span>
                    <input type="range" min={1} max={90} value={eb.discount_pct} onChange={(e) => setEb({ ...eb, discount_pct: +e.target.value })} className="w-full accent-emerald-600" /></label>
                </>
              )}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={eb.active} onChange={(e) => setEb({ ...eb, active: e.target.checked })} className="h-4 w-4" /><span className="text-slate-700">Ενεργό</span></label>
              {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
              <div className="flex justify-end gap-2"><button onClick={() => setEb(null)} className="px-3 py-2 text-sm text-slate-400">Άκυρο</button>
                <button onClick={() => saveB.mutate(eb)} disabled={!eb.name.trim() || saveB.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">Αποθήκευση</button></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
