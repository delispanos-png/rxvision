"use client";

import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Search, ShoppingCart, ShoppingBag, Plus, Minus, Trash2, Truck, Store, ShieldCheck, Pill, Package, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Loader2, MapPin, Check, XCircle, PackageCheck, RefreshCcw, Star, Heart, Flame, Sparkles, CalendarCheck, SlidersHorizontal } from "lucide-react";
import { patientApi, API_BASE } from "@/lib/patientClient";
import { toast, confirmDialog } from "@/components/portal/Toaster";
import { DateInput } from "@/components/ui/DateInput";
import { useT } from "@/store/prefStore";

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

type Product = { barcode: string; name: string; description_short?: string | null; description_long?: string | null; photo_url?: string | null; image_id?: string | null; images?: string[]; usage_video_url?: string | null; price_cents: number; type: string; category?: string | null; tags?: string[]; featured?: boolean; discount_pct: number; stock_qty: number; sale_starts_at?: string | null; sale_ends_at?: string | null; highlights?: string[]; points_multiplier?: number; related_barcodes?: string[]; related?: Product[]; eff_discount_pct?: number; sale_cents?: number };
type Cat = { id: string; name: string; parent_id: string | null; level: number; image_id?: string | null; icon?: string | null };

// Μενού-πλακίδια πύλης από το δέντρο κατηγοριών e-shop (3 επίπεδα). Οι μετρήσεις (category_counts)
// είναι ΗΔΗ αθροιστικές του υποδέντρου (κάθε είδος μετρά στα cat1/cat2/cat3 του) → κρύβει άδεια κλαδιά.
function CategoryTiles({ tree, counts, path, setPath }: { tree: Cat[]; counts: Record<string, number>; path: Cat[]; setPath: (p: Cat[]) => void }) {
  const t = useT();
  const cur = path[path.length - 1];
  const level = (cur?.level ?? 0) + 1;
  const parentId = cur?.id ?? null;
  const kids = tree.filter((c) => c.level === level && (level === 1 || c.parent_id === parentId) && (counts[c.id] ?? 0) > 0);
  if (kids.length === 0) return null;   // φύλλο (χωρίς παιδιά) ή χωρίς δέντρο → τίποτα να δείξω
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
      {kids.map((c) => (
        <button key={c.id} onClick={() => setPath([...path, c])} className="group flex flex-col items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 shadow-sm transition hover:border-violet-300 hover:shadow">
          <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-50 dark:bg-slate-900">
            {c.image_id ? <img src={`${API_BASE}/catalog/image/${c.image_id}`} alt="" className="h-full w-full object-cover" /> : <span className="text-2xl">{c.icon || catEmoji(c.name)}</span>}
          </span>
          <span className="line-clamp-2 text-center text-[11px] font-medium leading-tight text-slate-700 dark:text-slate-200">{c.name}</span>
          <span className="text-[10px] text-slate-400">{counts[c.id]} {t("είδη", "items")}</span>
        </button>
      ))}
    </div>
  );
}

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
type Settings = { delivery_enabled: boolean; pickup_enabled: boolean; delivery_fee_cents: number; free_over_cents: number; min_order_cents: number; pps_cert: string; subscription_enabled: boolean; subscription_discount_pct: number; cart_tiers?: Tier[]; online_payment_enabled?: boolean; hero_enabled?: boolean; hero_image_id?: string | null; hero_title?: string; hero_subtitle?: string };
type BundleLine = { barcode: string; qty: number };
type Bundle = { name: string; kind: "combo" | "nplusm"; barcode?: string | null; buy_qty?: number; free_qty?: number; lines?: BundleLine[]; discount_pct?: number };
const LOW_STOCK = 5;
const imgSrc = (p: Product) => p.image_id ? `${API_BASE}/catalog/image/${p.image_id}` : (p.photo_url || "");
// Πλήρες gallery (κύρια + επιπλέον)· dedup, ώστε το PDP να δείχνει όλες τις εικόνες.
const imgList = (p: Product): string[] => {
  const ids = [p.image_id, ...(p.images ?? [])].filter(Boolean) as string[];
  const urls = ids.map((id) => `${API_BASE}/catalog/image/${id}`);
  if (!urls.length && p.photo_url) urls.push(p.photo_url);
  return Array.from(new Set(urls));
};
const TAG_STYLE: Record<string, string> = { "Προσφορά": "bg-rose-100 text-rose-700", "Νέο": "bg-emerald-100 text-emerald-700", "Δημοφιλές": "bg-amber-100 text-amber-800", "Bestseller": "bg-amber-100 text-amber-800", "Βιολογικό": "bg-green-100 text-green-700", "Vegan": "bg-green-100 text-green-700" };
const tagCls = (t: string) => TAG_STYLE[t] || "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300";
const SORTS: [string, string, string][] = [["featured", "Προτεινόμενα", "Recommended"], ["on_sale", "Σε προσφορά", "On sale"], ["newest", "Νεότερα", "Newest"], ["price_asc", "Φθηνότερα", "Price: low to high"], ["price_desc", "Ακριβότερα", "Price: high to low"]];
type SubLine = { barcode: string; qty: number; name?: string; image_id?: string | null; type?: string; price_cents?: number; unit_cents?: number; line_cents?: number; discount_pct?: number };
type Sub = { _id: string; items?: SubLine[]; lines?: SubLine[]; mode: string; interval_days: number; next_run: string; subtotal_cents?: number };
const FREQ: [number, string, string][] = [[0, "Όχι", "No"], [14, "Κάθε 2 εβδομάδες", "Every 2 weeks"], [30, "Κάθε μήνα", "Every month"], [60, "Κάθε 2 μήνες", "Every 2 months"], [90, "Κάθε 3 μήνες", "Every 3 months"]];
type OrderItem = { barcode: string; name: string; qty: number; line_cents: number; discount_pct?: number; backorder?: boolean };
type OrderAddr = { street?: string; area?: string; postal?: string; phone?: string; notes?: string } | null;
type Order = { _id: string; items: OrderItem[]; subtotal_cents: number; delivery_fee_cents: number; total_cents: number; mode: string; status: string; created_at: string; address?: OrderAddr; has_backorder?: boolean; available_date?: string | null; payment_method?: string | null; note?: string | null };
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
const ST: Record<string, [string, string]> = { pending: ["Σε αναμονή έγκρισης", "Awaiting approval"], new: ["Νέα", "New"], preparing: ["Ετοιμάζεται", "Preparing"], ready: ["Έτοιμη", "Ready"], shipped: ["Καθ' οδόν", "On the way"], delivered: ["Παραδόθηκε", "Delivered"], declined: ["Απορρίφθηκε", "Declined"], cancelled: ["Ακυρώθηκε", "Cancelled"] };

