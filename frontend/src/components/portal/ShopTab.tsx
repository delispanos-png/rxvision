"use client";

import { Fragment, useEffect, useState } from "react";
import { Search, ShoppingCart, ShoppingBag, Plus, Minus, Trash2, Truck, Store, ShieldCheck, Pill, Package, ChevronLeft, ChevronDown, Loader2, MapPin, Check, XCircle, PackageCheck, RefreshCcw, Star, Heart } from "lucide-react";
import { patientApi, API_BASE } from "@/lib/patientClient";
import { toast, confirmDialog } from "@/components/portal/Toaster";

// Emoji ανά θεραπευτική/εμπορική κατηγορία (keyword match) — «εικονίδιο» μέσα στο native select.
const _CAT_EMOJI: [string, string][] = [
  ["καρδι", "❤️"], ["αντιβιοτ", "🦠"], ["αντιλοιμ", "🦠"], ["ψυχοφ", "🧠"], ["νευρολογ", "🧠"],
  ["αναλγητ", "💊"], ["αντιπυρετ", "🌡️"], ["αντιφλεγμον", "🦴"], ["μυοσκελετ", "🦴"], ["ορθοπεδ", "🦴"],
  ["γαστρεντ", "🫄"], ["διαβητ", "🩸"], ["μεταβολ", "🩸"], ["αναπνευστ", "🫁"], ["ασθμα", "🫁"],
  ["βηχ", "🤧"], ["κρυολ", "🤧"], ["δερματολογ", "🧴"], ["οφθαλμ", "👁️"], ["ωρλ", "👂"],
  ["ορμον", "🦋"], ["θυρεοειδ", "🦋"], ["ουρογεν", "🚻"], ["γυναικολογ", "🌸"], ["αιμα", "🩸"],
  ["αντιπηκτ", "🩸"], ["ογκολογ", "🎗️"], ["ανοσολογ", "🎗️"], ["εμβολ", "💉"], ["βιταμιν", "🍊"],
  ["συμπληρ", "🍊"], ["καλλυντ", "💄"], ["αντηλιακ", "☀️"], ["προσωπ", "🧖"], ["σωματ", "🧴"],
  ["μαλλι", "💇"], ["βρεφ", "🍼"], ["παιδ", "🧸"], ["εγκυμ", "🤰"], ["μαμα", "🤱"],
  ["στοματ", "🦷"], ["πιεσομ", "🩺"], ["ιατροτεχν", "🩺"], ["αντισηπτ", "🧼"], ["υγιειν", "🧼"],
  ["σεξουαλ", "💗"], ["διαιτητ", "🥗"], ["γλουτεν", "🥗"], ["φυτικ", "🌿"], ["ομοιοπαθ", "🌿"],
  ["επιδεσμ", "🩹"], ["διαφορα", "📦"], ["λοιπα", "📦"],
];
function catEmoji(c: string): string {
  const s = (c || "").toLowerCase();
  for (const [kw, e] of _CAT_EMOJI) if (s.includes(kw)) return e;
  return "💊";
}

type Product = { barcode: string; name: string; description_long?: string | null; photo_url?: string | null; image_id?: string | null; usage_video_url?: string | null; price_cents: number; type: string; category?: string | null; tags?: string[]; featured?: boolean; discount_pct: number; stock_qty: number };

// YouTube/Vimeo URL → ασφαλές embed URL (whitelist· αλλιώς null)
function videoEmbed(url?: string | null): string | null {
  const u = (url || "").trim();
  let m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/i);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return null;
}
const isBackorder = (p: Product) => (p.stock_qty ?? 0) <= 0;             // χωρίς απόθεμα → κατόπιν παραγγελίας
const capOf = (p: Product) => isBackorder(p) ? 99 : p.stock_qty;        // backorder → επιτρέπεται προσθήκη
type Tier = { min_cents: number; pct: number };
type Settings = { delivery_enabled: boolean; pickup_enabled: boolean; delivery_fee_cents: number; free_over_cents: number; min_order_cents: number; pps_cert: string; subscription_enabled: boolean; subscription_discount_pct: number; cart_tiers?: Tier[]; online_payment_enabled?: boolean };
type BundleLine = { barcode: string; qty: number };
type Bundle = { name: string; kind: "combo" | "nplusm"; barcode?: string | null; buy_qty?: number; free_qty?: number; lines?: BundleLine[]; discount_pct?: number };
const LOW_STOCK = 5;
const imgSrc = (p: Product) => p.image_id ? `${API_BASE}/catalog/image/${p.image_id}` : (p.photo_url || "");
const TAG_STYLE: Record<string, string> = { "Προσφορά": "bg-rose-100 text-rose-700", "Νέο": "bg-emerald-100 text-emerald-700", "Δημοφιλές": "bg-amber-100 text-amber-800", "Bestseller": "bg-amber-100 text-amber-800", "Βιολογικό": "bg-green-100 text-green-700", "Vegan": "bg-green-100 text-green-700" };
const tagCls = (t: string) => TAG_STYLE[t] || "bg-slate-100 text-slate-600";
const SORTS: [string, string][] = [["featured", "Προτεινόμενα"], ["newest", "Νεότερα"], ["price_asc", "Φθηνότερα"], ["price_desc", "Ακριβότερα"]];
type Sub = { _id: string; items?: { barcode: string; qty: number }[]; lines?: { barcode: string; qty: number }[]; mode: string; interval_days: number; next_run: string };
const FREQ: [number, string][] = [[0, "Μία φορά"], [14, "Κάθε 2 εβδομάδες"], [30, "Κάθε μήνα"], [60, "Κάθε 2 μήνες"], [90, "Κάθε 3 μήνες"]];
type OrderItem = { barcode: string; name: string; qty: number; line_cents: number; discount_pct?: number; backorder?: boolean };
type OrderAddr = { street?: string; area?: string; postal?: string; phone?: string; notes?: string } | null;
type Order = { _id: string; items: OrderItem[]; subtotal_cents: number; delivery_fee_cents: number; total_cents: number; mode: string; status: string; created_at: string; address?: OrderAddr; has_backorder?: boolean; available_date?: string | null };
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const isMed = (t: string) => t === "rx_medicine" || t === "otc_medicine";
const noDisc = (t: string) => t === "rx_medicine";   // μόνο τα συνταγογραφούμενα → 0% έκπτωση
// Εκπτωτική καμπάνια σε ομάδα ειδών (κατηγορίες/ετικέτες). Καθρεφτίζει τη μηχανή του server
// (shop_campaigns.campaign_pct_for) — ΜΟΝΟ για εμφάνιση· η τιμή υπολογίζεται πάντα server-side.
type Campaign = { name: string; discount_pct: number; categories: string[]; tags: string[] };
type Loyalty = { enabled: boolean; balance_cents: number; min_redeem_cents: number; member?: boolean };
const campPct = (p: Product, camps: Campaign[] = []) => {
  if (noDisc(p.type)) return 0;                       // συνταγογραφούμενα: ποτέ έκπτωση καμπάνιας
  const cat = (p.category || "").trim().toLowerCase();
  const tags = new Set((p.tags || []).map((t) => t.trim().toLowerCase()));
  let best = 0;
  for (const c of camps) {
    const cs = (c.categories || []).map((s) => s.toLowerCase());
    const ts = (c.tags || []).map((s) => s.toLowerCase());
    const match = (cs.length === 0 && ts.length === 0) || cs.includes(cat) || ts.some((t) => tags.has(t));
    if (match) best = Math.max(best, c.discount_pct || 0);
  }
  return Math.min(90, best);
};
// Καλύτερη έκπτωση: δική του ή καμπάνιας (ΔΕΝ αθροίζονται).
const effDisc = (p: Product, camps: Campaign[] = []) => noDisc(p.type) ? 0 : Math.max(p.discount_pct || 0, campPct(p, camps));
const final = (p: Product, camps: Campaign[] = []) => Math.round(p.price_cents * (100 - effDisc(p, camps)) / 100);

