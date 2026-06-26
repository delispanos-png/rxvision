"use client";

import { useEffect, useState } from "react";
import { Search, ShoppingCart, Plus, Minus, Trash2, Truck, Store, ShieldCheck, Pill, Package, ChevronLeft, Loader2 } from "lucide-react";
import { patientApi } from "@/lib/patientClient";

type Product = { barcode: string; name: string; description_long?: string | null; photo_url?: string | null; price_cents: number; type: string; category?: string | null; discount_pct: number; stock_qty: number };
type Settings = { delivery_enabled: boolean; pickup_enabled: boolean; delivery_fee_cents: number; free_over_cents: number; min_order_cents: number; pps_cert: string };
type Order = { _id: string; items: { name: string; qty: number }[]; total_cents: number; mode: string; status: string; created_at: string };
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const final = (p: Product) => Math.round(p.price_cents * (100 - (p.type === "otc_medicine" ? 0 : p.discount_pct)) / 100);
const ST: Record<string, string> = { new: "Νέα", preparing: "Ετοιμάζεται", ready: "Έτοιμη", shipped: "Καθ' οδόν", delivered: "Παραδόθηκε", cancelled: "Ακυρώθηκε" };

export function ShopTab() {
  const [view, setView] = useState<"browse" | "cart" | "orders">("browse");
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [meta, setMeta] = useState<{ categories: string[]; settings: Settings } | null>(null);
  const [cart, setCart] = useState<Record<string, { p: Product; qty: number }>>({});
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => { patientApi<{ categories: string[]; settings: Settings }>("/patient/shop/meta").then(setMeta).catch(() => {}); }, []);
  useEffect(() => {
    const tmo = setTimeout(() => {
      patientApi<{ items: Product[] }>(`/patient/shop?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`).then((d) => setProducts(d.items)).catch(() => {});
    }, 250);
    return () => clearTimeout(tmo);
  }, [q, cat]);

  function add(p: Product) { setCart((c) => ({ ...c, [p.barcode]: { p, qty: Math.min((c[p.barcode]?.qty ?? 0) + 1, p.stock_qty) } })); }
  function dec(bc: string) { setCart((c) => { const q2 = (c[bc]?.qty ?? 0) - 1; const n = { ...c }; if (q2 <= 0) delete n[bc]; else n[bc] = { ...n[bc], qty: q2 }; return n; }); }
  const cartItems = Object.values(cart);
  const subtotal = cartItems.reduce((s, x) => s + final(x.p) * x.qty, 0);
  const count = cartItems.reduce((s, x) => s + x.qty, 0);

  if (view === "orders") return <Orders orders={orders} setOrders={setOrders} onBack={() => setView("browse")} />;
  if (view === "cart") return <Checkout cart={cart} subtotal={subtotal} settings={meta?.settings} onBack={() => setView("browse")} onDone={() => { setCart({}); setView("orders"); }} dec={dec} add={add} />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση προϊόντος…" className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm" />
        </div>
        <button onClick={() => { patientApi<{ items: Order[] }>("/patient/shop/orders").then((d) => setOrders(d.items)).catch(() => {}); setView("orders"); }} className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-600">Οι παραγγελίες μου</button>
      </div>
      {!!meta?.categories.length && (
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setCat("")} className={`rounded-full px-2.5 py-1 text-xs ${!cat ? "bg-violet-600 text-white" : "border border-slate-200 text-slate-600"}`}>Όλα</button>
          {meta.categories.map((c) => <button key={c} onClick={() => setCat(c)} className={`rounded-full px-2.5 py-1 text-xs ${cat === c ? "bg-violet-600 text-white" : "border border-slate-200 text-slate-600"}`}>{c}</button>)}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 pb-20">
        {products.map((p) => {
          const med = p.type === "otc_medicine"; const fc = final(p); const inCart = cart[p.barcode]?.qty ?? 0;
          return (
            <div key={p.barcode} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-2.5">
              <div className="mb-1 grid h-24 place-items-center overflow-hidden rounded-xl bg-slate-50">
                {p.photo_url ? <img src={p.photo_url} alt="" className="h-full w-full object-contain" /> : (med ? <Pill className="h-7 w-7 text-slate-300" /> : <Package className="h-7 w-7 text-slate-300" />)}
              </div>
              <div className="line-clamp-2 min-h-[2.2rem] text-xs font-semibold text-slate-800">{p.name}</div>
              <div className="mt-1 flex items-end justify-between">
                <div>
                  {fc < p.price_cents && <div className="text-[10px] text-slate-400 line-through">{eur(p.price_cents)}</div>}
                  <div className="text-sm font-bold text-slate-900">{eur(fc)}{!med && p.discount_pct > 0 && <span className="ml-1 text-[10px] font-semibold text-emerald-600">-{p.discount_pct}%</span>}</div>
                </div>
                {inCart ? (
                  <div className="flex items-center gap-1.5 rounded-full bg-violet-600 px-1 text-white">
                    <button onClick={() => dec(p.barcode)} className="grid h-6 w-6 place-items-center"><Minus className="h-3.5 w-3.5" /></button>
                    <span className="text-xs font-bold">{inCart}</span>
                    <button onClick={() => add(p)} className="grid h-6 w-6 place-items-center"><Plus className="h-3.5 w-3.5" /></button>
                  </div>
                ) : <button onClick={() => add(p)} className="grid h-8 w-8 place-items-center rounded-full bg-violet-600 text-white"><Plus className="h-4 w-4" /></button>}
              </div>
            </div>
          );
        })}
        {products.length === 0 && <div className="col-span-2 py-10 text-center text-sm text-slate-400">Δεν βρέθηκαν προϊόντα.</div>}
      </div>

      {count > 0 && (
        <button onClick={() => setView("cart")} className="fixed inset-x-4 bottom-4 z-20 mx-auto flex max-w-md items-center justify-between rounded-2xl bg-violet-600 px-5 py-3 text-white shadow-lg">
          <span className="flex items-center gap-2 font-semibold"><ShoppingCart className="h-5 w-5" /> {count} {count === 1 ? "προϊόν" : "προϊόντα"}</span>
          <span className="font-bold">{eur(subtotal)} →</span>
        </button>
      )}
    </div>
  );
}