export function ShopTab({ tenantKey = "x" }: { tenantKey?: string }) {
  const t = useT();
  const CART_KEY = `rxv_cart_${tenantKey}`;
  const [view, setView] = useState<"browse" | "cart" | "orders" | "subs" | "favorites" | "offers">("browse");
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  // «↑ Πάνω» — η πύλη scrollάρει τον container #portal-scroll (όχι το window)
  const [showTop, setShowTop] = useState(false);
  useEffect(() => {
    const el = document.getElementById("portal-scroll");
    if (!el) return;
    const onScroll = () => setShowTop(el.scrollTop > 700);
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const scrollTop = () => {
    const el = document.getElementById("portal-scroll");
    try { el?.scrollTo({ top: 0, behavior: "smooth" }); } catch { if (el) el.scrollTop = 0; }
  };
  const [video, setVideo] = useState<string | null>(null);   // embed URL οδηγιών χρήσης
  const [pdp, setPdp] = useState<Product | null>(null);       // σελίδα προϊόντος (detail modal)
  const [favBarcodes, setFavBarcodes] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [catPath, setCatPath] = useState<Cat[]>([]);   // επιλογή στο δέντρο κατηγοριών (μενού-πλακίδια)
  const [tag, setTag] = useState("");
  const [brand, setBrand] = useState("");              // φίλτρο μάρκας (facet «πρώτη λέξη ονόματος»)
  const [showFilters, setShowFilters] = useState(false);   // ενιαίο drawer «Φίλτρα»
  const [sort, setSort] = useState("featured");
  const [meta, setMeta] = useState<{ categories: string[]; tags: string[]; brands?: string[]; settings: Settings; campaigns?: Campaign[]; bundles?: Bundle[]; loyalty?: Loyalty; category_tree?: Cat[]; category_counts?: Record<string, number>; free_shipping_at?: number; auto_order_discounts?: { name: string; value_type: string; value: number; min_cents: number; min_qty: number }[] } | null>(null);
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
  useEffect(() => { patientApi<{ categories: string[]; tags: string[]; settings: Settings; campaigns?: Campaign[]; bundles?: Bundle[]; loyalty?: Loyalty; category_tree?: Cat[]; category_counts?: Record<string, number>; free_shipping_at?: number; auto_order_discounts?: { name: string; value_type: string; value: number; min_cents: number; min_qty: number }[] }>("/patient/shop/meta").then(setMeta).catch(() => {}); }, []);
  // Φόρτωσε τις παραγγελίες στην αρχή ώστε το κουμπί «Οι παραγγελίες μου» να δείχνει badge ενεργών.
  useEffect(() => { patientApi<{ items: Order[] }>("/patient/shop/orders").then((d) => setOrders(d.items)).catch(() => {}); }, []);
  useEffect(() => { patientApi<{ barcodes: string[] }>("/patient/shop/favorites").then((d) => setFavBarcodes(new Set(d.barcodes))).catch(() => {}); }, []);
  async function toggleFav(barcode: string) {
    setFavBarcodes((s) => { const n = new Set(s); if (n.has(barcode)) n.delete(barcode); else n.add(barcode); return n; });
    try { await patientApi("/patient/shop/favorite", { method: "POST", body: JSON.stringify({ barcode }) }); } catch { /* ignore */ }
  }
  const hasTree = (meta?.category_tree?.length ?? 0) > 0;
  const shopQuery = (pg: number) => {
    const p = new URLSearchParams({ q, tag, sort, page: String(pg) });
    if (brand) p.set("brand", brand);
    if (hasTree) {   // δέντρο κατηγοριών: το πιο συγκεκριμένο επίπεδο του μονοπατιού
      if (catPath[0]) p.set("cat1", catPath[0].id);
      if (catPath[1]) p.set("cat2", catPath[1].id);
      if (catPath[2]) p.set("cat3", catPath[2].id);
    } else if (cat) { p.set("category", cat); }
    return p.toString();
  };
  useEffect(() => {   // αλλαγή φίλτρου → σελίδα 1 (αντικατάσταση)
    const tmo = setTimeout(() => {
      patientApi<{ items: Product[]; total: number }>(`/patient/shop?${shopQuery(1)}`)
        .then((d) => { setProducts(d.items); setTotal(d.total ?? d.items.length); setPage(1); }).catch(() => {});
    }, 250);
    return () => clearTimeout(tmo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cat, tag, sort, catPath, hasTree, brand]);
  async function loadMore() {   // «φόρτωσε περισσότερα» → επόμενη σελίδα (προσθήκη)
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const d = await patientApi<{ items: Product[]; total: number }>(`/patient/shop?${shopQuery(next)}`);
      setProducts((prev) => [...prev, ...d.items]); setTotal(d.total ?? 0); setPage(next);
    } catch { /* ignore */ } finally { setLoadingMore(false); }
  }

  function add(p: Product) {
    setCart((c) => ({ ...c, [p.barcode]: { p, qty: Math.min((c[p.barcode]?.qty ?? 0) + 1, capOf(p)) } }));
    if (p.type === "rx_medicine") toast(t("Τα συνταγογραφούμενα φάρμακα ΔΕΝ αποστέλλονται με courier — μόνο παραλαβή από το φαρμακείο (κατόπιν έγκρισης).", "Prescription medicines are NOT shipped by courier — pharmacy pickup only (after approval)."), "info");
  }
  function dec(bc: string) { setCart((c) => { const q2 = (c[bc]?.qty ?? 0) - 1; const n = { ...c }; if (q2 <= 0) delete n[bc]; else n[bc] = { ...n[bc], qty: q2 }; return n; }); }
  async function reorder(o: Order) {
    try {
      const d = await patientApi<{ items: Product[] }>("/patient/shop");
      const by: Record<string, Product> = {}; d.items.forEach((p) => { by[p.barcode] = p; });
      const next: Record<string, { p: Product; qty: number }> = {}; let missing = 0;
      o.items.forEach((it) => { const p = by[it.barcode]; if (p && capOf(p) > 0) next[p.barcode] = { p, qty: Math.min(it.qty, capOf(p)) }; else missing++; });
      if (Object.keys(next).length === 0) { toast(t("Τα είδη δεν είναι διαθέσιμα αυτή τη στιγμή.", "These items are not available right now."), "error"); return; }
      setCart(next); setView("cart");
      if (missing) toast(t(`${missing} είδη δεν είναι πλέον διαθέσιμα και παραλείφθηκαν.`, `${missing} item(s) are no longer available and were skipped.`), "info");
    } catch { toast(t("Κάτι πήγε στραβά — δοκίμασε ξανά.", "Something went wrong — please try again."), "error"); }
  }
  const camps = meta?.campaigns ?? [];
  const cartItems = Object.values(cart);
  const subtotal = cartItems.reduce((s, x) => s + final(x.p, camps) * x.qty, 0);
  const count = cartItems.reduce((s, x) => s + x.qty, 0);
  const filterCount = (catPath.length > 0 ? 1 : 0) + (cat ? 1 : 0) + (brand ? 1 : 0) + (tag ? 1 : 0) + (sort !== "featured" ? 1 : 0);
  const clearFilters = () => { setCatPath([]); setCat(""); setBrand(""); setTag(""); setSort("featured"); };

  // Overlays (video + PDP) — αποσπασμένα ώστε να λειτουργούν & στο καλάθι/αγαπημένα (όχι μόνο στην περιήγηση)
  const modals = (
    <>
      {video && (
        <div onClick={() => setVideo(null)} className="fixed inset-0 z-[130] grid place-items-center bg-black/70 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl overflow-hidden rounded-2xl bg-black shadow-2xl">
            <div className="flex items-center justify-between bg-slate-900 px-3 py-2 text-sm font-semibold text-white">🎬 {t("Οδηγίες χρήσης", "Usage instructions")}<button onClick={() => setVideo(null)} className="rounded-lg px-2 py-0.5 text-slate-300 hover:bg-white/10">✕</button></div>
            <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
              <iframe src={video} title={t("Οδηγίες χρήσης", "Usage instructions")} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className="absolute inset-0 h-full w-full" />
            </div>
          </div>
        </div>
      )}
      {pdp && <ProductModal product={pdp} camps={camps} inCart={cart[pdp.barcode]?.qty ?? 0} add={add} dec={dec} onClose={() => setPdp(null)} onVideo={(u) => setVideo(u)} isFav={favBarcodes.has(pdp.barcode)} toggleFav={toggleFav} />}
    </>
  );

  if (view === "subs") return <>{modals}<Subscriptions onBack={() => setView("browse")} /></>;
  if (view === "orders") return <>{modals}<Orders orders={orders} setOrders={setOrders} onBack={() => setView("browse")} onReorder={reorder} /></>;
  if (view === "cart") return <>{modals}<Checkout cart={cart} subtotal={subtotal} settings={meta?.settings} camps={camps} bundles={meta?.bundles ?? []} loyalty={meta?.loyalty} onBack={() => setView("browse")} onDone={() => { setCart({}); setView("orders"); }} dec={dec} add={add} openProduct={setPdp} /></>;
  if (view === "favorites") return <>{modals}<Favorites onBack={() => setView("browse")} favBarcodes={favBarcodes} toggleFav={toggleFav} add={add} cart={cart} dec={dec} camps={camps} openProduct={setPdp} /></>;
  if (view === "offers") return <>{modals}<Offers onBack={() => setView("browse")} add={add} goCart={() => setView("cart")} cartCount={count} onBrowse={(f) => { clearFilters(); if (f.sort) setSort(f.sort); if (f.brand) setBrand(f.brand); if (f.tag) setTag(f.tag); setView("browse"); }} /></>;

  const activeOrders = orders.filter((o) => !["delivered", "cancelled", "declined"].includes(o.status)).length;

  return (
    <div className="space-y-3">
      {modals}
      {/* e-Κατάστημα — branding + εύκολη, ευδιάκριτη πρόσβαση στις παραγγελίες μου */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-500 text-white shadow-sm"><ShoppingBag className="h-5 w-5" /></span>
          <div className="leading-tight">
            <div className="text-lg font-extrabold tracking-tight text-slate-900 dark:text-slate-100">{t("e-Κατάστημα", "e-Shop")}</div>
            <div className="text-[11px] text-slate-400">{t("Παράγγειλε online από το φαρμακείο σου", "Order online from your pharmacy")}</div>
          </div>
        </div>
        <button onClick={() => setView("orders")} className="relative inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-100">
          <Package className="h-4 w-4" /> <span className="hidden sm:inline">{t("Οι παραγγελίες μου", "My orders")}</span><span className="sm:hidden">{t("Παραγγελίες", "Orders")}</span>
          {activeOrders > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[20px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{activeOrders}</span>}
        </button>
      </div>
      {/* Hero banner — merchandising που ρυθμίζει ο φαρμακοποιός (εικόνα + τίτλος), οδηγεί στις Προσφορές */}
      {meta?.settings.hero_enabled && (meta.settings.hero_image_id || meta.settings.hero_title) && (
        <button onClick={() => setView("offers")} className="relative block w-full overflow-hidden rounded-2xl text-left shadow-sm">
          {meta.settings.hero_image_id
            ? <img src={`${API_BASE}/catalog/image/${meta.settings.hero_image_id}`} alt="" className="h-32 w-full object-cover sm:h-44" />
            : <div className="h-32 w-full bg-gradient-to-r from-violet-600 to-indigo-600 sm:h-44" />}
          {(meta.settings.hero_title || meta.settings.hero_subtitle) && (
            <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/60 to-transparent p-4 text-white">
              {meta.settings.hero_title && <div className="text-lg font-extrabold drop-shadow sm:text-2xl">{meta.settings.hero_title}</div>}
              {meta.settings.hero_subtitle && <div className="text-xs opacity-90 drop-shadow sm:text-sm">{meta.settings.hero_subtitle}</div>}
            </div>
          )}
        </button>
      )}
      {/* «🔥 Προσφορές» — ευδιάκριτη είσοδος στο κύκλωμα προσφορών (προϊόντα + υπηρεσίες) */}
      <button onClick={() => setView("offers")} className="flex w-full items-center gap-3 rounded-2xl bg-gradient-to-r from-rose-500 via-orange-500 to-amber-500 px-4 py-3 text-left text-white shadow-sm transition hover:brightness-105">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/20"><Flame className="h-5 w-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-extrabold">{t("Προσφορές του φαρμακείου", "Pharmacy offers")}</span>
          <span className="block text-[11px] opacity-90">{t("Προϊόντα σε έκπτωση & υπηρεσίες με ραντεβού — δες τι προμηθεύεσαι με προσφορά", "Discounted products & bookable services — see what you can get on offer")}</span>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 opacity-90" />
      </button>
      {/* Ενιαία γραμμή: «Φίλτρα» (burger με κατηγορίες+brand+ετικέτες+ταξινόμηση) + Αγαπημένα + Συνδρομές */}
      <div className="flex items-center gap-2">
        <button onClick={() => setShowFilters(true)} className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-2xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 text-sm font-semibold text-slate-700 dark:text-slate-200 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700 sm:flex-none">
          <SlidersHorizontal className="h-4 w-4" /> {t("Φίλτρα", "Filters")}
          {filterCount > 0 && <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-violet-600 px-1 text-[10px] font-bold text-white">{filterCount}</span>}
        </button>
        <button onClick={() => setView("favorites")} title={t("Τα αγαπημένα μου", "My favourites")} className="inline-flex h-10 items-center gap-1.5 rounded-2xl border border-rose-200 bg-white dark:bg-slate-800 px-3 text-sm font-semibold text-rose-500 shadow-sm"><Heart className="h-4 w-4" /> <span className="hidden sm:inline">{t("Αγαπημένα", "Favourites")}</span></button>
        {meta?.settings.subscription_enabled && <button onClick={() => setView("subs")} title={t("Οι συνδρομές μου", "My subscriptions")} className="inline-flex h-10 items-center gap-1.5 rounded-2xl border border-violet-300 bg-white dark:bg-slate-800 px-3 text-sm font-semibold text-violet-600 shadow-sm"><RefreshCcw className="h-4 w-4" /> <span className="hidden sm:inline">{t("Συνδρομές", "Subscriptions")}</span></button>}
      </div>

      {/* Ενεργά φίλτρα — γρήγορη αφαίρεση με ένα άγγιγμα */}
      {filterCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {catPath.map((c, i) => <button key={c.id} onClick={() => setCatPath(catPath.slice(0, i))} className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-semibold text-violet-700">{c.icon ? `${c.icon} ` : ""}{c.name} <XCircle className="h-3 w-3" /></button>)}
          {cat && <button onClick={() => setCat("")} className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-semibold text-violet-700">{cat} <XCircle className="h-3 w-3" /></button>}
          {brand && <button onClick={() => setBrand("")} className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-700">🏷️ {brand} <XCircle className="h-3 w-3" /></button>}
          {tag && <button onClick={() => setTag("")} className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-white">{tag} <XCircle className="h-3 w-3" /></button>}
          {sort !== "featured" && <button onClick={() => setSort("featured")} className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">{t(SORTS.find(([v]) => v === sort)?.[1] ?? "", SORTS.find(([v]) => v === sort)?.[2] ?? "")} <XCircle className="h-3 w-3" /></button>}
          <button onClick={clearFilters} className="rounded-full px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-600">{t("Καθαρισμός όλων", "Clear all")}</button>
        </div>
      )}

      {/* Drawer «Φίλτρα» — portal στο body ώστε το fixed overlay να καλύπτει ΟΛΗ την οθόνη· αλλιώς
          παγιδεύεται σε transformed ancestor και στο κινητό το κάτω κουμπί κρύβεται πίσω από το bottom nav. */}
      {showFilters && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={() => setShowFilters(false)}>
          <div className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl dark:bg-slate-800 sm:max-h-[85vh] sm:max-w-2xl sm:rounded-2xl lg:max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600 sm:hidden" />
            <div className="flex shrink-0 items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
              <span className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100"><SlidersHorizontal className="h-4 w-4 text-violet-600" /> {t("Φίλτρα", "Filters")}{filterCount > 0 && <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-violet-600 px-1 text-[10px] font-bold text-white">{filterCount}</span>}</span>
              <button onClick={() => setShowFilters(false)} aria-label={t("Κλείσιμο", "Close")} className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"><Plus className="h-4 w-4 rotate-45" /></button>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto border-t border-slate-100 px-4 py-4 dark:border-slate-800 sm:space-y-6 sm:px-6 sm:py-5">
              {hasTree ? (
                <section>
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">🗂️ {t("Κατηγορίες", "Categories")}</div>
                  {catPath.length > 0 && (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
                      <button onClick={() => setCatPath([])} className="rounded-lg px-2 py-1 font-medium text-violet-600 hover:bg-violet-50">{t("Όλες", "All")}</button>
                      {catPath.map((c, i) => (<Fragment key={c.id}><ChevronRight className="h-3 w-3 text-slate-300" /><button onClick={() => setCatPath(catPath.slice(0, i + 1))} className={`rounded-lg px-2 py-1 font-medium ${i === catPath.length - 1 ? "bg-violet-100 text-violet-700" : "text-violet-600 hover:bg-violet-50"}`}>{c.icon ? `${c.icon} ` : ""}{c.name}</button></Fragment>))}
                    </div>
                  )}
                  <CategoryTiles tree={meta!.category_tree!} counts={meta!.category_counts ?? {}} path={catPath} setPath={setCatPath} />
                </section>
              ) : !!meta?.categories.length && (
                <section>
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">🗂️ {t("Κατηγορίες", "Categories")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.categories.map((c) => <button key={c} onClick={() => setCat(cat === c ? "" : c)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${cat === c ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200"}`}>{catEmoji(c)} {c}</button>)}
                  </div>
                </section>
              )}
              {!!meta?.brands?.length && (
                <section>
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">🏷️ {t("Μάρκα", "Brand")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.brands.map((b) => <button key={b} onClick={() => setBrand(brand === b ? "" : b)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${brand === b ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200"}`}>{b}</button>)}
                  </div>
                </section>
              )}
              {!!meta?.tags?.length && (
                <section>
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">{t("Ετικέτες", "Tags")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.tags.map((tg) => <button key={tg} onClick={() => setTag(tag === tg ? "" : tg)} className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${tag === tg ? "bg-slate-800 text-white" : tagCls(tg)}`}>{tg}</button>)}
                  </div>
                </section>
              )}
              <section>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">{t("Ταξινόμηση", "Sort")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {SORTS.map(([v, el, en]) => <button key={v} onClick={() => setSort(v)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${sort === v ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200"}`}>{t(el, en)}</button>)}
                </div>
              </section>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-slate-100 bg-white p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] dark:border-slate-800 dark:bg-slate-800 sm:px-6">
              <button onClick={clearFilters} disabled={filterCount === 0} className="rounded-xl px-4 py-3 text-sm font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-700">{t("Καθαρισμός", "Clear")}</button>
              <button onClick={() => setShowFilters(false)} className="flex-1 rounded-xl bg-violet-600 py-3 text-sm font-bold text-white shadow-sm hover:bg-violet-700">{t("Δες αποτελέσματα", "Show results")}{total ? ` (${total.toLocaleString("el-GR")})` : ""}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* Μπάρα δωρεάν μεταφορικών (Shopify-style) — κίνητρο για μεγαλύτερο καλάθι. */}
      {count > 0 && (meta?.free_shipping_at ?? 0) > 0 && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2.5">
          {subtotal >= meta!.free_shipping_at! ? (
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700"><Truck className="h-4 w-4" /> 🎉 {t("Έχεις ΔΩΡΕΑΝ μεταφορικά!", "You have FREE delivery!")}</div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs font-medium text-emerald-800"><Truck className="h-4 w-4" /> {t("Πρόσθεσε", "Add")} <b>{eur(meta!.free_shipping_at! - subtotal)}</b> {t("για ΔΩΡΕΑΝ μεταφορικά", "for FREE delivery")}</div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-emerald-200"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, Math.round((subtotal / meta!.free_shipping_at!) * 100))}%` }} /></div>
            </>
          )}
        </div>
      )}
      {/* ΚΑΛΑΘΙ — κάτω από τα φίλτρα ώστε να ΜΗΝ σκεπάζει header/αναζήτηση/κατηγορίες· sticky & προσβάσιμο. */}
      {count > 0 && (
        <button onClick={() => setView("cart")}
          className="sticky top-2 z-10 flex w-full items-center justify-between gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-3 text-white shadow-lg shadow-violet-500/30 ring-1 ring-white/20">
          <span className="flex items-center gap-2 text-sm font-bold">
            <span className="relative grid h-8 w-8 place-items-center rounded-xl bg-white/20">
              <ShoppingCart className="h-[18px] w-[18px]" />
              <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[20px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold">{count}</span>
            </span>
            {t("Το καλάθι μου", "My cart")}
          </span>
          <span className="flex items-center gap-2 text-sm font-extrabold">{eur(subtotal)} <span className="rounded-lg bg-white/20 px-2.5 py-1 text-xs" aria-label={t("Ολοκλήρωση", "Checkout")}>→</span></span>
        </button>
      )}
      {/* Αναζήτηση — ακριβώς πάνω από τον κατάλογο (2.5) */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση στον κατάλογο…", "Search the catalogue…")} className="w-full rounded-2xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-2.5 pl-11 pr-9 text-[15px] shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100" />
        {q && <button onClick={() => setQ("")} aria-label={t("Καθαρισμός", "Clear")} className="absolute right-2.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"><XCircle className="h-4 w-4" /></button>}
      </div>

      <div className="grid grid-cols-2 gap-2 pb-20 sm:grid-cols-3 sm:gap-3 sm:pb-6 lg:grid-cols-4 xl:grid-cols-5">
        {products.map((p) => {
          const med = isMed(p.type); const fc = final(p, camps); const inCart = cart[p.barcode]?.qty ?? 0;
          const dPct = effDisc(p, camps);
          return (
            <div key={p.barcode} className={`flex flex-col rounded-2xl border bg-white dark:bg-slate-800 p-2.5 ${p.featured ? "border-amber-300 ring-1 ring-amber-100" : "border-slate-200 dark:border-slate-700"}`}>
              <div onClick={() => setPdp(p)} title={t("Δες λεπτομέρειες", "View details")} className="relative mb-1 grid h-24 cursor-pointer place-items-center overflow-hidden rounded-xl bg-slate-50 dark:bg-slate-900 sm:h-32">
                {imgSrc(p) ? <img src={imgSrc(p)} alt="" className="h-full w-full object-contain" /> : (med ? <Pill className="h-7 w-7 text-slate-300" /> : <Package className="h-7 w-7 text-slate-300" />)}
                {(imgList(p).length > 1) && <span className="absolute bottom-1 right-8 rounded bg-black/60 px-1 text-[9px] font-semibold text-white">📷 {imgList(p).length}</span>}
                {/* πάνω αριστερά: badge έκπτωσης + αγαπημένο (καρδιά) */}
                <div className="absolute left-1 top-1 flex flex-col items-start gap-1">
                  {dPct > 0 && <span className="rounded-md bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">-{dPct}%</span>}
                  <button onClick={(e) => { e.stopPropagation(); toggleFav(p.barcode); }} title={favBarcodes.has(p.barcode) ? t("Αφαίρεση αγαπημένου", "Remove favourite") : t("Αγαπημένο", "Favourite")} className="grid h-7 w-7 place-items-center rounded-full bg-white/90 shadow-sm">
                    <Heart className={`h-4 w-4 ${favBarcodes.has(p.barcode) ? "fill-rose-500 text-rose-500" : "text-slate-400"}`} />
                  </button>
                </div>
                {/* πάνω δεξιά: κουμπί ενεργειών (προσθήκη / ποσότητα) */}
                <div className="absolute right-1 top-1" onClick={(e) => e.stopPropagation()}>
                  {inCart ? (
                    <div className="flex items-center gap-0.5 rounded-full bg-violet-600 px-1 text-white shadow-sm">
                      <button onClick={() => dec(p.barcode)} className="grid h-7 w-7 place-items-center"><Minus className="h-3.5 w-3.5" /></button>
                      <span className="min-w-[0.9rem] text-center text-xs font-bold">{inCart}</span>
                      <button onClick={() => add(p)} className="grid h-7 w-7 place-items-center"><Plus className="h-3.5 w-3.5" /></button>
                    </div>
                  ) : <button onClick={() => add(p)} title={t("Προσθήκη στο καλάθι", "Add to cart")} className="grid h-8 w-8 place-items-center rounded-full bg-violet-600 text-white shadow-sm hover:bg-violet-700"><Plus className="h-4 w-4" /></button>}
                </div>
                {videoEmbed(p.usage_video_url) && <button onClick={(e) => { e.stopPropagation(); setVideo(videoEmbed(p.usage_video_url)); }} title={t("Οδηγίες χρήσης", "Usage instructions")} className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-black/85">▶</button>}
                {p.stock_qty > 0 && p.stock_qty <= LOW_STOCK && <span className="absolute bottom-1 left-1 rounded bg-orange-100 px-1.5 py-0.5 text-[9px] font-semibold text-orange-700">{t("τελευταία", "last")} {p.stock_qty}</span>}
                {isBackorder(p) && <span className="absolute bottom-1 left-1 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">{t("Κατόπιν παραγγελίας", "Backorder")}</span>}
              </div>
              <div onClick={() => setPdp(p)} className="line-clamp-2 min-h-[2.2rem] cursor-pointer text-xs font-semibold text-slate-800 dark:text-slate-100 hover:text-violet-700">{p.name}</div>
              {!!p.tags?.length && <div className="mt-0.5 flex flex-wrap gap-0.5">{p.tags.slice(0, 3).map((tg) => <span key={tg} className={`rounded px-1 py-0.5 text-[9px] font-semibold ${tagCls(tg)}`}>{tg}</span>)}</div>}
              {/* τιμή + έκπτωση κάτω σε μία γραμμή */}
              <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
                {fc < p.price_cents && <span className="text-[10px] text-slate-400 line-through">{eur(p.price_cents)}</span>}
                <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{eur(fc)}</span>
                {dPct > 0 && <span className="text-[10px] font-semibold text-emerald-600">-{dPct}%</span>}
              </div>
            </div>
          );
        })}
        {products.length === 0 && <div className="col-span-2 py-10 text-center text-sm text-slate-400">{t("Δεν βρέθηκαν προϊόντα.", "No products found.")}</div>}
      </div>

      {/* Φόρτωση περισσότερων — η πύλη έδειχνε μόνο 60· τώρα ο πελάτης βλέπει ΟΛΑ τα προϊόντα της κατηγορίας */}
      {products.length > 0 && products.length < total && (
        <div className="mt-3 flex flex-col items-center gap-1 pb-20 sm:pb-4">
          <button onClick={loadMore} disabled={loadingMore} className="inline-flex items-center gap-2 rounded-xl border border-violet-300 bg-white dark:bg-slate-800 px-5 py-2.5 text-sm font-semibold text-violet-700 shadow-sm hover:bg-violet-50 disabled:opacity-50">
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />} {t("Φόρτωσε περισσότερα", "Load more")}
          </button>
          <span className="text-[11px] text-slate-400">{products.length} {t("από", "of")} {total.toLocaleString("el-GR")} {t("προϊόντα", "products")}</span>
        </div>
      )}

      {/* «↑ Πάνω» — γρήγορη επιστροφή στην κορυφή όταν έχεις κατέβει πολύ */}
      {showTop && (
        <button onClick={scrollTop} aria-label={t("Πάνω", "Top")} title={t("Πάνω", "Top")}
          className="fixed bottom-24 right-4 z-40 grid h-11 w-11 place-items-center rounded-full bg-violet-600 text-white shadow-lg shadow-violet-500/30 ring-1 ring-white/20 transition hover:bg-violet-700 sm:bottom-6">
          <ChevronUp className="h-5 w-5" />
        </button>
      )}

      {/* (Το πλωτό κάτω κουμπί καλαθιού αφαιρέθηκε: ήταν διπλό με το sticky πάνω και έπεφτε
          πάνω στην κάτω μπάρα πλοήγησης στο κινητό.) */}
    </div>
  );
}

function Checkout({ cart, subtotal, settings, camps, bundles, loyalty, onBack, onDone, dec, add, openProduct }: {
  cart: Record<string, { p: Product; qty: number }>; subtotal: number; settings?: Settings;
  camps: Campaign[]; bundles: Bundle[]; loyalty?: Loyalty;
  onBack: () => void; onDone: () => void; dec: (bc: string) => void; add: (p: Product) => void;
  openProduct: (p: Product) => void;
}) {
  const t = useT();
  const items = Object.values(cart);
  const hasMed = items.some((x) => isMed(x.p.type));
  const hasRx = items.some((x) => x.p.type === "rx_medicine");
  const hasBackorder = items.some((x) => isBackorder(x.p));
  const [mode, setMode] = useState<"delivery" | "pickup">(settings?.delivery_enabled ? "delivery" : "pickup");
  const [pay, setPay] = useState<"store" | "online">("store");
  const [addr, setAddr] = useState({ street: "", area: "", postal: "", phone: "", notes: "" });
  const [courier, setCourier] = useState(false);
  const [cauth, setCauth] = useState({ name: "", id_number: "" });   // εξουσιοδοτούμενος (μόνο για αποστολή)
  const [gdpr, setGdpr] = useState(false);
  const [repeat, setRepeat] = useState(0);
  const [note, setNote] = useState("");            // σημείωση πελάτη πάνω στην παραγγελία (7.6)
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
          coupon_invalid: t("Άκυρος κωδικός.", "Invalid code."), coupon_expired: t("Το κουπόνι έληξε.", "The coupon has expired."),
          coupon_exhausted: t("Το κουπόνι εξαντλήθηκε.", "The coupon has been used up."),
          coupon_no_eligible_items: t("Το κουπόνι δεν ισχύει σε συνταγογραφούμενα.", "The coupon does not apply to prescription items."),
          coupon_below_min: t(`Ελάχιστη αξία ${eur(r.min_cents ?? 0)}.`, `Minimum value ${eur(r.min_cents ?? 0)}.`),
        }[r.error ?? ""] ?? t("Άκυρος κωδικός.", "Invalid code."));
        return;
      }
      setCoupon({ code: r.code!, kind: r.kind!, value: r.value! });
      toast(t("Το κουπόνι εφαρμόστηκε!", "Coupon applied!"), "success");
    } catch { setCouponErr(t("Σφάλμα δικτύου.", "Network error.")); } finally { setCouponBusy(false); }
  }

  async function place() {
    setErr(null);
    if (!gdpr) { setErr(t("Χρειάζεται η συγκατάθεση επεξεργασίας.", "Data processing consent is required.")); return; }
    if (mode === "delivery" && !courier) { setErr(t("Χρειάζεται η εξουσιοδότηση μεταφορέα.", "Courier authorization is required.")); return; }
    if (mode === "delivery" && courier && (cauth.name.trim().length < 3 || cauth.id_number.trim().length < 4)) {
      setErr(t("Συμπλήρωσε ονοματεπώνυμο & αρ. ταυτότητας/διαβατηρίου του εξουσιοδοτούμενου.", "Enter the authorized person's full name & ID/passport number.")); return;
    }
    if (mode === "delivery" && (!addr.street || !addr.area)) { setErr(t("Συμπλήρωσε διεύθυνση.", "Enter an address.")); return; }
    if (redeemApplied > 0 && minRedeem && redeemApplied < minRedeem) { setErr(t(`Ελάχιστη εξαργύρωση ${eur(minRedeem)}.`, `Minimum redemption ${eur(minRedeem)}.`)); return; }
    setBusy(true);
    try {
      const r = await patientApi<{ ok: boolean; error?: string; payment?: string; checkout_url?: string }>("/patient/shop/order", { method: "POST", body: JSON.stringify({
        lines: items.map((x) => ({ barcode: x.p.barcode, qty: x.qty })),
        mode, address: mode === "delivery" ? addr : null, courier_authorized: courier,
        courier_auth: mode === "delivery" ? { name: cauth.name.trim(), id_number: cauth.id_number.trim() } : null,
        loyalty_redeem_cents: redeemApplied, coupon_code: useCoupon ? coupon?.code ?? null : null,
        gdpr_consent: gdpr, repeat_days: repeat, note: note.trim() || null,
        payment_method: pay === "online" ? "online" : (mode === "delivery" ? "cod" : "pickup"),
      }) });
      if (r.ok && r.payment === "viva" && r.checkout_url) { window.location.href = r.checkout_url; return; }  // κάρτα/IRIS
      if (r.ok) onDone(); else setErr(t("Σφάλμα: ", "Error: ") + (r.error || t("δοκίμασε ξανά", "please try again")));
    } catch { setErr(t("Σφάλμα δικτύου.", "Network error.")); } finally { setBusy(false); }
  }

  return (
    // Desktop: 2 στήλες — αριστερά είδη/παράδοση/στοιχεία, δεξιά «κολλημένο» το σύνολο & η ολοκλήρωση.
    <div className="pb-6">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400"><ChevronLeft className="h-4 w-4" /> {t("Συνέχεια αγορών", "Continue shopping")}</button>
      <div className="mt-3 grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-3">
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
        {items.map((x) => (
          <div key={x.p.barcode} className="flex items-center gap-2.5 border-b border-slate-100 dark:border-slate-800 py-2 last:border-0">
            <button onClick={() => openProduct(x.p)} title={t("Δες λεπτομέρειες", "View details")} className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-50 dark:bg-slate-900">{imgSrc(x.p) ? <img src={imgSrc(x.p)} alt="" className="h-full w-full object-contain" /> : (isMed(x.p.type) ? <Pill className="h-5 w-5 text-slate-300" /> : <Package className="h-5 w-5 text-slate-300" />)}</button>
            <div className="min-w-0 flex-1"><button onClick={() => openProduct(x.p)} className="block max-w-full truncate text-left text-sm font-medium text-slate-800 dark:text-slate-100 hover:text-violet-700">{x.p.name}</button><div className="text-xs text-slate-400">{eur(final(x.p, camps))} × {x.qty} = <b className="text-slate-500 dark:text-slate-300">{eur(final(x.p, camps) * x.qty)}</b></div></div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button onClick={() => dec(x.p.barcode)} className="grid h-7 w-7 place-items-center rounded-full bg-slate-100 dark:bg-slate-700"><Minus className="h-3.5 w-3.5" /></button>
              <span className="w-4 text-center text-sm font-bold">{x.qty}</span>
              <button onClick={() => add(x.p)} className="grid h-7 w-7 place-items-center rounded-full bg-slate-100 dark:bg-slate-700"><Plus className="h-3.5 w-3.5" /></button>
              <button onClick={() => { for (let i = 0; i < x.qty; i++) dec(x.p.barcode); }} title={t("Αφαίρεση", "Remove")} aria-label={t("Αφαίρεση", "Remove")} className="ml-0.5 grid h-7 w-7 place-items-center rounded-full text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
      </div>

      {/* delivery vs pickup */}
      <div className="grid grid-cols-2 gap-2">
        {settings?.delivery_enabled && <button onClick={() => setMode("delivery")} className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-medium ${mode === "delivery" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"}`}><Truck className="h-4 w-4" /> {t("Αποστολή", "Delivery")}</button>}
        {settings?.pickup_enabled && <button onClick={() => setMode("pickup")} className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-medium ${mode === "pickup" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"}`}><Store className="h-4 w-4" /> {t("Παραλαβή", "Pickup")}</button>}
      </div>
      {/* Ενημέρωση: τα συνταγογραφούμενα δεν αποστέλλονται με courier — μόνο παραλαβή από το φαρμακείο */}
      {hasRx && mode === "delivery" && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("Τα συνταγογραφούμενα φάρμακα του καλαθιού ΔΕΝ αποστέλλονται με courier — απαιτείται παραλαβή από το φαρμακείο (κατόπιν έγκρισης). Τα υπόλοιπα είδη αποστέλλονται κανονικά.", "The prescription medicines in your cart are NOT shipped by courier — pharmacy pickup is required (after approval). The rest of the items ship normally.")}
        </div>
      )}

      {/* τρόπος πληρωμής (online Viva = κάρτα/IRIS· αλλιώς στο κατάστημα/παράδοση) */}
      {settings?.online_payment_enabled && (
        <div>
          <div className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">{t("Τρόπος πληρωμής", "Payment method")}</div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setPay("store")} className={`rounded-xl border p-3 text-sm font-medium ${pay === "store" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"}`}>🏪 {mode === "delivery" ? t("Με την παράδοση", "On delivery") : t("Στο κατάστημα", "In store")}</button>
            <button onClick={() => setPay("online")} className={`rounded-xl border p-3 text-sm font-medium ${pay === "online" ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"}`}>💳 {t("Online (κάρτα / IRIS)", "Online (card / IRIS)")}</button>
          </div>
        </div>
      )}

      {mode === "delivery" && (
        <div className="space-y-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Διεύθυνση αποστολής", "Delivery address")}</div>
          <input value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} placeholder={t("Οδός & αριθμός", "Street & number")} className="w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm" />
          <div className="grid grid-cols-2 gap-2">
            <input value={addr.area} onChange={(e) => setAddr({ ...addr, area: e.target.value })} placeholder={t("Περιοχή", "Area")} className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm" />
            <input value={addr.postal} onChange={(e) => setAddr({ ...addr, postal: e.target.value })} placeholder={t("Τ.Κ.", "Postal code")} className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm" />
          </div>
          <input value={addr.phone} onChange={(e) => setAddr({ ...addr, phone: e.target.value })} placeholder={t("Τηλέφωνο", "Phone")} className="w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm" />
          <input value={addr.notes} onChange={(e) => setAddr({ ...addr, notes: e.target.value })} placeholder={t("Σημείωση (όροφος, κουδούνι…)", "Note (floor, doorbell…)")} className="w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm" />
        </div>
      )}

      {settings?.subscription_enabled && (
        <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-3">
          <div className="mb-1.5 text-sm font-semibold text-violet-900">🔁 {t("Επανάληψη παραγγελίας", "Repeat order")}</div>
          <select value={repeat} onChange={(e) => setRepeat(+e.target.value)} className="w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm">
            {FREQ.map(([d, el, en]) => <option key={d} value={d}>{t(el, en)}</option>)}
          </select>
          {repeat > 0 && (settings.subscription_discount_pct > 0
            ? <p className="mt-1.5 text-xs font-semibold text-emerald-700">✓ {t(`Επιπλέον -${settings.subscription_discount_pct}% στα παραφάρμακα σε κάθε επανάληψη! Ακύρωση όποτε θες.`, `An extra -${settings.subscription_discount_pct}% on OTC items with every repeat! Cancel anytime.`)}</p>
            : <p className="mt-1.5 text-[11px] text-violet-600">{t("Θα επαναλαμβάνεται αυτόματα — ακύρωση όποτε θες.", "It will repeat automatically — cancel anytime.")}</p>)}
        </div>
      )}

      {/* Σημείωση πάνω στην παραγγελία (7.6) — για φαρμακείο (π.χ. προτίμηση, ώρα, οδηγίες) */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
        <label className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-200">📝 {t("Σημείωση για το φαρμακείο", "Note for the pharmacy")} <span className="font-normal text-slate-400">({t("προαιρετικό", "optional")})</span></label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder={t("π.χ. προτιμώμενη ώρα παραλαβής, ειδικές οδηγίες…", "e.g. preferred pickup time, special instructions…")} className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm" />
      </div>

      {/* compliance: EU pharmacy certification + consents */}
      {hasMed && settings?.pps_cert && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><ShieldCheck className="h-4 w-4 shrink-0" /> {t("Πιστοποιημένο φαρμακείο (ΠΦΣ):", "Certified pharmacy (ΠΦΣ):")} {settings.pps_cert}. {t("Νόμιμη διάθεση ΜΗ.ΣΥ.ΦΑ. βάσει του κοινού λογοτύπου ΕΕ.", "Legal sale of OTC medicines under the EU common logo.")}</div>
      )}
      <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={gdpr} onChange={(e) => setGdpr(e.target.checked)} className="mt-0.5" /> {t("Συναινώ στην επεξεργασία των στοιχείων μου για την εκτέλεση της παραγγελίας (GDPR).", "I consent to the processing of my data to fulfil the order (GDPR).")}</label>
      {mode === "delivery" && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={courier} onChange={(e) => setCourier(e.target.checked)} className="mt-0.5" /> {t("Εξουσιοδοτώ τον μεταφορέα να παραλάβει και να μου παραδώσει την παραγγελία στη διεύθυνσή μου.", "I authorize the courier to collect and deliver the order to my address.")}</label>
          {courier && (
            <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50/60 p-3">
              <div className="text-sm font-semibold text-amber-900">{t("Στοιχεία εξουσιοδοτούμενου", "Authorized person's details")}</div>
              <p className="text-[11px] text-amber-800">{t("Το άτομο που εξουσιοδοτείς να παραλάβει τα φάρμακα για λογαριασμό σου. Θα ζητηθεί ταυτοποίηση κατά την παράδοση.", "The person you authorize to collect the medicines on your behalf. Identification will be requested at delivery.")}</p>
              <input value={cauth.name} onChange={(e) => setCauth({ ...cauth, name: e.target.value })} placeholder={t("Ονοματεπώνυμο εξουσιοδοτούμενου", "Authorized person's full name")} className="w-full rounded-lg border border-amber-300 bg-white dark:bg-slate-800 px-3 py-2 text-sm" />
              <input value={cauth.id_number} onChange={(e) => setCauth({ ...cauth, id_number: e.target.value })} placeholder={t("Αρ. ταυτότητας ή διαβατηρίου", "ID or passport number")} className="w-full rounded-lg border border-amber-300 bg-white dark:bg-slate-800 px-3 py-2 text-sm" />
            </div>
          )}
        </div>
      )}

      </div>{/* ── τέλος αριστερής στήλης ── */}

      {/* ── δεξιά στήλη: προσφορές + σύνολο + ολοκλήρωση (sticky σε desktop) ── */}
      <div className="space-y-3 lg:sticky lg:top-20">
      {/* Κουπόνι έκπτωσης */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
        <div className="mb-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">🎟️ {t("Κουπόνι έκπτωσης", "Discount coupon")}</div>
        {coupon ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-violet-50 px-3 py-2">
            <span className="min-w-0 flex-1 text-sm text-violet-800">{t("Ενεργό:", "Active:")} <code className="font-bold break-all">{coupon.code}</code> {coupon.kind === "pct" ? `(−${coupon.value}%)` : `(−${eur(coupon.value)})`}</span>
            <button onClick={() => { setCoupon(null); setCouponIn(""); }} className="shrink-0 text-xs font-semibold text-slate-400">{t("Αφαίρεση", "Remove")}</button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input value={couponIn} onChange={(e) => setCouponIn(e.target.value.toUpperCase())} placeholder={t("Κωδικός", "Code")} className="min-w-0 flex-1 rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 font-mono text-sm uppercase" />
            <button onClick={applyCoupon} disabled={couponIn.trim().length < 3 || couponBusy} className="shrink-0 rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{couponBusy ? "…" : t("Εφαρμογή", "Apply")}</button>
          </div>
        )}
        {couponErr && <div className="mt-1.5 text-xs text-rose-600">{couponErr}</div>}
        {coupon && !useCoupon && cartCents > 0 && <div className="mt-1.5 text-[11px] text-amber-700">{t(`Η κλιμακωτή έκπτωση (${td.pct}%) σε συμφέρει περισσότερο — εφαρμόστηκε αυτή.`, `The tiered discount (${td.pct}%) is better for you — it was applied instead.`)}</div>}
      </div>

      {/* Εξαργύρωση πόντων — ΜΟΝΟ σε μη-συνταγογραφούμενα (τα συνταγογραφούμενα εξαιρούνται) */}
      {canRedeem && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3">
          <label className="flex items-start gap-2 text-sm font-semibold text-emerald-900">
            <input type="checkbox" checked={useP} onChange={(e) => { setUseP(e.target.checked); setRedeem(e.target.checked ? maxRedeem : 0); }} className="mt-0.5" />
            🎁 {t("Χρήση πόντων — διαθέσιμα", "Use points — available")} {eur(loyalty!.balance_cents)}
          </label>
          {useP && (
            <div className="mt-2 space-y-1.5">
              <input type="range" min={0} max={maxRedeem} step={10} value={Math.min(redeem, maxRedeem)}
                onChange={(e) => setRedeem(+e.target.value)} className="w-full accent-emerald-600" />
              <div className="flex items-center justify-between text-xs text-emerald-800">
                <span>{t("Εξαργύρωση:", "Redemption:")} <b>{eur(redeemApplied)}</b></span>
                <button type="button" onClick={() => setRedeem(maxRedeem)} className="rounded-lg bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">{t("Μέγιστο", "Max")} ({eur(maxRedeem)})</button>
              </div>
              <p className="text-[10px] text-emerald-700">{t(`Οι πόντοι ισχύουν μόνο για μη συνταγογραφούμενα είδη — εδώ έως ${eur(eligible)}.`, `Points apply only to non-prescription items — up to ${eur(eligible)} here.`)}{minRedeem ? t(` Ελάχιστη εξαργύρωση ${eur(minRedeem)}.`, ` Minimum redemption ${eur(minRedeem)}.`) : ""}</p>
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-sm">
        <div className="flex justify-between text-slate-600 dark:text-slate-300"><span>{t("Υποσύνολο", "Subtotal")}</span><span>{eur(subtotal)}</span></div>
        {bundleCents > 0 && <div className="flex items-center justify-between gap-2 font-semibold text-emerald-700"><span className="min-w-0 truncate">📦 {bs.names.join(", ")}</span><span className="shrink-0">−{eur(bundleCents)}</span></div>}
        {cartCents > 0 && <div className="flex justify-between gap-2 font-semibold text-violet-700"><span className="min-w-0 truncate">{useCoupon ? t(`🎟️ Κουπόνι ${coupon?.code}`, `🎟️ Coupon ${coupon?.code}`) : t(`📈 Έκπτωση καλαθιού (${td.pct}%)`, `📈 Cart discount (${td.pct}%)`)}</span><span className="shrink-0">−{eur(cartCents)}</span></div>}
        {mode === "delivery" && <div className="flex justify-between text-slate-600 dark:text-slate-300"><span>{t("Μεταφορικά", "Delivery")}</span><span>{fee === 0 ? t("Δωρεάν", "Free") : eur(fee)}</span></div>}
        {redeemApplied > 0 && <div className="flex justify-between font-semibold text-emerald-700"><span>🎁 {t("Πόντοι επιβράβευσης", "Reward points")}</span><span>−{eur(redeemApplied)}</span></div>}
        <div className="mt-1 flex justify-between border-t border-slate-100 dark:border-slate-800 pt-1 text-base font-bold text-slate-900 dark:text-slate-100"><span>{t("Σύνολο", "Total")}</span><span>{eur(total)}</span></div>
        <p className="mt-1 text-[11px] text-slate-400">{t("Πληρωμή κατά την παράδοση/παραλαβή. Τα φάρμακα δεν επιστρέφονται.", "Payment on delivery/pickup. Medicines are non-returnable.")}</p>
      </div>

      {(() => {   // κίνητρο: πόσο λείπει για την επόμενη κλίμακα έκπτωσης
        const next = (settings?.cart_tiers ?? []).filter((tr) => afterBundles < tr.min_cents).sort((a, b) => a.min_cents - b.min_cents)[0];
        return next ? <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">📈 {t("Πρόσθεσε", "Add")} <b>{eur(next.min_cents - afterBundles)}</b> {t("ακόμη σε μη-συνταγογραφούμενα και κερδίζεις", "more in non-prescription items and get")} <b>−{next.pct}%</b> {t("στο καλάθι!", "off your cart!")}</div> : null;
      })()}
      {hasBackorder && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">📦 {t("Κάποια είδη είναι", "Some items are")} <b>{t("κατόπιν παραγγελίας", "on backorder")}</b>. {t("Η παραγγελία θα σταλεί στο φαρμακείο για", "The order will be sent to the pharmacy for")} <b>{t("έγκριση", "approval")}</b> {t("— θα σου δηλώσει πότε θα είναι διαθέσιμα.", "— it will tell you when they will be available.")}</div>}
      {belowMin && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t(`Ελάχιστη παραγγελία ${eur(settings?.min_order_cents ?? 0)}.`, `Minimum order ${eur(settings?.min_order_cents ?? 0)}.`)}</div>}
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      <button onClick={place} disabled={busy || belowMin} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 font-semibold text-white disabled:opacity-50">
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null} {hasBackorder ? t("Αποστολή για έγκριση", "Send for approval") : t("Ολοκλήρωση παραγγελίας", "Place order")} · {eur(total)}
      </button>
      </div>{/* ── τέλος δεξιάς στήλης ── */}
      </div>
    </div>
  );
}

const STEPS_DELIVERY: [string, string][] = [["Καταχωρήθηκε", "Placed"], ["Ετοιμάζεται", "Preparing"], ["Καθ' οδόν", "On the way"], ["Παραδόθηκε", "Delivered"]];
const STEPS_PICKUP: [string, string][] = [["Καταχωρήθηκε", "Placed"], ["Ετοιμάζεται", "Preparing"], ["Έτοιμη", "Ready"], ["Παραλήφθηκε", "Picked up"]];
const STEP_OF: Record<string, number> = { new: 0, preparing: 1, shipped: 2, ready: 2, delivered: 3 };

function Stepper({ steps, cur }: { steps: string[]; cur: number }) {
  return (
    <div className="flex items-start px-1 pt-3">
      {steps.map((s, i) => (
        <Fragment key={i}>
          <div className="flex flex-1 flex-col items-center">
            <div className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${i < cur ? "bg-emerald-500 text-white" : i === cur ? "bg-violet-600 text-white ring-4 ring-violet-100" : "bg-slate-100 dark:bg-slate-700 text-slate-400"}`}>
              {i < cur ? <Check className="h-4 w-4" /> : i + 1}
            </div>
            <span className={`mt-1 text-center text-[10px] leading-tight ${i <= cur ? "font-medium text-slate-700 dark:text-slate-200" : "text-slate-400"}`}>{s}</span>
          </div>
          {i < steps.length - 1 && <div className={`mt-3.5 h-0.5 flex-1 ${i < cur ? "bg-emerald-500" : "bg-slate-200"}`} />}
        </Fragment>
      ))}
    </div>
  );
}

function OrderCard({ o, onReorder }: { o: Order; onReorder?: (o: Order) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const steps = (o.mode === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP).map(([el, en]) => t(el, en));
  const cur = STEP_OF[o.status] ?? 0;
  const cancelled = o.status === "cancelled";
  const declined = o.status === "declined";
  const pending = o.status === "pending";
  const dead = cancelled || declined;
  const done = o.status === "delivered";
  const oid = (o._id || "").slice(-6).toUpperCase();   // σύντομο, αναγνωρίσιμο Order ID
  const payLabel = o.payment_method === "online" ? t("Online (κάρτα/IRIS)", "Online (card/IRIS)") : o.payment_method === "cod" ? t("Με την παράδοση", "On delivery") : t("Στο κατάστημα", "In store");
  return (
    // Ολόκληρη η κάρτα clickable για expand/collapse (όχι μόνο η κορυφή)
    <div onClick={() => setOpen((v) => !v)} className={`cursor-pointer overflow-hidden rounded-2xl border bg-white dark:bg-slate-800 ${dead ? "border-slate-200 dark:border-slate-700 opacity-70" : done ? "border-emerald-200" : pending ? "border-amber-300" : "border-violet-200"}`}>
      <div className="flex w-full items-center justify-between gap-2 p-3 text-left">
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            {o.mode === "delivery" ? <Truck className="h-4 w-4 text-violet-500" /> : <Store className="h-4 w-4 text-sky-500" />}
            {eur(o.total_cents)} <span className="text-xs font-normal text-slate-400">· {o.items.length} {t("είδη", "items")}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
            {oid && <span className="font-mono font-semibold text-slate-500 dark:text-slate-300">#{oid}</span>}
            <span>· {o.mode === "delivery" ? t("Αποστολή", "Delivery") : t("Παραλαβή", "Pickup")}</span>
            {o.payment_method && <span>· {payLabel}</span>}
          </span>
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${dead ? "bg-slate-200 text-slate-500 dark:text-slate-400" : done ? "bg-emerald-100 text-emerald-700" : pending ? "bg-amber-100 text-amber-800" : "bg-violet-100 text-violet-700"}`}>{ST[o.status] ? t(ST[o.status][0], ST[o.status][1]) : o.status}</span>
      </div>

      {pending ? (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-amber-700">⏳ {t("Κατόπιν παραγγελίας — αναμονή έγκρισης & ημερομηνίας από το φαρμακείο.", "Backorder — awaiting approval & date from the pharmacy.")}</div>
      ) : declined ? (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-rose-600"><XCircle className="h-4 w-4" /> {t("Το φαρμακείο δεν μπόρεσε να εκτελέσει την παραγγελία.", "The pharmacy could not fulfil the order.")}</div>
      ) : cancelled ? (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-rose-600"><XCircle className="h-4 w-4" /> {t("Η παραγγελία ακυρώθηκε.", "The order was cancelled.")}</div>
      ) : <div className="px-3 pb-2"><Stepper steps={steps} cur={cur} />{o.available_date && <div className="mt-1 text-center text-[11px] font-medium text-emerald-700">📦 {t("Διαθέσιμο", "Available")} ~{new Date(o.available_date).toLocaleDateString("el-GR")}</div>}</div>}

      {(done || dead) && onReorder && (
        <div className="px-3 pb-3">
          <button onClick={(e) => { e.stopPropagation(); onReorder(o); }} className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-700">
            <ShoppingCart className="h-3.5 w-3.5" /> {t("Παράγγειλε ξανά", "Order again")}
          </button>
        </div>
      )}

      {open && (
        <div className="space-y-2 border-t border-slate-100 dark:border-slate-800 px-3 py-2.5 text-sm">
          <div className="space-y-0.5">
            {o.items.map((it, i) => (
              <div key={i} className="flex justify-between gap-2 text-slate-600 dark:text-slate-300">
                <span className="min-w-0 flex-1">{it.qty}× {it.name}{it.discount_pct ? <span className="ml-1 text-emerald-600">-{it.discount_pct}%</span> : null}{it.backorder ? <span className="ml-1 text-amber-600">· {t("κατόπιν παραγγελίας", "backorder")}</span> : null}</span>
                <span className="shrink-0">{eur(it.line_cents)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-100 dark:border-slate-800 pt-1 text-xs text-slate-500 dark:text-slate-400">
            <div className="flex justify-between"><span>{t("Υποσύνολο", "Subtotal")}</span><span>{eur(o.subtotal_cents)}</span></div>
            {o.mode === "delivery" && <div className="flex justify-between"><span>{t("Μεταφορικά", "Delivery")}</span><span>{o.delivery_fee_cents ? eur(o.delivery_fee_cents) : t("Δωρεάν", "Free")}</span></div>}
            <div className="flex justify-between font-bold text-slate-800 dark:text-slate-100"><span>{t("Σύνολο", "Total")}</span><span>{eur(o.total_cents)}</span></div>
          </div>
          {o.mode === "delivery" && o.address && (
            <div className="flex items-start gap-1.5 rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs text-violet-800">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {o.address.street}, {o.address.area} {o.address.postal}
            </div>
          )}
          {o.note && <div className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">📝 {o.note}</div>}
          <div className="text-[11px] text-slate-400">{t("Παραγγέλθηκε", "Ordered")} {new Date(o.created_at).toLocaleString("el-GR")}</div>
        </div>
      )}
    </div>
  );
}

type FavProduct = Product & { price_at_add?: number | null; price_dropped?: boolean; back_in_stock?: boolean };
function Favorites({ onBack, favBarcodes, toggleFav, add, cart, dec, camps, openProduct }: {
  onBack: () => void; favBarcodes: Set<string>; toggleFav: (bc: string) => void;
  add: (p: Product) => void; cart: Record<string, { p: Product; qty: number }>; dec: (bc: string) => void;
  camps: Campaign[]; openProduct: (p: Product) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<FavProduct[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { patientApi<{ items: FavProduct[] }>("/patient/shop/favorites").then((d) => setItems(d.items)).catch(() => {}).finally(() => setLoading(false)); }, []);
  const shown = items.filter((p) => favBarcodes.has(p.barcode));   // κρύψε αυτά που μόλις αφαίρεσε
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400"><ChevronLeft className="h-4 w-4" /> {t("Στο e-Κατάστημα", "To e-Shop")}</button>
      <div className="flex items-center gap-1.5 text-base font-bold text-slate-800 dark:text-slate-100"><Heart className="h-4 w-4 fill-rose-500 text-rose-500" /> {t("Τα αγαπημένα μου", "My favourites")}</div>
      <p className="text-xs text-slate-400">{t("Σε ειδοποιούμε για", "We notify you about a")} <b>{t("πτώση τιμής", "price drop")}</b> {t("ή", "or")} <b>{t("επιστροφή σε απόθεμα", "back in stock")}</b> {t("(στις Ειδοποιήσεις της Αρχικής).", "(in the Home notifications).")}</p>
      {loading && <div className="py-8 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>}
      {!loading && shown.length === 0 && <div className="py-10 text-center text-sm text-slate-400"><Heart className="mx-auto mb-2 h-8 w-8 text-slate-300" />{t("Δεν έχεις αγαπημένα ακόμη. Πάτα την ❤️ σε ένα προϊόν.", "No favourites yet. Tap the ❤️ on a product.")}</div>}
      {shown.map((p) => {
        const fc = final(p, camps); const inCart = cart[p.barcode]?.qty ?? 0;
        return (
          <div key={p.barcode} className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-sm">
            <button onClick={() => openProduct(p)} title={t("Δες λεπτομέρειες", "View details")} className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-50 dark:bg-slate-900">{imgSrc(p) ? <img src={imgSrc(p)} alt="" className="h-full w-full object-contain" /> : <Pill className="h-5 w-5 text-slate-300" />}</button>
            <div className="min-w-0 flex-1">
              <button onClick={() => openProduct(p)} className="block max-w-full truncate text-left text-sm font-semibold text-slate-800 dark:text-slate-100 hover:text-violet-700">{p.name}</button>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{eur(fc)}</span>
                {p.price_dropped && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">↓ {t("πτώση τιμής", "price drop")}</span>}
                {p.back_in_stock && <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">📦 {t("διαθέσιμο", "available")}</span>}
                {isBackorder(p) && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">{t("κατόπιν παραγγελίας", "backorder")}</span>}
              </div>
            </div>
            <button onClick={() => toggleFav(p.barcode)} title={t("Αφαίρεση", "Remove")} className="grid h-8 w-8 shrink-0 place-items-center"><Heart className="h-[18px] w-[18px] fill-rose-500 text-rose-500" /></button>
            {inCart ? (
              <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-violet-600 px-1 text-white">
                <button onClick={() => dec(p.barcode)} className="grid h-8 w-8 place-items-center"><Minus className="h-4 w-4" /></button>
                <span className="text-xs font-bold">{inCart}</span>
                <button onClick={() => add(p)} className="grid h-8 w-8 place-items-center"><Plus className="h-4 w-4" /></button>
              </div>
            ) : <button onClick={() => add(p)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white"><Plus className="h-4 w-4" /></button>}
          </div>
        );
      })}
    </div>
  );
}

function Subscriptions({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [subs, setSubs] = useState<Sub[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  async function load() { try { const d = await patientApi<{ items: Sub[] }>("/patient/shop/subscriptions"); setSubs(d.items); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);
  async function cancel(id: string) { if (!(await confirmDialog(t("Να ακυρωθεί η συνδρομή;", "Cancel this subscription?")))) return; setBusy(id); try { await patientApi(`/patient/shop/subscriptions/${id}/cancel`, { method: "POST" }); await load(); } finally { setBusy(null); } }
  async function changeFreq(id: string, days: number) { setBusy(id); try { await patientApi(`/patient/shop/subscriptions/${id}/update`, { method: "POST", body: JSON.stringify({ interval_days: days }) }); await load(); toast(t("Η συχνότητα ενημερώθηκε", "Frequency updated"), "success"); } catch { toast(t("Κάτι πήγε στραβά", "Something went wrong"), "error"); } finally { setBusy(null); } }
  async function removeItem(id: string, barcode: string) { if (!(await confirmDialog(t("Αφαίρεση είδους από τη συνδρομή;", "Remove this item from the subscription?")))) return; setBusy(id); try { const r = await patientApi<{ ok: boolean; cancelled?: boolean }>(`/patient/shop/subscriptions/${id}/update`, { method: "POST", body: JSON.stringify({ remove_barcode: barcode }) }); await load(); if (r.cancelled) toast(t("Η συνδρομή ακυρώθηκε (έμεινε χωρίς είδη).", "Subscription cancelled (no items left)."), "info"); } catch { toast(t("Κάτι πήγε στραβά", "Something went wrong"), "error"); } finally { setBusy(null); } }
  const freqLabel = (d: number) => { const f = FREQ.find(([n]) => n === d); return f ? t(f[1], f[2]) : t(`κάθε ${d} ημέρες`, `every ${d} days`); };
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400"><ChevronLeft className="h-4 w-4" /> {t("Στο κατάστημα", "To the shop")}</button>
      <div className="flex items-center gap-1.5 text-base font-bold text-slate-800 dark:text-slate-100"><RefreshCcw className="h-4 w-4 text-violet-600" /> {t("Οι συνδρομές μου", "My subscriptions")}</div>
      <p className="text-xs text-slate-400">{t("Επαναλαμβανόμενες παραγγελίες — άλλαξε συχνότητα, αφαίρεσε είδη ή ακύρωσε όποτε θες.", "Recurring orders — change frequency, remove items or cancel anytime.")}</p>
      {loading && <div className="py-8 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>}
      {!loading && subs.length === 0 && <div className="py-10 text-center text-sm text-slate-400"><RefreshCcw className="mx-auto mb-2 h-8 w-8 text-slate-300" />{t("Δεν έχεις ενεργές συνδρομές. Φτιάξε μία στο checkout επιλέγοντας «Επανάληψη».", "You have no active subscriptions. Create one at checkout by choosing «Repeat».")}</div>}
      {subs.map((s) => {
        const lines = s.lines ?? s.items ?? [];
        const subtotal = s.subtotal_cents ?? lines.reduce((a, l) => a + (l.line_cents ?? 0), 0);
        return (
          <div key={s._id} className={`overflow-hidden rounded-2xl border border-violet-200 bg-white dark:bg-slate-800 shadow-sm transition ${busy === s._id ? "pointer-events-none opacity-60" : ""}`}>
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 bg-violet-50/60 px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-sm font-bold text-violet-800"><RefreshCcw className="h-4 w-4" /> {freqLabel(s.interval_days)}</span>
              <span className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">{s.mode === "delivery" ? <><Truck className="h-3.5 w-3.5" /> {t("Αποστολή", "Delivery")}</> : <><Store className="h-3.5 w-3.5" /> {t("Παραλαβή", "Pickup")}</>}</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 px-3">
              {lines.map((l, i) => (
                <div key={i} className="flex items-center gap-2.5 py-2">
                  <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-50 dark:bg-slate-900">{l.image_id ? <img src={`${API_BASE}/catalog/image/${l.image_id}`} alt="" className="h-full w-full object-contain" /> : <Package className="h-5 w-5 text-slate-300" />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{l.name ?? l.barcode}</div>
                    <div className="text-xs text-slate-400">{eur(l.unit_cents ?? l.price_cents ?? 0)} × {l.qty}{(l.discount_pct ?? 0) > 0 && <span className="ml-1 text-emerald-600">-{l.discount_pct}%</span>}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{eur(l.line_cents ?? 0)}</div>
                    <button onClick={() => removeItem(s._id, l.barcode)} className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-rose-500 hover:underline"><Trash2 className="h-3 w-3" /> {t("Αφαίρεση", "Remove")}</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 px-3 py-2 text-sm">
              <span className="text-slate-500 dark:text-slate-400">{t("Σύνολο ανά παράδοση", "Total per delivery")}</span>
              <span className="font-bold text-slate-900 dark:text-slate-100">{eur(subtotal)}</span>
            </div>
            <div className="space-y-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400">{t("Συχνότητα", "Frequency")}</label>
                <select value={s.interval_days} onChange={(e) => changeFreq(s._id, +e.target.value)} disabled={busy === s._id} className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm">
                  {FREQ.filter(([d]) => d > 0).map(([d, el, en]) => <option key={d} value={d}>{t(el, en)}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-400">{t("Επόμενη παραγγελία:", "Next order:")} <b className="text-slate-600 dark:text-slate-300">{new Date(s.next_run).toLocaleDateString("el-GR")}</b></span>
                <button onClick={() => cancel(s._id)} disabled={busy === s._id} className="text-xs font-semibold text-rose-600 hover:underline">{t("Ακύρωση συνδρομής", "Cancel subscription")}</button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Orders({ orders, setOrders, onBack, onReorder }: { orders: Order[]; setOrders: (o: Order[]) => void; onBack: () => void; onReorder: (o: Order) => void }) {
  const t = useT();
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
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400"><ChevronLeft className="h-4 w-4" /> {t("Στο e-Κατάστημα", "To e-Shop")}</button>
      <div className="text-base font-bold text-slate-800 dark:text-slate-100">{t("Οι παραγγελίες μου", "My orders")}</div>
      {/* Διαχωρισμός: ΕΝΕΡΓΕΣ vs ΙΣΤΟΡΙΚΟ */}
      <div className="flex gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-700 p-1">
        {([["active", t("Ενεργές", "Active"), active.length], ["history", t("Ιστορικό", "History"), past.length]] as const).map(([k, label, n]) => (
          <button key={k} onClick={() => setOView(k)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-semibold transition ${oview === k ? "bg-white dark:bg-slate-800 text-violet-700 shadow-sm" : "text-slate-500 dark:text-slate-400"}`}>
            {label}<span className={`grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[10px] font-bold ${oview === k ? (k === "active" ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-600 dark:text-slate-300") : "bg-slate-200 text-slate-500 dark:text-slate-400"}`}>{n}</span>
          </button>
        ))}
      </div>
      {orders.length === 0 && <div className="py-10 text-center text-sm text-slate-400"><PackageCheck className="mx-auto mb-2 h-8 w-8 text-slate-300" />{t("Δεν έχεις παραγγελίες ακόμη.", "You have no orders yet.")}</div>}
      {orders.length > 0 && list.length === 0 && (
        <div className="py-10 text-center text-sm text-slate-400">
          {oview === "active" ? <><Package className="mx-auto mb-2 h-8 w-8 text-slate-300" />{t("Καμία ενεργή παραγγελία.", "No active orders.")}</> : <><PackageCheck className="mx-auto mb-2 h-8 w-8 text-slate-300" />{t("Δεν υπάρχει ιστορικό ακόμη.", "No history yet.")}</>}
        </div>
      )}
      {list.length > 0 && <div className="space-y-2">{list.map((o) => <OrderCard key={o._id} o={o} onReorder={onReorder} />)}</div>}
    </div>
  );
}

// ── Κύκλωμα «Προσφορές» (my.rxvision.gr) — προϊόντα σε έκπτωση + πακέτα + προσφορές υπηρεσιών ──
type DealProduct = Product & { eff_discount_pct: number; sale_cents: number };
type SvcOffer = { id: string; title: string; description?: string | null; photo_url?: string | null; image_id?: string | null; is_free: boolean; price_cents: number; compare_cents: number; cta: "reserve" | "info" };
const svcImg = (o: SvcOffer) => o.image_id ? `${API_BASE}/catalog/image/${o.image_id}` : (o.photo_url || "");
const TIMES = Array.from({ length: 23 }, (_, i) => { const m = 9 * 60 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });

type OfferBanner = { kind: string; id?: string; title: string; subtitle?: string | null; badge?: string | null; image_id?: string | null; accent: string; target_type: "on_sale" | "brand" | "tag" | "bundles"; target_value?: string | null };
type BrowseFilter = { sort?: string; brand?: string; tag?: string };
const BANNER_ACCENT: Record<string, string> = { rose: "from-rose-500 to-orange-500", violet: "from-violet-500 to-indigo-500", amber: "from-amber-500 to-yellow-500", emerald: "from-emerald-500 to-teal-500", sky: "from-sky-500 to-cyan-500" };

function Offers({ onBack, add, goCart, cartCount, onBrowse }: { onBack: () => void; add: (p: Product) => void; goCart: () => void; cartCount: number; onBrowse: (f: BrowseFilter) => void }) {
  const t = useT();
  const [data, setData] = useState<{ banners?: OfferBanner[]; products: DealProduct[]; bundles: Bundle[]; services: SvcOffer[] } | null>(null);
  const [reserve, setReserve] = useState<SvcOffer | null>(null);
  useEffect(() => { patientApi<{ banners?: OfferBanner[]; products: DealProduct[]; bundles: Bundle[]; services: SvcOffer[] }>("/patient/shop/offers").then(setData).catch(() => setData({ products: [], bundles: [], services: [] })); }, []);
  const empty = data && data.products.length === 0 && data.bundles.length === 0 && data.services.length === 0;
  function clickBanner(b: OfferBanner) {
    if (b.target_type === "bundles") { document.getElementById("offers-bundles")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (b.target_type === "brand" && b.target_value) { onBrowse({ brand: b.target_value }); return; }
    if (b.target_type === "tag" && b.target_value) { onBrowse({ tag: b.target_value }); return; }
    onBrowse({ sort: "on_sale" });   // «όλα σε προσφορά» → κατάλογος ταξινομημένος σε εκπτώσεις
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700"><ChevronLeft className="h-4 w-4" /> {t("Πίσω στο κατάστημα", "Back to shop")}</button>
        {cartCount > 0 && <button onClick={goCart} className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white"><ShoppingCart className="h-4 w-4" /> {t("Καλάθι", "Cart")} ({cartCount})</button>}
      </div>
      <div className="flex items-center gap-2">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-sm"><Flame className="h-5 w-5" /></span>
        <div className="leading-tight"><div className="text-lg font-extrabold text-slate-900 dark:text-slate-100">{t("Προσφορές", "Offers")}</div><div className="text-[11px] text-slate-400">{t("Ό,τι μπορείς να προμηθευτείς ή να κλείσεις με προσφορά, τώρα", "Everything you can buy or book on offer, right now")}</div></div>
      </div>

      {/* Slider θεματικών banners (2.3) — clickable → φιλτραρισμένη λίστα προϊόντων */}
      {!!data?.banners?.length && (
        <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {data.banners.map((b, i) => (
            <button key={b.id ?? `auto-${i}`} onClick={() => clickBanner(b)} className={`relative flex h-24 w-64 shrink-0 flex-col justify-end overflow-hidden rounded-2xl p-3 text-left text-white shadow-sm transition hover:brightness-105 sm:w-72 ${b.image_id ? "bg-slate-800" : `bg-gradient-to-r ${BANNER_ACCENT[b.accent] ?? BANNER_ACCENT.rose}`}`}>
              {b.image_id && <img src={`${API_BASE}/catalog/image/${b.image_id}`} alt="" className="absolute inset-0 h-full w-full object-cover" />}
              <span className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
              {b.badge && <span className="absolute right-2 top-2 z-10 rounded-lg bg-white/25 px-2 py-0.5 text-xs font-extrabold backdrop-blur">{b.badge}</span>}
              <span className="relative z-10 min-w-0">
                <span className="block truncate text-sm font-extrabold drop-shadow">{b.title}</span>
                {b.subtitle && <span className="block truncate text-[11px] opacity-90 drop-shadow">{b.subtitle}</span>}
                <span className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold opacity-95">{t("Δες προϊόντα", "See products")} <ChevronRight className="h-3 w-3" /></span>
              </span>
            </button>
          ))}
        </div>
      )}

      {!data && <div className="py-10 text-center text-sm text-slate-400"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> {t("Φόρτωση…", "Loading…")}</div>}
      {empty && <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-600 p-10 text-center text-sm text-slate-400">{t("Δεν υπάρχουν ενεργές προσφορές αυτή τη στιγμή.", "There are no active offers right now.")}</div>}

      {/* Προϊόντα σε έκπτωση */}
      {!!data?.products.length && (
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><Flame className="h-4 w-4 text-rose-500" /> {t("Προϊόντα σε έκπτωση", "Discounted products")}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {data.products.map((p) => (
              <div key={p.barcode} className="flex flex-col overflow-hidden rounded-2xl border border-rose-100 bg-white dark:bg-slate-800 shadow-sm">
                <div className="relative aspect-square bg-slate-50 dark:bg-slate-900">
                  {imgSrc(p) ? <img src={imgSrc(p)} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full w-full place-items-center text-slate-300"><Pill className="h-8 w-8" /></span>}
                  <span className="absolute left-1.5 top-1.5 rounded-md bg-rose-600 px-1.5 py-0.5 text-[11px] font-bold text-white">−{p.eff_discount_pct}%</span>
                </div>
                <div className="flex flex-1 flex-col p-2.5">
                  <div className="line-clamp-2 text-xs font-semibold text-slate-800 dark:text-slate-100">{p.name}</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-sm font-extrabold text-rose-600">{eur(p.sale_cents)}</span>
                    <span className="text-[11px] text-slate-400 line-through">{eur(p.price_cents)}</span>
                  </div>
                  <button onClick={() => { add(p); toast(t("Προστέθηκε στο καλάθι", "Added to cart"), "success"); }} className="mt-2 inline-flex items-center justify-center gap-1 rounded-lg bg-violet-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"><Plus className="h-3.5 w-3.5" /> {t("Στο καλάθι", "Add to cart")}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Πακέτα */}
      {!!data?.bundles.length && (
        <section id="offers-bundles">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><Package className="h-4 w-4 text-amber-500" /> {t("Πακέτα προσφορών", "Offer bundles")}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.bundles.map((b, i) => (
              <div key={i} className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-600"><Package className="h-5 w-5" /></span>
                <div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{b.name}</div>
                  <div className="text-[11px] text-amber-700">{b.kind === "nplusm" ? t(`${b.buy_qty}+${b.free_qty} δώρο`, `${b.buy_qty}+${b.free_qty} free`) : t(`Πακέτο −${b.discount_pct}%`, `Bundle −${b.discount_pct}%`)}</div></div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">{t("Τα πακέτα εφαρμόζονται αυτόματα στο καλάθι όταν προσθέσεις τα είδη τους.", "Bundles apply automatically to your cart once you add their items.")}</p>
        </section>
      )}

      {/* Υπηρεσίες σε προσφορά → κράτηση ραντεβού */}
      {!!data?.services.length && (
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><Sparkles className="h-4 w-4 text-fuchsia-500" /> {t("Υπηρεσίες σε προσφορά", "Services on offer")}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.services.map((o) => (
              <div key={o.id} className="flex items-start gap-3 rounded-2xl border border-fuchsia-200 bg-white dark:bg-slate-800 p-3 shadow-sm">
                {svcImg(o) ? <img src={svcImg(o)} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" /> : <span className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-fuchsia-100 text-fuchsia-500"><Sparkles className="h-6 w-6" /></span>}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{o.title}</div>
                  <div className="mt-0.5 text-sm">
                    {o.is_free ? <span className="font-bold text-emerald-600">{t("Δωρεάν", "Free")}</span> : (<><span className="font-extrabold text-fuchsia-600">{eur(o.price_cents)}</span>{o.compare_cents > 0 && <span className="ml-1.5 text-xs text-slate-400 line-through">{eur(o.compare_cents)}</span>}</>)}
                  </div>
                  {o.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{o.description}</p>}
                  {o.cta === "reserve"
                    ? <button onClick={() => setReserve(o)} className="mt-2 inline-flex items-center gap-1 rounded-lg bg-fuchsia-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-fuchsia-700"><CalendarCheck className="h-3.5 w-3.5" /> {t("Κλείσε ραντεβού", "Book appointment")}</button>
                    : <div className="mt-2 text-[11px] text-slate-400">{t("Ρώτησε στο φαρμακείο", "Ask at the pharmacy")}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {reserve && <ReserveModal offer={reserve} onClose={() => setReserve(null)} />}
    </div>
  );
}

function ReserveModal({ offer, onClose }: { offer: SvcOffer; onClose: () => void }) {
  const t = useT();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!date) { toast(t("Διάλεξε ημερομηνία", "Choose a date"), "error"); return; }
    setBusy(true);
    try {
      const requested_at = new Date(`${date}T${time}:00`).toISOString();
      await patientApi("/patient/appointments", { method: "POST", body: JSON.stringify({ service_id: offer.id, service_name: offer.title, kind: "service", requested_at, note: note || null }) });
      toast(t("Το αίτημα ραντεβού στάλθηκε — το φαρμακείο θα επιβεβαιώσει.", "Appointment request sent — the pharmacy will confirm."), "success");
      onClose();
    } catch { toast(t("Κάτι πήγε στραβά — δοκίμασε ξανά.", "Something went wrong — please try again."), "error"); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-[130] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white dark:bg-slate-800 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-base font-bold text-slate-800 dark:text-slate-100">{t("Κράτηση ραντεβού", "Book appointment")}</div>
        <div className="mb-3 text-sm text-fuchsia-600">{offer.title}{!offer.is_free && ` · ${eur(offer.price_cents)}`}{offer.is_free && t(" · Δωρεάν", " · Free")}</div>
        <div className="space-y-3">
          <div><label className="text-xs text-slate-500 dark:text-slate-400">{t("Ημερομηνία", "Date")}</label><DateInput value={date} onChange={setDate} /></div>
          <label className="block text-xs text-slate-500 dark:text-slate-400">{t("Ώρα", "Time")}
            <select value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm">{TIMES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}</select></label>
          <label className="block text-xs text-slate-500 dark:text-slate-400">{t("Σημείωση (προαιρετικό)", "Note (optional)")}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm" /></label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">{t("Άκυρο", "Cancel")}</button>
          <button onClick={submit} disabled={busy} className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white hover:bg-fuchsia-700 disabled:opacity-50">{busy ? t("Αποστολή…", "Sending…") : t("Κλείσε ραντεβού", "Book appointment")}</button>
        </div>
      </div>
    </div>
  );
}

// ── Σελίδα προϊόντος (PDP) — gallery + πλήρης περιγραφή + τιμή/προσφορά + στο καλάθι ──
// Αντίστροφη μέτρηση flash προσφοράς — ticking κάθε δευτερόλεπτο.
function Countdown({ to }: { to: string }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const end = new Date(to).getTime();
  const ms = end - now;
  if (!isFinite(end) || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const label = d > 0 ? t(`${d}η ${h}ω ${m}λ`, `${d}d ${h}h ${m}m`) : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return <span className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">⏳ {t("Λήγει σε", "Ends in")} {label}</span>;
}

// Σπάει την ελεύθερη περιγραφή σε ενότητες όταν περιέχει γνωστές επικεφαλίδες
// (π.χ. «Οδηγίες χρήσης:», «Συστατικά:»). Χωρίς επικεφαλίδες → μία ενότητα «Περιγραφή».
const _SECTION_KEYS: [RegExp, string, string][] = [
  [/^\s*(περιγραφή|description)\s*[:：]/i, "Περιγραφή", "Description"],
  [/^\s*(οδηγίες\s*χρήσης|τρόπος\s*χρήσης|οδηγίες|χρήση|δοσολογία|directions|usage|dosage|how\s*to\s*use)\s*[:：]/i, "Οδηγίες χρήσης", "Directions"],
  [/^\s*(συστατικά|σύνθεση|δραστικά\s*συστατικά|ingredients|composition)\s*[:：]/i, "Συστατικά", "Ingredients"],
  [/^\s*(προφυλάξεις|προειδοποιήσεις|αντενδείξεις|παρενέργειες|warnings|precautions)\s*[:：]/i, "Προφυλάξεις", "Warnings"],
  [/^\s*(φύλαξη|αποθήκευση|συντήρηση|storage)\s*[:：]/i, "Φύλαξη", "Storage"],
];
function parseSections(text: string): { el: string; en: string; body: string }[] {
  const out: { el: string; en: string; body: string }[] = [];
  let cur: { el: string; en: string; body: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let matched = false;
    for (const [re, el, en] of _SECTION_KEYS) {
      const m = raw.match(re);
      if (m) { cur = { el, en, body: raw.slice(m[0].length).trim() }; out.push(cur); matched = true; break; }
    }
    if (!matched) {
      if (!cur) { cur = { el: "Περιγραφή", en: "Description", body: "" }; out.push(cur); }
      cur.body += (cur.body ? "\n" : "") + raw;
    }
  }
  return out.filter((s) => s.body.trim());
}

function ProductModal({ product, camps, inCart, add, dec, onClose, onVideo, isFav, toggleFav }: {
  product: Product; camps: Campaign[]; inCart: number; add: (p: Product) => void; dec: (bc: string) => void;
  onClose: () => void; onVideo: (url: string) => void; isFav: boolean; toggleFav: (bc: string) => void;
}) {
  const t = useT();
  const [full, setFull] = useState<Product>(product);
  const [idx, setIdx] = useState(0);
  useEffect(() => {   // φέρε το πλήρες προϊόν (gallery + long description) — η κάρτα έχει μόνο περίληψη
    patientApi<Product>(`/patient/shop/product/${encodeURIComponent(product.barcode)}`).then(setFull).catch(() => {});
  }, [product.barcode]);
  const gallery = imgList(full);
  const dPct = effDisc(full, camps);
  const fc = final(full, camps);
  const vid = videoEmbed(full.usage_video_url);
  const back = isBackorder(full);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {   // portal + κλείδωμα scroll του body όσο είναι ανοιχτό
    setMounted(true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/60 p-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-2xl bg-white dark:bg-slate-800 shadow-2xl sm:max-h-[92vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 dark:border-slate-800 px-4 py-3">
          <div className="min-w-0 truncate pr-2 text-sm font-bold text-slate-800 dark:text-slate-100">{full.name}</div>
          <button onClick={onClose} aria-label={t("Κλείσιμο", "Close")} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"><Plus className="h-5 w-5 rotate-45" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid min-w-0 gap-4 p-4 sm:grid-cols-2">
          {/* Gallery */}
          <div className="min-w-0">
            <div className="relative grid aspect-square place-items-center overflow-hidden rounded-xl bg-slate-50 dark:bg-slate-900">
              {gallery.length ? <img src={gallery[idx]} alt="" className="h-full w-full object-contain" /> : <Package className="h-12 w-12 text-slate-300" />}
              {dPct > 0 && <span className="absolute left-2 top-2 rounded-md bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">−{dPct}%</span>}
              <button onClick={() => toggleFav(full.barcode)} className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-white/90 shadow"><Heart className={`h-5 w-5 ${isFav ? "fill-rose-500 text-rose-500" : "text-slate-400"}`} /></button>
            </div>
            {gallery.length > 1 && (
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {gallery.map((g, i) => (
                  <button key={i} onClick={() => setIdx(i)} className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 ${i === idx ? "border-violet-500" : "border-transparent"}`}><img src={g} alt="" className="h-full w-full object-cover" /></button>
                ))}
              </div>
            )}
            {vid && <button onClick={() => onVideo(vid)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white">▶ {t("Οδηγίες χρήσης (βίντεο)", "Usage instructions (video)")}</button>}
          </div>
          {/* Πληροφορίες */}
          <div className="flex min-w-0 flex-col">
            {full.category && <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{full.category}</div>}
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {full.tags?.map((tg) => <span key={tg} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tagCls(tg)}`}>{tg}</span>)}
              {(full.points_multiplier ?? 1) > 1 && <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800">🎁 ×{full.points_multiplier} {t("πόντοι", "points")}</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-extrabold text-slate-900 dark:text-slate-100">{eur(fc)}</span>
              {fc < full.price_cents && <span className="text-sm text-slate-400 line-through">{eur(full.price_cents)}</span>}
              {dPct > 0 && full.sale_ends_at && <Countdown to={full.sale_ends_at} />}
            </div>
            {!!full.highlights?.length && (
              <ul className="mt-2 space-y-0.5">
                {full.highlights.map((h, i) => <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />{h}</li>)}
              </ul>
            )}
            {back ? <div className="mt-1 text-xs font-semibold text-amber-700">{t("Κατόπιν παραγγελίας — το φαρμακείο επιβεβαιώνει διαθεσιμότητα", "Backorder — the pharmacy confirms availability")}</div>
                  : full.stock_qty <= LOW_STOCK && full.stock_qty > 0 ? <div className="mt-1 text-xs font-semibold text-orange-600">{t(`Τελευταία ${full.stock_qty} τεμάχια`, `Last ${full.stock_qty} units`)}</div> : null}
            {(() => {
              const desc = full.description_long || full.description_short || "";
              if (!desc.trim()) return null;
              const secs = parseSections(desc);
              // Απλή περιγραφή (μία ενότητα) → παράγραφος όπως πριν· δομημένη → πτυσσόμενες ενότητες.
              if (secs.length <= 1) return <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">{desc}</p>;
              return (
                <div className="mt-3 space-y-1.5">
                  {secs.map((s, i) => (
                    <details key={i} open={i === 0} className="group rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40">
                      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                        {t(s.el, s.en)}<ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
                      </summary>
                      <p className="whitespace-pre-wrap break-words px-3 pb-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{s.body.trim()}</p>
                    </details>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
        {!!full.related?.length && (
          <div className="border-t border-slate-100 dark:border-slate-800 p-4">
            <div className="mb-2 text-sm font-bold text-slate-800 dark:text-slate-100">{t("Συχνά μαζί", "Frequently bought together")}</div>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {full.related.map((r) => (
                <button key={r.barcode} onClick={() => { add(r); toast(t("Προστέθηκε στο καλάθι", "Added to cart"), "success"); }} className="w-28 shrink-0 rounded-xl border border-slate-200 dark:border-slate-700 p-2 text-left transition hover:border-violet-300">
                  <div className="grid h-20 place-items-center overflow-hidden rounded-lg bg-slate-50 dark:bg-slate-900">{imgList(r)[0] ? <img src={imgList(r)[0]} alt="" className="h-full w-full object-contain" /> : <Package className="h-6 w-6 text-slate-300" />}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] font-medium leading-tight text-slate-700 dark:text-slate-200">{r.name}</div>
                  <div className="mt-0.5 text-xs font-bold text-slate-900 dark:text-slate-100">{eur(r.sale_cents ?? r.price_cents)}</div>
                  <div className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-violet-600"><Plus className="h-3 w-3" /> {t("Προσθήκη", "Add")}</div>
                </button>
              ))}
            </div>
          </div>
        )}
        </div>
        {/* Sticky footer — το κουμπί «Προσθήκη στο καλάθι» πάντα ορατό (δεν χάνεται στο scroll) */}
        <div className="shrink-0 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-800 p-3">
          {inCart ? (
            <div className="flex items-center justify-between rounded-xl bg-violet-600 px-2 py-1.5 text-white">
              <button onClick={() => dec(full.barcode)} className="grid h-10 w-10 place-items-center rounded-lg hover:bg-white/10"><Minus className="h-5 w-5" /></button>
              <span className="text-sm font-bold">{inCart} {t("στο καλάθι", "in cart")} · {eur(fc * inCart)}</span>
              <button onClick={() => add(full)} className="grid h-10 w-10 place-items-center rounded-lg hover:bg-white/10"><Plus className="h-5 w-5" /></button>
            </div>
          ) : (
            <button onClick={() => { add(full); toast(t("Προστέθηκε στο καλάθι", "Added to cart"), "success"); }} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 py-3 text-sm font-bold text-white hover:bg-violet-700"><Plus className="h-5 w-5" /> {t("Προσθήκη στο καλάθι", "Add to cart")} · {eur(fc)}</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