// ── Καθρέφτης της μηχανής του server (services/shop_pricing.py) — ΜΟΝΟ για εμφάνιση.
// Η τελική τιμή υπολογίζεται πάντα ξανά server-side κατά την παραγγελία.
type CartLine = { barcode: string; type: string; qty: number; line_cents: number };
const bundleSavings = (lines: CartLine[], bundles: Bundle[]) => {
  const byBc: Record<string, CartLine> = {};
  lines.filter((l) => !noDisc(l.type)).forEach((l) => { byBc[l.barcode] = l; });   // rx εκτός
  let total = 0; const names: string[] = [];
  for (const b of bundles) {
    if (b.kind === "nplusm") {
      const it = byBc[b.barcode || ""]; if (!it) continue;
      const buy = Math.max(1, b.buy_qty ?? 2), free = Math.max(1, b.free_qty ?? 1);
      const sets = Math.floor(it.qty / (buy + free)); if (sets <= 0) continue;
      const unit = Math.floor(it.line_cents / Math.max(1, it.qty));
      const save = sets * free * unit;
      if (save > 0) { total += save; names.push(b.name); }
    } else {
      const ls = b.lines || []; if (!ls.length) continue;
      let sets: number | null = null;
      for (const ln of ls) {
        const it = byBc[ln.barcode]; const need = Math.max(1, ln.qty || 1);
        const s = Math.floor((it?.qty ?? 0) / need);
        sets = sets === null ? s : Math.min(sets, s);
        if (!sets) break;
      }
      if (!sets) continue;
      const pct = Math.max(1, Math.min(90, b.discount_pct ?? 0));
      let save = 0;
      for (const ln of ls) {
        const it = byBc[ln.barcode]; const need = Math.max(1, ln.qty || 1);
        const unit = Math.floor(it.line_cents / Math.max(1, it.qty));
        save += Math.round(unit * need * sets * pct / 100);
      }
      if (save > 0) { total += save; names.push(b.name); }
    }
  }
  return { total, names };
};
const tierDiscount = (base: number, tiers: Tier[] = []) => {
  let pct = 0;
  for (const t of tiers) if (base >= (t.min_cents || 0)) pct = Math.max(pct, Math.max(0, Math.min(90, t.pct || 0)));
  return { cents: pct ? Math.round(base * pct / 100) : 0, pct };
};
type AppliedCoupon = { code: string; kind: "pct" | "amount"; value: number };
const couponCentsOf = (c: AppliedCoupon | null, base: number) =>
  !c || base <= 0 ? 0 : (c.kind === "amount" ? Math.min(base, c.value) : Math.round(base * Math.max(0, Math.min(90, c.value)) / 100));
const ST: Record<string, string> = { pending: "Σε αναμονή έγκρισης", new: "Νέα", preparing: "Ετοιμάζεται", ready: "Έτοιμη", shipped: "Καθ' οδόν", delivered: "Παραδόθηκε", declined: "Απορρίφθηκε", cancelled: "Ακυρώθηκε" };