function Checkout({ cart, subtotal, settings, onBack, onDone, dec, add }: {
  cart: Record<string, { p: Product; qty: number }>; subtotal: number; settings?: Settings;
  onBack: () => void; onDone: () => void; dec: (bc: string) => void; add: (p: Product) => void;
}) {
  const items = Object.values(cart);
  const hasMed = items.some((x) => x.p.type === "otc_medicine");
  const [mode, setMode] = useState<"delivery" | "pickup">(settings?.delivery_enabled ? "delivery" : "pickup");
  const [addr, setAddr] = useState({ street: "", area: "", postal: "", phone: "", notes: "" });
  const [courier, setCourier] = useState(false);
  const [gdpr, setGdpr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fee = mode === "delivery" ? (settings?.free_over_cents && subtotal >= settings.free_over_cents ? 0 : (settings?.delivery_fee_cents ?? 0)) : 0;
  const total = subtotal + fee;
  const belowMin = (settings?.min_order_cents ?? 0) > subtotal;

  async function place() {
    setErr(null);
    if (!gdpr) { setErr("Χρειάζεται η συγκατάθεση επεξεργασίας."); return; }
    if (mode === "delivery" && !courier) { setErr("Χρειάζεται η εξουσιοδότηση μεταφορέα."); return; }
    if (mode === "delivery" && (!addr.street || !addr.area)) { setErr("Συμπλήρωσε διεύθυνση."); return; }
    setBusy(true);
    try {
      const r = await patientApi<{ ok: boolean; error?: string }>("/patient/shop/order", { method: "POST", body: JSON.stringify({
        lines: items.map((x) => ({ barcode: x.p.barcode, qty: x.qty })),
        mode, address: mode === "delivery" ? addr : null, courier_authorized: courier, gdpr_consent: gdpr,
      }) });
      if (r.ok) onDone(); else setErr("Σφάλμα: " + (r.error || "δοκίμασε ξανά"));
    } catch { setErr("Σφάλμα δικτύου."); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 pb-6">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500"><ChevronLeft className="h-4 w-4" /> Συνέχεια αγορών</button>
      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        {items.map((x) => (
          <div key={x.p.barcode} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
            <div className="min-w-0"><div className="truncate text-sm font-medium text-slate-800">{x.p.name}</div><div className="text-xs text-slate-400">{eur(final(x.p))} × {x.qty}</div></div>
            <div className="flex items-center gap-2">
              <button onClick={() => dec(x.p.barcode)} className="grid h-7 w-7 place-items-center rounded-full bg-slate-100">{x.qty === 1 ? <Trash2 className="h-3.5 w-3.5 text-rose-500" /> : <Minus className="h-3.5 w-3.5" />}</button>
              <span className="w-4 text-center text-sm font-bold">{x.qty}</span>
              <button onClick={() => add(x.p)} className="grid h-7 w-7 place-items-center rounded-full bg-slate-100"><Plus className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
      </div>

      {/* delivery vs pickup */}
      <div className="grid grid-cols-2 gap-2">
        {settings?.delivery_enabled && <button onClick={() => setMode("delivery")} className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-medium ${mode === "delivery" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600"}`}><Truck className="h-4 w-4" /> Αποστολή</button>}
        {settings?.pickup_enabled && <button onClick={() => setMode("pickup")} className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-medium ${mode === "pickup" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600"}`}><Store className="h-4 w-4" /> Παραλαβή</button>}
      </div>

      {mode === "delivery" && (
        <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
          <div className="text-sm font-semibold text-slate-700">Διεύθυνση αποστολής</div>
          <input value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} placeholder="Οδός & αριθμός" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <div className="grid grid-cols-2 gap-2">
            <input value={addr.area} onChange={(e) => setAddr({ ...addr, area: e.target.value })} placeholder="Περιοχή" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={addr.postal} onChange={(e) => setAddr({ ...addr, postal: e.target.value })} placeholder="Τ.Κ." className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <input value={addr.phone} onChange={(e) => setAddr({ ...addr, phone: e.target.value })} placeholder="Τηλέφωνο" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input value={addr.notes} onChange={(e) => setAddr({ ...addr, notes: e.target.value })} placeholder="Σημείωση (όροφος, κουδούνι…)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </div>
      )}

      {/* compliance: EU pharmacy certification + consents */}
      {hasMed && settings?.pps_cert && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><ShieldCheck className="h-4 w-4 shrink-0" /> Πιστοποιημένο φαρμακείο (ΠΦΣ): {settings.pps_cert}. Νόμιμη διάθεση ΜΗ.ΣΥ.ΦΑ. βάσει του κοινού λογοτύπου ΕΕ.</div>
      )}
      <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" checked={gdpr} onChange={(e) => setGdpr(e.target.checked)} className="mt-0.5" /> Συναινώ στην επεξεργασία των στοιχείων μου για την εκτέλεση της παραγγελίας (GDPR).</label>
      {mode === "delivery" && <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" checked={courier} onChange={(e) => setCourier(e.target.checked)} className="mt-0.5" /> Εξουσιοδοτώ τον μεταφορέα να παραλάβει και να μου παραδώσει την παραγγελία στη διεύθυνσή μου.</label>}

      <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
        <div className="flex justify-between text-slate-600"><span>Υποσύνολο</span><span>{eur(subtotal)}</span></div>
        {mode === "delivery" && <div className="flex justify-between text-slate-600"><span>Μεταφορικά</span><span>{fee === 0 ? "Δωρεάν" : eur(fee)}</span></div>}
        <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 text-base font-bold text-slate-900"><span>Σύνολο</span><span>{eur(total)}</span></div>
        <p className="mt-1 text-[11px] text-slate-400">Πληρωμή κατά την παράδοση/παραλαβή. Τα φάρμακα δεν επιστρέφονται.</p>
      </div>

      {belowMin && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">Ελάχιστη παραγγελία {eur(settings?.min_order_cents ?? 0)}.</div>}
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      <button onClick={place} disabled={busy || belowMin} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 font-semibold text-white disabled:opacity-50">
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null} Ολοκλήρωση παραγγελίας · {eur(total)}
      </button>
    </div>
  );
}

function Orders({ orders, setOrders, onBack }: { orders: Order[]; setOrders: (o: Order[]) => void; onBack: () => void }) {
  useEffect(() => { patientApi<{ items: Order[] }>("/patient/shop/orders").then((d) => setOrders(d.items)).catch(() => {}); }, [setOrders]);
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500"><ChevronLeft className="h-4 w-4" /> Στο κατάστημα</button>
      {orders.length === 0 && <div className="py-10 text-center text-sm text-slate-400">Δεν έχεις παραγγελίες ακόμη.</div>}
      {orders.map((o) => (
        <div key={o._id} className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">{o.mode === "delivery" ? <Truck className="h-4 w-4 text-violet-500" /> : <Store className="h-4 w-4 text-sky-500" />} {eur(o.total_cents)}</span>
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">{ST[o.status] ?? o.status}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">{o.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">{new Date(o.created_at).toLocaleString("el-GR")}</div>
        </div>
      ))}
    </div>
  );
}