export function ShopTab({ tenantKey = "x" }: { tenantKey?: string }) {
  const CART_KEY = `rxv_cart_${tenantKey}`;
  const [view, setView] = useState<"browse" | "cart" | "orders" | "subs" | "favorites">("browse");
  const [products, setProducts] = useState<Product[]>([]);
  const [video, setVideo] = useState<string | null>(null);   // embed URL οδηγιών χρήσης
  const [favBarcodes, setFavBarcodes] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState("featured");
  const [meta, setMeta] = useState<{ categories: string[]; tags: string[]; settings: Settings; campaigns?: Campaign[]; bundles?: Bundle[]; loyalty?: Loyalty } | null>(null);
  // Καλάθι: αρχικοποίηση ΑΠΟ localStorage (ανά φαρμακείο) ώστε να ΜΗΝ χάνεται σε refresh.
  const [cart, setCart] = useState<Record<string, { p: Product; qty: number }>>(() => {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || "{}"); } catch { return {}; }
  });
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* full/blocked */ } }, [cart, CART_KEY]);
  // Αντίγραφο καλαθιού στον server (debounced) → επιτρέπει υπενθύμιση «ξεχασμένου καλαθιού».
  // Στέλνει μόνο barcode+qty. Κάθε αλλαγή μηδενίζει το reminded_at ώστε να μην σπαμάρει.
  useEffect(() => {
    const tmo = setTimeout(() => {
      const lines = Object.values(cart).map((x) => ({ barcode: x.p.barcode, qty: x.qty }));
      patientApi("/patient/shop/cart", { method: "POST", body: JSON.stringify({ lines }) }).catch(() => {});
    }, 1500);
    return () => clearTimeout(tmo);
  }, [cart]);
  useEffect(() => { patientApi<{ categories: string[]; tags: string[]; settings: Settings; campaigns?: Campaign[]; bundles?: Bundle[]; loyalty?: Loyalty }>("/patient/shop/meta").then(setMeta).catch(() => {}); }, []);
  // Φόρτωσε τις παραγγελίες στην αρχή ώστε το κουμπί «Οι παραγγελίες μου» να δείχνει badge ενεργών.
  useEffect(() => { patientApi<{ items: Order[] }>("/patient/shop/orders").then((d) => setOrders(d.items)).catch(() => {}); }, []);
  useEffect(() => { patientApi<{ barcodes: string[] }>("/patient/shop/favorites").then((d) => setFavBarcodes(new Set(d.barcodes))).catch(() => {}); }, []);
  async function toggleFav(barcode: string) {
    setFavBarcodes((s) => { const n = new Set(s); if (n.has(barcode)) n.delete(barcode); else n.add(barcode); return n; });
    try { await patientApi("/patient/shop/favorite", { method: "POST", body: JSON.stringify({ barcode }) }); } catch { /* ignore */ }
  }
  useEffect(() => {
    const tmo = setTimeout(() => {
      patientApi<{ items: Product[] }>(`/patient/shop?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}&tag=${encodeURIComponent(tag)}&sort=${sort}`).then((d) => setProducts(d.items)).catch(() => {});
    }, 250);
    return () => clearTimeout(tmo);
  }, [q, cat, tag, sort]);

  function add(p: Product) { setCart((c) => ({ ...c, [p.barcode]: { p, qty: Math.min((c[p.barcode]?.qty ?? 0) + 1, capOf(p)) } })); }
  function dec(bc: string) { setCart((c) => { const q2 = (c[bc]?.qty ?? 0) - 1; const n = { ...c }; if (q2 <= 0) delete n[bc]; else n[bc] = { ...n[bc], qty: q2 }; return n; }); }
  async function reorder(o: Order) {
    try {
      const d = await patientApi<{ items: Product[] }>("/patient/shop");
      const by: Record<string, Product> = {}; d.items.forEach((p) => { by[p.barcode] = p; });
      const next: Record<string, { p: Product; qty: number }> = {}; let missing = 0;
      o.items.forEach((it) => { const p = by[it.barcode]; if (p && capOf(p) > 0) next[p.barcode] = { p, qty: Math.min(it.qty, capOf(p)) }; else missing++; });
      if (Object.keys(next).length === 0) { toast("Τα είδη δεν είναι διαθέσιμα αυτή τη στιγμή.", "error"); return; }
      setCart(next); setView("cart");
      if (missing) toast(`${missing} είδη δεν είναι πλέον διαθέσιμα και παραλείφθηκαν.`, "info");
    } catch { toast("Κάτι πήγε στραβά — δοκίμασε ξανά.", "error"); }
  }
  const camps = meta?.campaigns ?? [];
  const cartItems = Object.values(cart);
  const subtotal = cartItems.reduce((s, x) => s + final(x.p, camps) * x.qty, 0);
  const count = cartItems.reduce((s, x) => s + x.qty, 0);

  if (view === "subs") return <Subscriptions onBack={() => setView("browse")} />;
  if (view === "orders") return <Orders orders={orders} setOrders={setOrders} onBack={() => setView("browse")} onReorder={reorder} />;
  if (view === "cart") return <Checkout cart={cart} subtotal={subtotal} settings={meta?.settings} camps={camps} bundles={meta?.bundles ?? []} loyalty={meta?.loyalty} onBack={() => setView("browse")} onDone={() => { setCart({}); setView("orders"); }} dec={dec} add={add} />;
  if (view === "favorites") return <Favorites onBack={() => setView("browse")} favBarcodes={favBarcodes} toggleFav={toggleFav} add={add} cart={cart} dec={dec} camps={camps} />;

  const activeOrders = orders.filter((o) => !["delivered", "cancelled", "declined"].includes(o.status)).length;

  return (
    <div className="space-y-3">
      {/* Player οδηγιών χρήσης (YouTube/Vimeo embed) */}
      {video && (
        <div onClick={() => setVideo(null)} className="fixed inset-0 z-[130] grid place-items-center bg-black/70 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl overflow-hidden rounded-2xl bg-black shadow-2xl">
            <div className="flex items-center justify-between bg-slate-900 px-3 py-2 text-sm font-semibold text-white">🎬 Οδηγίες χρήσης<button onClick={() => setVideo(null)} className="rounded-lg px-2 py-0.5 text-slate-300 hover:bg-white/10">✕</button></div>
            <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
              <iframe src={video} title="Οδηγίες χρήσης" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className="absolute inset-0 h-full w-full" />
            </div>
          </div>
        </div>
      )}
      {/* ΚΑΛΑΘΙ — ευδιάκριτο, sticky πάνω-πάνω μόλις προσθέσεις είδος (πριν ήταν αόρατο) */}
      {count > 0 && (
        <button onClick={() => setView("cart")}
          /* top-[4.5rem]: ακριβώς κάτω από το sticky header (h-16) — αλλιώς το σκέπαζε */
          className="sticky top-[4.5rem] z-10 flex w-full items-center justify-between gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-3 text-white shadow-lg shadow-violet-500/30 ring-1 ring-white/20">
          <span className="flex items-center gap-2 text-sm font-bold">
            <span className="relative grid h-8 w-8 place-items-center rounded-xl bg-white/20">
              <ShoppingCart className="h-[18px] w-[18px]" />
              <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[20px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold">{count}</span>
            </span>
            Το καλάθι μου
          </span>
          <span className="flex items-center gap-2 text-sm font-extrabold">{eur(subtotal)} <span className="rounded-lg bg-white/20 px-2.5 py-1 text-xs">Ολοκλήρωση →</span></span>
        </button>
      )}
      {/* e-Κατάστημα — branding + εύκολη, ευδιάκριτη πρόσβαση στις παραγγελίες μου */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-500 text-white shadow-sm"><ShoppingBag className="h-5 w-5" /></span>
          <div className="leading-tight">
            <div className="text-lg font-extrabold tracking-tight text-slate-900">e-Κατάστημα</div>
            <div className="text-[11px] text-slate-400">Παράγγειλε online από το φαρμακείο σου</div>
          </div>
        </div>
        <button onClick={() => setView("orders")} className="relative inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-100">
          <Package className="h-4 w-4" /> <span className="hidden sm:inline">Οι παραγγελίες μου</span><span className="sm:hidden">Παραγγελίες</span>
          {activeOrders > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[20px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{activeOrders}</span>}
        </button>
      </div>
      {/* Αναζήτηση — ευδιάκριτη, μεγάλη· δίπλα οι «συνδρομές» */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση προϊόντος…" className="w-full rounded-2xl border border-slate-300 bg-white py-2.5 pl-11 pr-3 text-[15px] shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100" />
        </div>
        <button onClick={() => setView("favorites")} title="Τα αγαπημένα μου" className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-rose-200 bg-white text-rose-500 shadow-sm"><Heart className="h-5 w-5" /></button>
        {meta?.settings.subscription_enabled && <button onClick={() => setView("subs")} title="Οι συνδρομές μου" className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-violet-300 bg-white text-violet-600 shadow-sm"><RefreshCcw className="h-5 w-5" /></button>}
      </div>
      {/* Κατηγορία + ταξινόμηση σε ΜΙΑ συμπαγή σειρά (αντί για ~18 chips που γέμιζαν την οθόνη) */}
      <div className="flex items-center gap-2">
        {!!meta?.categories.length && (
          <div className="relative flex-1">
            <select value={cat} onChange={(e) => setCat(e.target.value)} className="w-full appearance-none rounded-xl border border-slate-200 bg-white py-2 pl-3 pr-8 text-sm font-medium text-slate-700 shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100">
              <option value="">🗂️ Όλες οι κατηγορίες</option>
              {meta.categories.map((c) => <option key={c} value={c}>{catEmoji(c)} {c}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        )}
        <div className="relative">
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="appearance-none rounded-xl border border-slate-200 bg-white py-2 pl-3 pr-8 text-sm text-slate-600 shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100">{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>
      </div>
      {/* Ετικέτες — μία κυλιόμενη σειρά (χωρίς αναδίπλωση) */}
      {!!meta?.tags?.length && (
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
          {meta.tags.map((tg) => <button key={tg} onClick={() => setTag(tag === tg ? "" : tg)} className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${tag === tg ? "bg-slate-800 text-white" : tagCls(tg)}`}>{tg}</button>)}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 pb-20 sm:grid-cols-3 sm:gap-3 sm:pb-6 lg:grid-cols-4 xl:grid-cols-5">
        {products.map((p) => {
          const med = isMed(p.type); const fc = final(p, camps); const inCart = cart[p.barcode]?.qty ?? 0;
          const dPct = effDisc(p, camps);
          return (
            <div key={p.barcode} className={`flex flex-col rounded-2xl border bg-white p-2.5 ${p.featured ? "border-amber-300 ring-1 ring-amber-100" : "border-slate-200"}`}>
              <div className="relative mb-1 grid h-24 place-items-center overflow-hidden rounded-xl bg-slate-50 sm:h-32">
                {imgSrc(p) ? <img src={imgSrc(p)} alt="" className="h-full w-full object-contain" /> : (med ? <Pill className="h-7 w-7 text-slate-300" /> : <Package className="h-7 w-7 text-slate-300" />)}
                {dPct > 0 && <span className="absolute left-1 top-1 rounded-md bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white">-{dPct}%</span>}
                {/* αγαπημένο προϊόν (καρδιά) — ειδοποιήσεις για πτώση τιμής / επιστροφή σε απόθεμα */}
                <button onClick={() => toggleFav(p.barcode)} title={favBarcodes.has(p.barcode) ? "Αφαίρεση αγαπημένου" : "Αγαπημένο"}
                  className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-white/90 shadow-sm">
                  <Heart className={`h-4 w-4 ${favBarcodes.has(p.barcode) ? "fill-rose-500 text-rose-500" : "text-slate-400"}`} />
                </button>
                {videoEmbed(p.usage_video_url) && <button onClick={() => setVideo(videoEmbed(p.usage_video_url))} title="Οδηγίες χρήσης" className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-black/85">▶ Οδηγίες</button>}
                {p.stock_qty > 0 && p.stock_qty <= LOW_STOCK && <span className="absolute bottom-1 left-1 rounded bg-orange-100 px-1.5 py-0.5 text-[9px] font-semibold text-orange-700">τελευταία {p.stock_qty}</span>}
                {isBackorder(p) && <span className="absolute bottom-1 left-1 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">Κατόπιν παραγγελίας</span>}
              </div>
              <div className="line-clamp-2 min-h-[2.2rem] text-xs font-semibold text-slate-800">{p.name}</div>
              {!!p.tags?.length && <div className="mt-0.5 flex flex-wrap gap-0.5">{p.tags.slice(0, 3).map((t) => <span key={t} className={`rounded px-1 py-0.5 text-[9px] font-semibold ${tagCls(t)}`}>{t}</span>)}</div>}
              <div className="mt-1 flex items-end justify-between">
                <div>
                  {fc < p.price_cents && <div className="text-[10px] text-slate-400 line-through">{eur(p.price_cents)}</div>}
                  <div className="text-sm font-bold text-slate-900">{eur(fc)}{dPct > 0 && <span className="ml-1 text-[10px] font-semibold text-emerald-600">-{dPct}%</span>}</div>
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

      {/* (Το πλωτό κάτω κουμπί καλαθιού αφαιρέθηκε: ήταν διπλό με το sticky πάνω και έπεφτε
          πάνω στην κάτω μπάρα πλοήγησης στο κινητό.) */}
    </div>
  );
}

function Checkout({ cart, subtotal, settings, camps, bundles, loyalty, onBack, onDone, dec, add }: {
  cart: Record<string, { p: Product; qty: number }>; subtotal: number; settings?: Settings;
  camps: Campaign[]; bundles: Bundle[]; loyalty?: Loyalty;
  onBack: () => void; onDone: () => void; dec: (bc: string) => void; add: (p: Product) => void;
}) {
  const items = Object.values(cart);
  const hasMed = items.some((x) => isMed(x.p.type));
  const hasBackorder = items.some((x) => isBackorder(x.p));
  const [mode, setMode] = useState<"delivery" | "pickup">(settings?.delivery_enabled ? "delivery" : "pickup");
  const [pay, setPay] = useState<"store" | "online">("store");
  const [addr, setAddr] = useState({ street: "", area: "", postal: "", phone: "", notes: "" });
  const [courier, setCourier] = useState(false);
  const [cauth, setCauth] = useState({ name: "", id_number: "" });   // εξουσιοδοτούμενος (μόνο για αποστολή)
  const [gdpr, setGdpr] = useState(false);
  const [repeat, setRepeat] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const belowMin = (settings?.min_order_cents ?? 0) > subtotal;
  const [coupon, setCoupon] = useState<AppliedCoupon | null>(null);
  const [couponIn, setCouponIn] = useState("");
  const [couponErr, setCouponErr] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [useP, setUseP] = useState(false);
  const [redeem, setRedeem] = useState(0);              // σε cents

  // ── Σειρά εκπτώσεων (ίδια με server): γραμμή → πακέτα → καλάθι(καλύτερο tier/κουπόνι) → πόντοι.
  // ΒΑΣΗ παντού: μόνο τα ΜΗ-συνταγογραφούμενα.
  const lines: CartLine[] = items.map((x) => ({ barcode: x.p.barcode, type: x.p.type, qty: x.qty, line_cents: final(x.p, camps) * x.qty }));
  const eligible0 = lines.filter((l) => !noDisc(l.type)).reduce((s, l) => s + l.line_cents, 0);
  const bs = bundleSavings(lines, bundles);
  const bundleCents = Math.min(bs.total, eligible0);
  const afterBundles = eligible0 - bundleCents;
  const td = tierDiscount(afterBundles, settings?.cart_tiers);
  const cCents = couponCentsOf(coupon, afterBundles);
  const useCoupon = cCents >= td.cents && cCents > 0;
  const cartCents = Math.min(useCoupon ? cCents : td.cents, afterBundles);
  const eligible = afterBundles - cartCents;           // ταβάνι για τους πόντους

  const canRedeem = !!loyalty?.enabled && !!loyalty?.member && loyalty.balance_cents > 0 && eligible > 0;
  const maxRedeem = Math.min(loyalty?.balance_cents ?? 0, eligible);
  const minRedeem = loyalty?.min_redeem_cents ?? 0;
  const redeemApplied = useP ? Math.min(redeem, maxRedeem) : 0;
  const baseForFee = subtotal - bundleCents - cartCents;
  const fee = mode === "delivery" ? (settings?.free_over_cents && baseForFee >= settings.free_over_cents ? 0 : (settings?.delivery_fee_cents ?? 0)) : 0;
  const total = Math.max(0, subtotal - bundleCents - cartCents + fee - redeemApplied);

  async function applyCoupon() {
    setCouponErr(""); setCouponBusy(true);
    try {
      const r = await patientApi<{ ok: boolean; error?: string; code?: string; kind?: "pct" | "amount"; value?: number; min_cents?: number }>(
        "/patient/shop/coupon/check", { method: "POST", body: JSON.stringify({ code: couponIn, eligible_cents: afterBundles }) });
      if (!r.ok) {
        setCoupon(null);
        setCouponErr({
          coupon_invalid: "Άκυρος κωδικός.", coupon_expired: "Το κουπόνι έληξε.",
          coupon_exhausted: "Το κουπόνι εξαντλήθηκε.",
          coupon_no_eligible_items: "Το κουπόνι δεν ισχύει σε συνταγογραφούμενα.",
          coupon_below_min: `Ελάχιστη αξία ${eur(r.min_cents ?? 0)}.`,
        }[r.error ?? ""] ?? "Άκυρος κωδικός.");
        return;
      }
      setCoupon({ code: r.code!, kind: r.kind!, value: r.value! });
      toast("Το κουπόνι εφαρμόστηκε!", "success");
    } catch { setCouponErr("Σφάλμα δικτύου."); } finally { setCouponBusy(false); }
  }

  async function place() {
    setErr(null);
    if (!gdpr) { setErr("Χρειάζεται η συγκατάθεση επεξεργασίας."); return; }
    if (mode === "delivery" && !courier) { setErr("Χρειάζεται η εξουσιοδότηση μεταφορέα."); return; }
    if (mode === "delivery" && courier && (cauth.name.trim().length < 3 || cauth.id_number.trim().length < 4)) {
      setErr("Συμπλήρωσε ονοματεπώνυμο & αρ. ταυτότητας/διαβατηρίου του εξουσιοδοτούμενου."); return;
    }
    if (mode === "delivery" && (!addr.street || !addr.area)) { setErr("Συμπλήρωσε διεύθυνση."); return; }
    if (redeemApplied > 0 && minRedeem && redeemApplied < minRedeem) { setErr(`Ελάχιστη εξαργύρωση ${eur(minRedeem)}.`); return; }
    setBusy(true);
    try {
      const r = await patientApi<{ ok: boolean; error?: string; payment?: string; checkout_url?: string }>("/patient/shop/order", { method: "POST", body: JSON.stringify({
        lines: items.map((x) => ({ barcode: x.p.barcode, qty: x.qty })),
        mode, address: mode === "delivery" ? addr : null, courier_authorized: courier,
        courier_auth: mode === "delivery" ? { name: cauth.name.trim(), id_number: cauth.id_number.trim() } : null,
        loyalty_redeem_cents: redeemApplied, coupon_code: useCoupon ? coupon?.code ?? null : null,
        gdpr_consent: gdpr, repeat_days: repeat,
        payment_method: pay === "online" ? "online" : (mode === "delivery" ? "cod" : "pickup"),
      }) });
      if (r.ok && r.payment === "viva" && r.checkout_url) { window.location.href = r.checkout_url; return; }  // κάρτα/IRIS
      if (r.ok) onDone(); else setErr("Σφάλμα: " + (r.error || "δοκίμασε ξανά"));
    } catch { setErr("Σφάλμα δικτύου."); } finally { setBusy(false); }
  }

  return (
    // Desktop: 2 στήλες — αριστερά είδη/παράδοση/στοιχεία, δεξιά «κολλημένο» το σύνολο & η ολοκλήρωση.
    <div className="pb-6">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500"><ChevronLeft className="h-4 w-4" /> Συνέχεια αγορών</button>
      <div className="mt-3 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-3">
      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        {items.map((x) => (
          <div key={x.p.barcode} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
            <div className="min-w-0"><div className="truncate text-sm font-medium text-slate-800">{x.p.name}</div><div className="text-xs text-slate-400">{eur(final(x.p, camps))} × {x.qty}</div></div>
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

      {/* τρόπος πληρωμής (online Viva = κάρτα/IRIS· αλλιώς στο κατάστημα/παράδοση) */}
      {settings?.online_payment_enabled && (
        <div>
          <div className="mb-1.5 text-xs font-semibold text-slate-500">Τρόπος πληρωμής</div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setPay("store")} className={`rounded-xl border p-3 text-sm font-medium ${pay === "store" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600"}`}>🏪 {mode === "delivery" ? "Με την παράδοση" : "Στο κατάστημα"}</button>
            <button onClick={() => setPay("online")} className={`rounded-xl border p-3 text-sm font-medium ${pay === "online" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600"}`}>💳 Online (κάρτα / IRIS)</button>
          </div>
        </div>
      )}

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

      {settings?.subscription_enabled && (
        <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-3">
          <div className="mb-1.5 text-sm font-semibold text-violet-900">🔁 Επανάληψη παραγγελίας</div>
          <select value={repeat} onChange={(e) => setRepeat(+e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {FREQ.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
          </select>
          {repeat > 0 && (settings.subscription_discount_pct > 0
            ? <p className="mt-1.5 text-xs font-semibold text-emerald-700">✓ Επιπλέον -{settings.subscription_discount_pct}% στα παραφάρμακα σε κάθε επανάληψη! Ακύρωση όποτε θες.</p>
            : <p className="mt-1.5 text-[11px] text-violet-600">Θα επαναλαμβάνεται αυτόματα — ακύρωση όποτε θες.</p>)}
        </div>
      )}

      {/* compliance: EU pharmacy certification + consents */}
      {hasMed && settings?.pps_cert && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><ShieldCheck className="h-4 w-4 shrink-0" /> Πιστοποιημένο φαρμακείο (ΠΦΣ): {settings.pps_cert}. Νόμιμη διάθεση ΜΗ.ΣΥ.ΦΑ. βάσει του κοινού λογοτύπου ΕΕ.</div>
      )}
      <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" checked={gdpr} onChange={(e) => setGdpr(e.target.checked)} className="mt-0.5" /> Συναινώ στην επεξεργασία των στοιχείων μου για την εκτέλεση της παραγγελίας (GDPR).</label>
      {mode === "delivery" && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" checked={courier} onChange={(e) => setCourier(e.target.checked)} className="mt-0.5" /> Εξουσιοδοτώ τον μεταφορέα να παραλάβει και να μου παραδώσει την παραγγελία στη διεύθυνσή μου.</label>
          {courier && (
            <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50/60 p-3">
              <div className="text-sm font-semibold text-amber-900">Στοιχεία εξουσιοδοτούμενου</div>
              <p className="text-[11px] text-amber-800">Το άτομο που εξουσιοδοτείς να παραλάβει τα φάρμακα για λογαριασμό σου. Θα ζητηθεί ταυτοποίηση κατά την παράδοση.</p>
              <input value={cauth.name} onChange={(e) => setCauth({ ...cauth, name: e.target.value })} placeholder="Ονοματεπώνυμο εξουσιοδοτούμενου" className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm" />
              <input value={cauth.id_number} onChange={(e) => setCauth({ ...cauth, id_number: e.target.value })} placeholder="Αρ. ταυτότητας ή διαβατηρίου" className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm" />
            </div>
          )}
        </div>
      )}

      </div>{/* ── τέλος αριστερής στήλης ── */}

      {/* ── δεξιά στήλη: προσφορές + σύνολο + ολοκλήρωση (sticky σε desktop) ── */}
      <div className="space-y-3 lg:sticky lg:top-20">
      {/* Κουπόνι έκπτωσης */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="mb-1.5 text-sm font-semibold text-slate-700">🎟️ Κουπόνι έκπτωσης</div>
        {coupon ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-violet-50 px-3 py-2">
            <span className="text-sm text-violet-800">Ενεργό: <code className="font-bold">{coupon.code}</code> {coupon.kind === "pct" ? `(−${coupon.value}%)` : `(−${eur(coupon.value)})`}</span>
            <button onClick={() => { setCoupon(null); setCouponIn(""); }} className="text-xs font-semibold text-slate-400">Αφαίρεση</button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input value={couponIn} onChange={(e) => setCouponIn(e.target.value.toUpperCase())} placeholder="Κωδικός" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm uppercase" />
            <button onClick={applyCoupon} disabled={couponIn.trim().length < 3 || couponBusy} className="shrink-0 rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{couponBusy ? "…" : "Εφαρμογή"}</button>
          </div>
        )}
        {couponErr && <div className="mt-1.5 text-xs text-rose-600">{couponErr}</div>}
        {coupon && !useCoupon && cartCents > 0 && <div className="mt-1.5 text-[11px] text-amber-700">Η κλιμακωτή έκπτωση ({td.pct}%) σε συμφέρει περισσότερο — εφαρμόστηκε αυτή.</div>}
      </div>

      {/* Εξαργύρωση πόντων — ΜΟΝΟ σε μη-συνταγογραφούμενα (τα συνταγογραφούμενα εξαιρούνται) */}
      {canRedeem && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3">
          <label className="flex items-start gap-2 text-sm font-semibold text-emerald-900">
            <input type="checkbox" checked={useP} onChange={(e) => { setUseP(e.target.checked); setRedeem(e.target.checked ? maxRedeem : 0); }} className="mt-0.5" />
            🎁 Χρήση πόντων — διαθέσιμα {eur(loyalty!.balance_cents)}
          </label>
          {useP && (
            <div className="mt-2 space-y-1.5">
              <input type="range" min={0} max={maxRedeem} step={10} value={Math.min(redeem, maxRedeem)}
                onChange={(e) => setRedeem(+e.target.value)} className="w-full accent-emerald-600" />
              <div className="flex items-center justify-between text-xs text-emerald-800">
                <span>Εξαργύρωση: <b>{eur(redeemApplied)}</b></span>
                <button type="button" onClick={() => setRedeem(maxRedeem)} className="rounded-lg bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">Μέγιστο ({eur(maxRedeem)})</button>
              </div>
              <p className="text-[10px] text-emerald-700">Οι πόντοι ισχύουν μόνο για μη συνταγογραφούμενα είδη — εδώ έως {eur(eligible)}.{minRedeem ? ` Ελάχιστη εξαργύρωση ${eur(minRedeem)}.` : ""}</p>
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
        <div className="flex justify-between text-slate-600"><span>Υποσύνολο</span><span>{eur(subtotal)}</span></div>
        {bundleCents > 0 && <div className="flex justify-between font-semibold text-emerald-700"><span>📦 {bs.names.join(", ")}</span><span>−{eur(bundleCents)}</span></div>}
        {cartCents > 0 && <div className="flex justify-between font-semibold text-violet-700"><span>{useCoupon ? `🎟️ Κουπόνι ${coupon?.code}` : `📈 Έκπτωση καλαθιού (${td.pct}%)`}</span><span>−{eur(cartCents)}</span></div>}
        {mode === "delivery" && <div className="flex justify-between text-slate-600"><span>Μεταφορικά</span><span>{fee === 0 ? "Δωρεάν" : eur(fee)}</span></div>}
        {redeemApplied > 0 && <div className="flex justify-between font-semibold text-emerald-700"><span>🎁 Πόντοι επιβράβευσης</span><span>−{eur(redeemApplied)}</span></div>}
        <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 text-base font-bold text-slate-900"><span>Σύνολο</span><span>{eur(total)}</span></div>
        <p className="mt-1 text-[11px] text-slate-400">Πληρωμή κατά την παράδοση/παραλαβή. Τα φάρμακα δεν επιστρέφονται.</p>
      </div>

      {(() => {   // κίνητρο: πόσο λείπει για την επόμενη κλίμακα έκπτωσης
        const next = (settings?.cart_tiers ?? []).filter((t) => afterBundles < t.min_cents).sort((a, b) => a.min_cents - b.min_cents)[0];
        return next ? <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">📈 Πρόσθεσε <b>{eur(next.min_cents - afterBundles)}</b> ακόμη σε μη-συνταγογραφούμενα και κερδίζεις <b>−{next.pct}%</b> στο καλάθι!</div> : null;
      })()}
      {hasBackorder && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">📦 Κάποια είδη είναι <b>κατόπιν παραγγελίας</b>. Η παραγγελία θα σταλεί στο φαρμακείο για <b>έγκριση</b> — θα σου δηλώσει πότε θα είναι διαθέσιμα.</div>}
      {belowMin && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">Ελάχιστη παραγγελία {eur(settings?.min_order_cents ?? 0)}.</div>}
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      <button onClick={place} disabled={busy || belowMin} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 font-semibold text-white disabled:opacity-50">
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null} {hasBackorder ? "Αποστολή για έγκριση" : "Ολοκλήρωση παραγγελίας"} · {eur(total)}
      </button>
      </div>{/* ── τέλος δεξιάς στήλης ── */}
      </div>
    </div>
  );
}

const STEPS_DELIVERY = ["Καταχωρήθηκε", "Ετοιμάζεται", "Καθ' οδόν", "Παραδόθηκε"];
const STEPS_PICKUP = ["Καταχωρήθηκε", "Ετοιμάζεται", "Έτοιμη", "Παραλήφθηκε"];
const STEP_OF: Record<string, number> = { new: 0, preparing: 1, shipped: 2, ready: 2, delivered: 3 };

function Stepper({ steps, cur }: { steps: string[]; cur: number }) {
  return (
    <div className="flex items-start px-1 pt-3">
      {steps.map((s, i) => (
        <Fragment key={i}>
          <div className="flex flex-1 flex-col items-center">
            <div className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${i < cur ? "bg-emerald-500 text-white" : i === cur ? "bg-violet-600 text-white ring-4 ring-violet-100" : "bg-slate-100 text-slate-400"}`}>
              {i < cur ? <Check className="h-4 w-4" /> : i + 1}
            </div>
            <span className={`mt-1 text-center text-[10px] leading-tight ${i <= cur ? "font-medium text-slate-700" : "text-slate-400"}`}>{s}</span>
          </div>
          {i < steps.length - 1 && <div className={`mt-3.5 h-0.5 flex-1 ${i < cur ? "bg-emerald-500" : "bg-slate-200"}`} />}
        </Fragment>
      ))}
    </div>
  );
}

function OrderCard({ o, onReorder }: { o: Order; onReorder?: (o: Order) => void }) {
  const [open, setOpen] = useState(false);
  const steps = o.mode === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP;
  const cur = STEP_OF[o.status] ?? 0;
  const cancelled = o.status === "cancelled";
  const declined = o.status === "declined";
  const pending = o.status === "pending";
  const dead = cancelled || declined;
  const done = o.status === "delivered";
  return (
    <div className={`overflow-hidden rounded-2xl border bg-white ${dead ? "border-slate-200 opacity-70" : done ? "border-emerald-200" : pending ? "border-amber-300" : "border-violet-200"}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-2 p-3 text-left">
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          {o.mode === "delivery" ? <Truck className="h-4 w-4 text-violet-500" /> : <Store className="h-4 w-4 text-sky-500" />}
          {eur(o.total_cents)} <span className="text-xs font-normal text-slate-400">· {o.items.length} είδη</span>
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${dead ? "bg-slate-200 text-slate-500" : done ? "bg-emerald-100 text-emerald-700" : pending ? "bg-amber-100 text-amber-800" : "bg-violet-100 text-violet-700"}`}>{ST[o.status] ?? o.status}</span>
      </button>

      {pending ? (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-amber-700">⏳ Κατόπιν παραγγελίας — αναμονή έγκρισης & ημερομηνίας από το φαρμακείο.</div>
      ) : declined ? (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-rose-600"><XCircle className="h-4 w-4" /> Το φαρμακείο δεν μπόρεσε να εκτελέσει την παραγγελία.</div>
      ) : cancelled ? (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-rose-600"><XCircle className="h-4 w-4" /> Η παραγγελία ακυρώθηκε.</div>
      ) : <div className="px-3 pb-2"><Stepper steps={steps} cur={cur} />{o.available_date && <div className="mt-1 text-center text-[11px] font-medium text-emerald-700">📦 Διαθέσιμο ~{new Date(o.available_date).toLocaleDateString("el-GR")}</div>}</div>}

      {(done || dead) && onReorder && (
        <div className="px-3 pb-3">
          <button onClick={() => onReorder(o)} className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-700">
            <ShoppingCart className="h-3.5 w-3.5" /> Παράγγειλε ξανά
          </button>
        </div>
      )}

      {open && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-2.5 text-sm">
          <div className="space-y-0.5">
            {o.items.map((it, i) => (
              <div key={i} className="flex justify-between text-slate-600">
                <span>{it.qty}× {it.name}{it.discount_pct ? <span className="ml-1 text-emerald-600">-{it.discount_pct}%</span> : null}{it.backorder ? <span className="ml-1 text-amber-600">· κατόπιν παραγγελίας</span> : null}</span>
                <span>{eur(it.line_cents)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-100 pt-1 text-xs text-slate-500">
            <div className="flex justify-between"><span>Υποσύνολο</span><span>{eur(o.subtotal_cents)}</span></div>
            {o.mode === "delivery" && <div className="flex justify-between"><span>Μεταφορικά</span><span>{o.delivery_fee_cents ? eur(o.delivery_fee_cents) : "Δωρεάν"}</span></div>}
            <div className="flex justify-between font-bold text-slate-800"><span>Σύνολο</span><span>{eur(o.total_cents)}</span></div>
          </div>
          {o.mode === "delivery" && o.address && (
            <div className="flex items-start gap-1.5 rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs text-violet-800">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {o.address.street}, {o.address.area} {o.address.postal}
            </div>
          )}
          <div className="text-[11px] text-slate-400">Παραγγέλθηκε {new Date(o.created_at).toLocaleString("el-GR")}</div>
        </div>
      )}
    </div>
  );
}

type FavProduct = Product & { price_at_add?: number | null; price_dropped?: boolean; back_in_stock?: boolean };
function Favorites({ onBack, favBarcodes, toggleFav, add, cart, dec, camps }: {
  onBack: () => void; favBarcodes: Set<string>; toggleFav: (bc: string) => void;
  add: (p: Product) => void; cart: Record<string, { p: Product; qty: number }>; dec: (bc: string) => void;
  camps: Campaign[];
}) {
  const [items, setItems] = useState<FavProduct[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { patientApi<{ items: FavProduct[] }>("/patient/shop/favorites").then((d) => setItems(d.items)).catch(() => {}).finally(() => setLoading(false)); }, []);
  const shown = items.filter((p) => favBarcodes.has(p.barcode));   // κρύψε αυτά που μόλις αφαίρεσε
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500"><ChevronLeft className="h-4 w-4" /> Στο e-Κατάστημα</button>
      <div className="flex items-center gap-1.5 text-base font-bold text-slate-800"><Heart className="h-4 w-4 fill-rose-500 text-rose-500" /> Τα αγαπημένα μου</div>
      <p className="text-xs text-slate-400">Σε ειδοποιούμε για <b>πτώση τιμής</b> ή <b>επιστροφή σε απόθεμα</b> (στις Ειδοποιήσεις της Αρχικής).</p>
      {loading && <div className="py-8 text-center text-sm text-slate-400">Φόρτωση…</div>}
      {!loading && shown.length === 0 && <div className="py-10 text-center text-sm text-slate-400"><Heart className="mx-auto mb-2 h-8 w-8 text-slate-300" />Δεν έχεις αγαπημένα ακόμη. Πάτα την ❤️ σε ένα προϊόν.</div>}
      {shown.map((p) => {
        const fc = final(p, camps); const inCart = cart[p.barcode]?.qty ?? 0;
        return (
          <div key={p.barcode} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-50">{imgSrc(p) ? <img src={imgSrc(p)} alt="" className="h-full w-full object-contain" /> : <Pill className="h-5 w-5 text-slate-300" />}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-slate-800">{p.name}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-bold text-slate-900">{eur(fc)}</span>
                {p.price_dropped && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">↓ πτώση τιμής</span>}
                {p.back_in_stock && <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">📦 διαθέσιμο</span>}
                {isBackorder(p) && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">κατόπιν παραγγελίας</span>}
              </div>
            </div>
            <button onClick={() => toggleFav(p.barcode)} title="Αφαίρεση" className="grid h-8 w-8 shrink-0 place-items-center"><Heart className="h-[18px] w-[18px] fill-rose-500 text-rose-500" /></button>
            {inCart ? (
              <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-violet-600 px-1 text-white">
                <button onClick={() => dec(p.barcode)} className="grid h-6 w-6 place-items-center"><Minus className="h-3.5 w-3.5" /></button>
                <span className="text-xs font-bold">{inCart}</span>
                <button onClick={() => add(p)} className="grid h-6 w-6 place-items-center"><Plus className="h-3.5 w-3.5" /></button>
              </div>
            ) : <button onClick={() => add(p)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white"><Plus className="h-4 w-4" /></button>}
          </div>
        );
      })}
    </div>
  );
}

function Subscriptions({ onBack }: { onBack: () => void }) {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() { try { const d = await patientApi<{ items: Sub[] }>("/patient/shop/subscriptions"); setSubs(d.items); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);
  async function cancel(id: string) { if (!(await confirmDialog("Να ακυρωθεί η συνδρομή;"))) return; await patientApi(`/patient/shop/subscriptions/${id}/cancel`, { method: "POST" }); load(); }
  const freq = (d: number) => FREQ.find(([n]) => n === d)?.[1] ?? `κάθε ${d} ημέρες`;
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500"><ChevronLeft className="h-4 w-4" /> Στο κατάστημα</button>
      <div className="text-base font-bold text-slate-800">Οι συνδρομές μου</div>
      {loading && <div className="py-8 text-center text-sm text-slate-400">Φόρτωση…</div>}
      {!loading && subs.length === 0 && <div className="py-10 text-center text-sm text-slate-400"><RefreshCcw className="mx-auto mb-2 h-8 w-8 text-slate-300" />Δεν έχεις ενεργές συνδρομές. Φτιάξε μία στο checkout επιλέγοντας «Επανάληψη».</div>}
      {subs.map((s) => {
        const lines = s.lines ?? s.items ?? [];
        return (
          <div key={s._id} className="rounded-2xl border border-violet-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-violet-800"><RefreshCcw className="h-4 w-4" /> {freq(s.interval_days)}</span>
              <button onClick={() => cancel(s._id)} className="text-xs font-medium text-rose-600 hover:underline">Ακύρωση</button>
            </div>
            <div className="mt-1 text-xs text-slate-500">{lines.length} είδη · {s.mode === "delivery" ? "Αποστολή" : "Παραλαβή"}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">Επόμενη παραγγελία: {new Date(s.next_run).toLocaleDateString("el-GR")}</div>
          </div>
        );
      })}
    </div>
  );
}

function Orders({ orders, setOrders, onBack, onReorder }: { orders: Order[]; setOrders: (o: Order[]) => void; onBack: () => void; onReorder: (o: Order) => void }) {
  const [oview, setOView] = useState<"active" | "history">("active");
  useEffect(() => {
    patientApi<{ items: Order[] }>("/patient/shop/orders").then((d) => setOrders(d.items)).catch(() => {});
    const id = window.setInterval(() => patientApi<{ items: Order[] }>("/patient/shop/orders").then((d) => setOrders(d.items)).catch(() => {}), 20000);
    return () => window.clearInterval(id);
  }, [setOrders]);
  const active = orders.filter((o) => !["delivered", "cancelled", "declined"].includes(o.status));
  const past = orders.filter((o) => ["delivered", "cancelled", "declined"].includes(o.status));
  const list = oview === "active" ? active : past;
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500"><ChevronLeft className="h-4 w-4" /> Στο e-Κατάστημα</button>
      <div className="text-base font-bold text-slate-800">Οι παραγγελίες μου</div>
      {/* Διαχωρισμός: ΕΝΕΡΓΕΣ vs ΙΣΤΟΡΙΚΟ */}
      <div className="flex gap-1.5 rounded-xl bg-slate-100 p-1">
        {([["active", "Ενεργές", active.length], ["history", "Ιστορικό", past.length]] as const).map(([k, label, n]) => (
          <button key={k} onClick={() => setOView(k)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-semibold transition ${oview === k ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}>
            {label}<span className={`grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[10px] font-bold ${oview === k ? (k === "active" ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-600") : "bg-slate-200 text-slate-500"}`}>{n}</span>
          </button>
        ))}
      </div>
      {orders.length === 0 && <div className="py-10 text-center text-sm text-slate-400"><PackageCheck className="mx-auto mb-2 h-8 w-8 text-slate-300" />Δεν έχεις παραγγελίες ακόμη.</div>}
      {orders.length > 0 && list.length === 0 && (
        <div className="py-10 text-center text-sm text-slate-400">
          {oview === "active" ? <><Package className="mx-auto mb-2 h-8 w-8 text-slate-300" />Καμία ενεργή παραγγελία.</> : <><PackageCheck className="mx-auto mb-2 h-8 w-8 text-slate-300" />Δεν υπάρχει ιστορικό ακόμη.</>}
        </div>
      )}
      {list.length > 0 && <div className="space-y-2">{list.map((o) => <OrderCard key={o._id} o={o} onReorder={onReorder} />)}</div>}
    </div>
  );
}
