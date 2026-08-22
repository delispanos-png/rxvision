"use client";

import { useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Truck, Search, Plus, Pencil, Trash2, Upload, X, Loader2, Sparkles, Package, Pill, Star, ImagePlus, ArrowDownUp, Database, Check } from "lucide-react";
import { api, apiUpload, API_BASE } from "@/lib/apiClient";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useCategoryTree, catPath } from "@/components/catalog/CategoryPicker";
import { DateInput } from "@/components/ui/DateInput";

type Product = {
  barcode: string; name: string; description_short?: string | null; description_long?: string | null;
  photo_url?: string | null; image_id?: string | null; images?: string[]; usage_video_url?: string | null; price_cents: number; wholesale_cents?: number; type: string; category?: string | null;
  cat1_id?: string | null; cat2_id?: string | null; cat3_id?: string | null;
  tags?: string[]; featured?: boolean; is_fyk?: boolean; participation?: number; discount_pct: number; stock_qty: number; active?: boolean;
  // καθαρά πωλησιακά e-shop
  sale_starts_at?: string | null; sale_ends_at?: string | null; highlights?: string[]; related_barcodes?: string[]; points_multiplier?: number;
};
type ListRes = { items: Product[]; total: number };
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const EMPTY: Product = { barcode: "", name: "", price_cents: 0, type: "parapharmacy", discount_pct: 0, stock_qty: 0, tags: [], featured: false };
const LOW_STOCK = 5;
type TaxClass = { type: string; label: string; discount: boolean; auto: boolean; categories: string[] };
type Taxonomy = { classes: TaxClass[] };
const TYPE_LABEL: Record<string, string> = { rx_medicine: "Συνταγογραφούμενο", otc_medicine: "ΜΗ.ΣΥ.ΦΑ. (OTC)", parapharmacy: "Παραφάρμακο" };
const isMed = (t: string) => t === "rx_medicine" || t === "otc_medicine";
const noDisc = (t: string) => t === "rx_medicine";   // μόνο τα συνταγογραφούμενα → 0% έκπτωση
// Κερδοφορία: κέρδος = λιανική − χονδρική· % = κέρδος/λιανική. rebate note = ΕΟΠΥΥ φάρμακο (rx, όχι εμβόλιο/ΦΥΚ).
const profitCents = (p: Product) => (p.wholesale_cents && p.wholesale_cents > 0) ? p.price_cents - p.wholesale_cents : null;
const profitPct = (p: Product) => { const g = profitCents(p); return g != null && p.price_cents > 0 ? Math.round(1000 * g / p.price_cents) / 10 : null; };
const showRebate = (p: Product) => p.type === "rx_medicine" && p.category !== "Εμβόλια" && !p.is_fyk;
// Advanced (συνταγογραφούμενα): συμμετοχή ασφαλισμένου = λιανική × participation%· αιτούμενο ταμείου = υπόλοιπο.
const patientShare = (p: Product) => p.type === "rx_medicine" ? Math.round(p.price_cents * (p.participation ?? 0) / 100) : null;
const fundClaim = (p: Product) => { const s = patientShare(p); return s != null ? p.price_cents - s : null; };
const imgSrc = (p: Product) => p.image_id ? `${API_BASE}/catalog/image/${p.image_id}` : (p.photo_url || "");
// έτοιμα «ειδικά» tags με χρώμα· ό,τι άλλο → ουδέτερο chip
const TAG_STYLE: Record<string, string> = {
  "Προσφορά": "bg-rose-100 text-rose-700", "Νέο": "bg-emerald-100 text-emerald-700",
  "Δημοφιλές": "bg-amber-100 text-amber-800", "Bestseller": "bg-amber-100 text-amber-800",
  "Προτεινόμενο": "bg-violet-100 text-violet-700", "Εξάντληση": "bg-orange-100 text-orange-700",
};
const tagCls = (t: string) => TAG_STYLE[t] || "bg-slate-100 text-slate-600";
const QUICK_TAGS = ["Προσφορά", "Νέο", "Δημοφιλές", "Βιολογικό", "Χωρίς γλουτένη", "Vegan"];
const SORTS: [string, string][] = [["featured", "Προτεινόμενα"], ["newest", "Νεότερα"], ["price_asc", "Φθηνότερα"], ["price_desc", "Ακριβότερα"], ["name", "Αλφαβητικά"]];

export default function CatalogPage() {
  return <ModuleGuard module="order_delivery"><Catalog /></ModuleGuard>;
}

function Catalog() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState("featured");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [term, type, sort]);   // νέα αναζήτηση/φίλτρο → σελίδα 1
  const [edit, setEdit] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  const [registry, setRegistry] = useState(false);
  const [busy, setBusy] = useState(false);

  const PAGE_SIZE = 60;
  const list = useQuery({
    queryKey: ["catalog", term, type, sort, page],
    queryFn: () => api<ListRes>(`/catalog?page_size=${PAGE_SIZE}&page=${page}&q=${encodeURIComponent(term)}&type=${type}&sort=${sort}&for_sale=true`),
    retry: false,
  });
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tax = useQuery({ queryKey: ["catalog-taxonomy"], queryFn: () => api<Taxonomy>("/catalog/taxonomy"), staleTime: 3600_000, retry: false });

  async function save(p: Product) {
    setBusy(true);
    try {
      const price_cents = Math.round((Number((p as unknown as { price_eur?: number }).price_eur ?? p.price_cents / 100)) * 100);
      const wholesale_cents = Math.round((Number((p as unknown as { wholesale_eur?: number }).wholesale_eur ?? (p.wholesale_cents ?? 0) / 100)) * 100);
      await api("/catalog", { method: "POST", body: JSON.stringify({ ...p, price_cents, wholesale_cents }) });
      setEdit(null); await list.refetch();
    } finally { setBusy(false); }
  }
  async function del(barcode: string) {
    if (!(await appConfirm("Διαγραφή του είδους από τον κατάλογο;", { title: "Διαγραφή είδους", danger: true, confirmText: "Διαγραφή" }))) return;
    await api(`/catalog/${encodeURIComponent(barcode)}`, { method: "DELETE" }); list.refetch();
  }

  const items = list.data?.items ?? [];
  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-800"><Truck className="h-6 w-6 text-brand-600" /> Κατάλογος ειδών (e-shop)</div>
      <p className="mb-4 text-sm text-slate-500">Τα είδη που έχεις βάλει <b>«προς πώληση»</b> από την <b>Αποθήκη</b> — οι πελάτες παραγγέλνουν από εδώ. Εδώ ρυθμίζεις εικόνες, περιγραφή & πωλησιακά εργαλεία. Οι <b>προσφορές/καμπάνιες/κουπόνια/πακέτα</b> είναι πλέον στο ξεχωριστό κύκλωμα <b>«Προσφορές»</b>.</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση (όνομα/barcode)…" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
        </form>
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
          <option value="">Όλα</option>
          <option value="rx_medicine">Συνταγογραφούμενα</option>
          <option value="otc_medicine">ΜΗ.ΣΥ.ΦΑ. (OTC)</option>
          <option value="parapharmacy">Παραφάρμακα</option>
        </select>
        <div className="relative"><ArrowDownUp className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-lg border border-slate-300 py-2 pl-7 pr-2 text-sm">{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <button onClick={() => setRegistry(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100"><Database className="h-4 w-4" /> Φάρμακα από μητρώο</button>
        <button onClick={() => setImporting(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"><Upload className="h-4 w-4" /> Εισαγωγή XML</button>
        <button onClick={() => setEdit({ ...EMPTY })} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> Νέο είδος</button>
      </div>

      <div className="mb-3 text-xs text-slate-400">{list.isLoading ? "Φόρτωση…" : `${list.data?.total ?? 0} είδη`}</div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((p) => {
          const med = isMed(p.type);
          return (
            <div key={p.barcode} className={`flex gap-3 rounded-xl border bg-white p-3 ${p.featured ? "border-amber-300 ring-1 ring-amber-100" : "border-slate-200"}`}>
              <div className="relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-50">
                {imgSrc(p) ? <img src={imgSrc(p)} alt="" className="h-full w-full object-contain" /> : (med ? <Pill className="h-6 w-6 text-slate-300" /> : <Package className="h-6 w-6 text-slate-300" />)}
                {p.featured && <Star className="absolute left-0.5 top-0.5 h-3.5 w-3.5 fill-amber-400 text-amber-500" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate text-sm font-semibold text-slate-800">{p.name || "—"}</div>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => setEdit({ ...p, ...({ price_eur: p.price_cents / 100 } as object) })} className="rounded p-1 text-slate-400 hover:text-brand-600"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => del(p.barcode)} className="rounded p-1 text-slate-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${p.type === "rx_medicine" ? "bg-rose-50 text-rose-600" : p.type === "otc_medicine" ? "bg-sky-50 text-sky-600" : "bg-violet-50 text-violet-600"}`}>{TYPE_LABEL[p.type] || p.type}</span>
                  {p.category && <span>{p.category}</span>}
                  <span>· {p.barcode}</span>
                </div>
                {!!p.tags?.length && <div className="mt-1 flex flex-wrap gap-1">{p.tags.map((t) => <span key={t} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tagCls(t)}`}>{t}</span>)}</div>}
                <div className="mt-1 flex items-center gap-2 text-sm">
                  <b className="text-slate-800">{eur(p.price_cents)}</b>
                  {p.discount_pct > 0 && <span className="rounded bg-emerald-50 px-1.5 text-[11px] font-semibold text-emerald-700">-{p.discount_pct}%</span>}
                  <span className={`ml-auto text-[11px] ${p.stock_qty <= 0 ? "text-amber-600" : p.stock_qty <= LOW_STOCK ? "text-orange-600" : "text-slate-500"}`}>{p.stock_qty <= 0 ? "κατόπιν παραγγελίας" : p.stock_qty <= LOW_STOCK ? `τελευταία ${p.stock_qty} τεμ.` : `απόθεμα: ${p.stock_qty}`}</span>
                </div>
                {profitCents(p) != null && <div className="mt-0.5 text-[11px] text-slate-500">κέρδος <b className="text-emerald-700">{eur(profitCents(p) as number)}</b> ({profitPct(p)}%){showRebate(p) && <span className="ml-1 text-amber-600" title="Η κερδοφορία υπόκειται επιπλέον σε rebate ΕΟΠΥΥ (κλιμακωτό)">· υπόκειται σε rebate</span>}</div>}
                {patientShare(p) != null && p.price_cents > 0 && <div className="text-[10px] text-slate-400">εκτέλεση: ασφ. {eur(patientShare(p) as number)} · ταμείο {eur(fundClaim(p) as number)}</div>}
              </div>
            </div>
          );
        })}
        {!list.isLoading && items.length === 0 && <div className="col-span-full rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Άδειος κατάλογος — πρόσθεσε είδη ή κάνε εισαγωγή XML.</div>}
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <button disabled={page <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">← Προηγούμενη</button>
          <span className="text-slate-500">Σελίδα {page} από {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">Επόμενη →</button>
        </div>
      )}

      {edit && <EditModal product={edit} busy={busy} tax={tax.data} onClose={() => setEdit(null)} onSave={save} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); list.refetch(); }} />}
      {registry && <RegistryModal tax={tax.data} onClose={() => setRegistry(false)} onDone={() => list.refetch()} />}
    </div>
  );
}

type RegItem = { barcode: string; name: string; price_cents: number; category: string; narcotic: boolean; activated: boolean };
function RegistryModal({ tax, onClose, onDone }: { tax?: Taxonomy; onClose: () => void; onDone: () => void }) {
  const medCats = tax?.classes.find((c) => c.type === "rx_medicine")?.categories ?? [];
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [ptype, setPtype] = useState("rx_medicine");
  const [stock, setStock] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const reg = useQuery({
    queryKey: ["catalog-registry", term, cat],
    queryFn: () => api<{ items: RegItem[]; total: number }>(`/catalog/registry?q=${encodeURIComponent(term)}&category=${encodeURIComponent(cat)}`),
    enabled: !!(term || cat), retry: false,
  });
  const items = reg.data?.items ?? [];
  const toggle = (bc: string) => setSel((s) => { const n = new Set(s); n.has(bc) ? n.delete(bc) : n.add(bc); return n; });
  async function activateSel() {
    if (!sel.size) return;
    setBusy("sel");
    try { await api("/catalog/activate", { method: "POST", body: JSON.stringify({ barcodes: [...sel], type: ptype, stock_qty: stock }) }); setSel(new Set()); reg.refetch(); onDone(); }
    finally { setBusy(""); }
  }
  async function activateCat() {
    if (!cat) return;
    if (!(await appConfirm(`Ενεργοποίηση ΟΛΗΣ της κατηγορίας «${cat}» προς πώληση; (μπορεί να είναι πολλά είδη)`, { title: "Ενεργοποίηση κατηγορίας", confirmText: "Ενεργοποίηση" }))) return;
    setBusy("cat");
    try { const r = await api<{ activated: number }>("/catalog/activate", { method: "POST", body: JSON.stringify({ category: cat, type: ptype, stock_qty: stock }) }); await appAlert(`Ενεργοποιήθηκαν ${r.activated} είδη.`, { title: "Ολοκληρώθηκε" }); reg.refetch(); onDone(); }
    finally { setBusy(""); }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2 text-lg font-semibold text-slate-800"><Database className="h-5 w-5 text-emerald-600" /> Φάρμακα από το μητρώο ΗΔΥΚΑ</div><button onClick={onClose}><X className="h-5 w-5 text-slate-400" /></button></div>
        <p className="mb-3 text-xs text-slate-500">Διάλεξε θεραπευτική κατηγορία ή αναζήτησε, τσέκαρε τα είδη και όρισέ τα «προς πώληση». Κατηγορία & τιμή μπαίνουν αυτόματα — μετά αλλάζεις ό,τι θες.</p>
        <div className="mb-2 flex flex-wrap gap-2">
          <select value={cat} onChange={(e) => { setCat(e.target.value); setSel(new Set()); }} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">— κατηγορία —</option>{medCats.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="relative flex-1 min-w-[160px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση φαρμάκου/barcode…" className="w-full rounded-lg border border-slate-300 py-1.5 pl-8 pr-2 text-sm" />
          </form>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">Ως:</span>
          <select value={ptype} onChange={(e) => setPtype(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs"><option value="rx_medicine">Συνταγογραφούμενο</option><option value="otc_medicine">ΜΗ.ΣΥ.ΦΑ. (OTC)</option></select>
          <span className="text-slate-500">Απόθεμα:</span>
          <input type="number" value={stock} onChange={(e) => setStock(+e.target.value)} className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-xs" />
          <span className="text-[10px] text-amber-600">{stock > 0 ? "" : "0 = κατόπιν παραγγελίας"}</span>
          <span className="ml-auto text-slate-400">{reg.data ? `${reg.data.total} στο μητρώο` : ""}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-200">
          {reg.isLoading && <div className="p-6 text-center text-sm text-slate-400">Φόρτωση…</div>}
          {!reg.isLoading && !term && !cat && <div className="p-6 text-center text-sm text-slate-400">Διάλεξε κατηγορία ή αναζήτησε για να δεις φάρμακα.</div>}
          {items.map((it) => (
            <label key={it.barcode} className={`flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-0 ${it.activated ? "bg-emerald-50/50" : "hover:bg-slate-50"}`}>
              <input type="checkbox" disabled={it.activated} checked={it.activated || sel.has(it.barcode)} onChange={() => toggle(it.barcode)} />
              <div className="min-w-0 flex-1"><div className="truncate font-medium text-slate-800">{it.name}</div><div className="text-[11px] text-slate-400">{it.category} · {it.barcode}{it.narcotic ? " · ⚠️ ναρκωτικό" : ""}</div></div>
              <div className="shrink-0 text-sm font-semibold text-slate-700">{eur(it.price_cents)}</div>
              {it.activated && <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"><Check className="inline h-3 w-3" /> προς πώληση</span>}
            </label>
          ))}
          {!reg.isLoading && (term || cat) && items.length === 0 && <div className="p-6 text-center text-sm text-slate-400">Κανένα αποτέλεσμα.</div>}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          {cat ? <button onClick={activateCat} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">{busy === "cat" && <Loader2 className="h-4 w-4 animate-spin" />} Όλη η κατηγορία</button> : <span />}
          <button onClick={activateSel} disabled={!sel.size || !!busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{busy === "sel" && <Loader2 className="h-4 w-4 animate-spin" />} Προς πώληση ({sel.size})</button>
        </div>
      </div>
    </div>
  );
}

// Κατηγορία δέντρου e-shop — read-only προβολή· ρυθμίζεται στην Αποθήκη (κοινό χαρακτηριστικό του είδους).
function InheritedCategory({ f }: { f: Product }) {
  const { data } = useCategoryTree();
  const cats = data?.items ?? [];
  const path = catPath(cats, { cat1_id: f.cat1_id, cat2_id: f.cat2_id, cat3_id: f.cat3_id });
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 text-xs text-slate-500">
      <div className="mb-1 font-semibold text-slate-600">🗂️ Κατηγορία e-shop (μενού πύλης)</div>
      {path
        ? <div className="font-medium text-slate-700">{path}</div>
        : <div className="text-amber-600">Δεν έχει οριστεί κατηγορία δέντρου. Όρισέ την στην <b>Αποθήκη</b>.</div>}
      <span className="mt-1 block text-[11px] text-slate-400">Η κατηγορία είναι κοινό χαρακτηριστικό του είδους — ρυθμίζεται στην <b>Αποθήκη</b> και εμφανίζεται εδώ αυτόματα (οδηγεί το μενού της πύλης & τη στόχευση προσφορών).</span>
    </div>
  );
}

function EditModal({ product, busy, tax, onClose, onSave }: { product: Product; busy: boolean; tax?: Taxonomy; onClose: () => void; onSave: (p: Product) => void }) {
  const [f, setF] = useState<Product & { price_eur?: number; wholesale_eur?: number }>({ ...product, tags: product.tags ?? [], price_eur: (product as { price_eur?: number }).price_eur ?? product.price_cents / 100, wholesale_eur: (product.wholesale_cents ?? 0) / 100 });
  const [tagIn, setTagIn] = useState("");
  const [up, setUp] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Cross-sell «συχνά μαζί»: αναζήτηση ειδών προς προσθήκη
  const [relQ, setRelQ] = useState("");
  const [relNames, setRelNames] = useState<Record<string, string>>({});
  const relSearch = useQuery({ queryKey: ["catalog-rel-search", relQ], queryFn: () => api<ListRes>(`/catalog?q=${encodeURIComponent(relQ.trim())}&for_sale=true&page_size=8`), enabled: relQ.trim().length >= 2, retry: false });
  const related = f.related_barcodes ?? [];
  const highlights = f.highlights ?? [];
  const med = noDisc(f.type);   // κλείδωμα έκπτωσης μόνο στα συνταγογραφούμενα
  const isNew = !product.barcode;   // νέο είδος → επιτρέπεται τιμή/απόθεμα (δημιουργείς την εγγραφή)· υπάρχον → read-only (Αποθήκη)
  const cls = tax?.classes.find((c) => c.type === f.type);
  const cats = cls?.categories ?? [];
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  const tags = f.tags ?? [];
  const addTag = (t: string) => { const v = t.trim(); if (v && !tags.includes(v)) setF((s) => ({ ...s, tags: [...(s.tags ?? []), v].slice(0, 12) })); setTagIn(""); };
  const rmTag = (t: string) => setF((s) => ({ ...s, tags: (s.tags ?? []).filter((x) => x !== t) }));
  async function prefill() {
    if (!f.barcode) return;
    const d = await api<{ found: boolean; name?: string; price_cents?: number; category?: string; type?: string }>(`/catalog/prefill?barcode=${encodeURIComponent(f.barcode)}`);
    if (d.found) setF((s) => ({ ...s, name: d.name || s.name, price_eur: d.price_cents ? d.price_cents / 100 : s.price_eur, category: d.category || s.category, type: d.type || s.type }));
    else await appAlert("Δεν βρέθηκε στο μητρώο ΗΔΥΚΑ — συμπλήρωσέ το χειροκίνητα.", { title: "Δεν βρέθηκε" });
  }
  async function upload(file: File) {
    setUp(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await apiUpload<{ ok: boolean; image_id?: string; error?: string }>("/catalog/image", fd);
      if (r.ok && r.image_id) setF((s) => ({ ...s, image_id: r.image_id, photo_url: null }));
      else await appAlert("Η φωτογραφία δεν φορτώθηκε — δοκίμασε άλλη (JPG/PNG, ως 8MB).", { title: "Αποτυχία ανεβάσματος" });
    } catch { await appAlert("Σφάλμα ανεβάσματος.", { title: "Σφάλμα" }); } finally { setUp(false); }
  }
  const preview = f.image_id ? `${API_BASE}/catalog/image/${f.image_id}` : (f.photo_url || "");
  const gallery = f.images ?? [];
  const galRef = useRef<HTMLInputElement>(null);
  async function uploadGallery(file: File) {
    setUp(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await apiUpload<{ ok: boolean; image_id?: string }>("/catalog/image", fd);
      if (r.ok && r.image_id) setF((s) => ({ ...s, images: [...(s.images ?? []), r.image_id!].slice(0, 8) }));
    } catch { await appAlert("Σφάλμα ανεβάσματος.", { title: "Σφάλμα" }); } finally { setUp(false); }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><div className="text-lg font-semibold text-slate-800">{product.barcode ? "Επεξεργασία είδους" : "Νέο είδος"}</div><button onClick={onClose}><X className="h-5 w-5 text-slate-400" /></button></div>
        <div className="space-y-2.5">
          {isNew ? (
            <>
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-slate-500">Barcode<input value={f.barcode} onChange={(e) => set("barcode", e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
                <button onClick={prefill} className="mt-5 inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100"><Sparkles className="h-3.5 w-3.5" /> Auto από ΗΔΙΚΑ</button>
              </div>
              <label className="block text-xs text-slate-500">Όνομα<input value={f.name} onChange={(e) => set("name", e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            </>
          ) : (
            /* Ταυτότητα (όνομα/τύπος/barcode) = δεδομένα Αποθήκης → read-only εδώ */
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-2">
              <div className="text-sm font-semibold text-slate-800">{f.name}</div>
              <div className="text-[11px] text-slate-400">{TYPE_LABEL[f.type] || f.type} · {f.barcode}</div>
              <div className="mt-0.5 text-[10px] text-slate-400">Ταυτότητα & τύπος ρυθμίζονται στην <b>Αποθήκη</b>.</div>
            </div>
          )}
          <label className="block text-xs text-slate-500">Περιγραφή e-shop (marketing)<textarea value={f.description_long ?? ""} onChange={(e) => set("description_long", e.target.value)} rows={3} placeholder="Περιγραφή που βλέπει ο πελάτης στη σελίδα προϊόντος…" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>

          {/* Φωτογραφία — ανέβασμα από τη συσκευή */}
          <div className="text-xs text-slate-500">Φωτογραφία
            <div className="mt-1 flex items-center gap-3">
              <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {preview ? <img src={preview} alt="" className="h-full w-full object-contain" /> : <ImagePlus className="h-6 w-6 text-slate-300" />}
              </div>
              <div className="flex flex-col gap-1.5">
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const fl = e.target.files?.[0]; if (fl) upload(fl); }} />
                <button onClick={() => fileRef.current?.click()} disabled={up} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50">{up ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} {preview ? "Αλλαγή φωτό" : "Ανέβασμα φωτό"}</button>
                {preview && <button onClick={() => setF((s) => ({ ...s, image_id: null, photo_url: null }))} className="text-left text-[11px] text-rose-500 hover:underline">Αφαίρεση</button>}
              </div>
            </div>
          </div>

          {/* Επιπλέον εικόνες (gallery) — ο πελάτης τις βλέπει στη σελίδα προϊόντος */}
          <div className="text-xs text-slate-500">Επιπλέον εικόνες (gallery)
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {gallery.map((id) => (
                <div key={id} className="relative h-14 w-14 overflow-hidden rounded-lg border border-slate-200">
                  <img src={`${API_BASE}/catalog/image/${id}`} alt="" className="h-full w-full object-cover" />
                  <button onClick={() => setF((s) => ({ ...s, images: (s.images ?? []).filter((x) => x !== id) }))} className="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl bg-black/60 text-white"><X className="h-3 w-3" /></button>
                </div>
              ))}
              {gallery.length < 8 && (
                <>
                  <input ref={galRef} type="file" accept="image/*" hidden onChange={(e) => { const fl = e.target.files?.[0]; if (fl) uploadGallery(fl); if (galRef.current) galRef.current.value = ""; }} />
                  <button onClick={() => galRef.current?.click()} disabled={up} className="grid h-14 w-14 place-items-center rounded-lg border border-dashed border-slate-300 text-slate-400 hover:bg-slate-50 disabled:opacity-50"><Plus className="h-5 w-5" /></button>
                </>
              )}
            </div>
          </div>

          {isNew && (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-500">Τύπος<select value={f.type} onChange={(e) => setF((s) => ({ ...s, type: e.target.value, category: null }))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"><option value="rx_medicine">Συνταγογραφούμενο</option><option value="otc_medicine">ΜΗ.ΣΥ.ΦΑ. (OTC)</option><option value="parapharmacy">Παραφάρμακο</option></select></label>
              <label className="text-xs text-slate-500">Κατηγορία
                {cats.length
                  ? <select value={f.category ?? ""} onChange={(e) => set("category", e.target.value || null)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"><option value="">— επιλογή —</option>{cats.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                  : <input value={f.category ?? ""} onChange={(e) => set("category", e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />}
              </label>
            </div>
          )}

          {/* Κατηγορία e-shop — ΚΟΙΝΟ χαρακτηριστικό του είδους· ρυθμίζεται στην Αποθήκη & κληρονομείται εδώ (read-only) */}
          <InheritedCategory f={f} />

          {/* Tags / ετικέτες */}
          <div className="text-xs text-slate-500">Ετικέτες (tags)
            <div className="mt-1 flex flex-wrap gap-1.5 rounded-lg border border-slate-300 p-2">
              {tags.map((t) => <span key={t} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${tagCls(t)}`}>{t}<button onClick={() => rmTag(t)}><X className="h-3 w-3" /></button></span>)}
              <input value={tagIn} onChange={(e) => setTagIn(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagIn); } }} placeholder={tags.length ? "" : "π.χ. Προσφορά, Βιολογικό…"} className="min-w-[6rem] flex-1 border-0 p-0 text-sm outline-none focus:ring-0" />
            </div>
            <div className="mt-1 flex flex-wrap gap-1">{QUICK_TAGS.filter((t) => !tags.includes(t)).map((t) => <button key={t} onClick={() => addTag(t)} className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50">+ {t}</button>)}</div>
          </div>

          <label className="text-xs text-slate-500">🎬 Βίντεο οδηγιών χρήσης (YouTube/Vimeo)
            <input value={f.usage_video_url ?? ""} onChange={(e) => set("usage_video_url", e.target.value || null)} placeholder="https://youtu.be/… ή https://vimeo.com/…" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            <span className="mt-0.5 block text-[11px] text-slate-400">Ο πελάτης το βλέπει στο e-shop. Δεκτά μόνο YouTube/Vimeo.</span></label>

          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={!!f.featured} onChange={(e) => set("featured", e.target.checked)} /> <Star className={`h-4 w-4 ${f.featured ? "fill-amber-400 text-amber-500" : "text-slate-300"}`} /> Προτεινόμενο (πρώτο στη βιτρίνα)</label>

          {isNew ? (
            /* ── ΝΕΟ είδος: εδώ δημιουργείς την εγγραφή (τιμή/κόστος/απόθεμα ζουν στην Αποθήκη) ── */
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-500">Λιανική (€)<input type="number" step="0.01" value={f.price_eur} onChange={(e) => set("price_eur", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
                <label className="text-xs text-slate-500">Χονδρική (€)<input type="number" step="0.01" value={f.wholesale_eur} onChange={(e) => set("wholesale_eur", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
              </div>
              <label className="text-xs text-slate-500">Απόθεμα<input type="number" value={f.stock_qty} onChange={(e) => set("stock_qty", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /><span className="text-[10px] text-amber-600">{f.stock_qty > 0 ? "" : " 0 = κατόπιν παραγγελίας"}</span></label>
            </>
          ) : (
            /* ── ΥΠΑΡΧΟΝ είδος: ΜΟΝΟ πώληση. Κόστος/τιμή/απόθεμα ρυθμίζονται στην Αποθήκη. ── */
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-2 text-xs text-slate-500">
              <span>Τιμή πώλησης <span className="text-[10px] text-slate-400">(από Αποθήκη)</span></span>
              <span className="text-right"><b className="text-slate-800">{eur(f.price_cents)}</b><br /><span className="text-[10px] text-slate-400">Διαθεσιμότητα: {f.stock_qty > 0 ? `${f.stock_qty} τεμ.` : "κατόπιν παραγγελίας"}</span></span>
            </div>
          )}

          {/* Έκπτωση e-shop — καθαρά πωλησιακό εργαλείο (δεν είναι δεδομένο αποθήκης) */}
          <label className={`block text-xs ${med ? "text-slate-300" : "text-slate-500"}`}>Έκπτωση e-shop %<input type="number" disabled={med} title={med ? "Στα συνταγογραφούμενα δεν επιτρέπονται εκπτώσεις" : ""} value={med ? 0 : f.discount_pct} onChange={(e) => set("discount_pct", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100" /></label>
          {!med && (f.discount_pct ?? 0) > 0 && (f.price_cents ?? 0) > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700"><span>Τελική τιμή στο e-shop</span><b>{eur(Math.round((f.price_cents ?? 0) * (100 - (f.discount_pct ?? 0)) / 100))}</b></div>
          )}
          {med && <p className="text-[11px] text-amber-600">🔒 Συνταγογραφούμενο — η έκπτωση είναι κλειδωμένη στο 0% από τον νόμο (OTC & παραφάρμακα επιτρέπουν).</p>}

          {/* ── ΠΩΛΗΣΙΑΚΑ ΕΡΓΑΛΕΙΑ e-shop (κανένα δεδομένο αποθήκης) ── */}
          <div className="space-y-3 rounded-xl border border-violet-200 bg-violet-50/40 p-3">
            <div className="text-xs font-semibold text-violet-700">🛒 Πωλησιακά εργαλεία e-shop</div>

            {!med && (
              <div>
                <div className="mb-1 text-xs text-slate-600">⏳ Flash προσφορά — παράθυρο ισχύος έκπτωσης (προαιρετικό)</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] text-slate-500">Από<div className="mt-1"><DateInput value={(f.sale_starts_at || "").slice(0, 10)} onChange={(d) => set("sale_starts_at", d ? `${d}T00:00:00` : null)} /></div></label>
                  <label className="text-[11px] text-slate-500">Έως<div className="mt-1"><DateInput value={(f.sale_ends_at || "").slice(0, 10)} onChange={(d) => set("sale_ends_at", d ? `${d}T23:59:59` : null)} /></div></label>
                </div>
                <span className="mt-0.5 block text-[11px] text-slate-400">Χωρίς ημερομηνίες η έκπτωση ισχύει μόνιμα. Η πύλη δείχνει countdown όσο τρέχει.</span>
              </div>
            )}

            <div>
              <div className="mb-1 text-xs text-slate-600">✅ Σημεία πώλησης (ένα ανά γραμμή, ως 6)</div>
              <textarea value={highlights.join("\n")} onChange={(e) => set("highlights", e.target.value.split("\n").slice(0, 6))} onBlur={(e) => set("highlights", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6))} rows={3} placeholder={"π.χ. Χωρίς ζάχαρη\nΚλινικά τεκμηριωμένο\nΓια όλη την οικογένεια"} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            </div>

            <div>
              <div className="mb-1 text-xs text-slate-600">🔗 Συχνά μαζί (cross-sell)</div>
              {!!related.length && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {related.map((bc) => (
                    <span key={bc} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
                      {relNames[bc] || bc}
                      <button onClick={() => set("related_barcodes", related.filter((x) => x !== bc))}><X className="h-3 w-3" /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="relative">
                <input value={relQ} onChange={(e) => setRelQ(e.target.value)} placeholder="Αναζήτηση είδους…" className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                {relQ.trim().length >= 2 && (relSearch.data?.items?.length ?? 0) > 0 && (
                  <div className="absolute z-10 mt-1 max-h-40 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                    {relSearch.data!.items.filter((p) => p.barcode !== f.barcode).map((p) => {
                      const on = related.includes(p.barcode);
                      return (
                        <button key={p.barcode} onClick={() => { setRelNames((m) => ({ ...m, [p.barcode]: p.name })); set("related_barcodes", on ? related.filter((x) => x !== p.barcode) : [...related, p.barcode]); }} className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-slate-50 ${on ? "bg-violet-50" : ""}`}>
                          <span className="min-w-0 truncate">{p.name}<span className="text-slate-400"> · {p.barcode}</span></span>
                          {on ? <Check className="h-3.5 w-3.5 shrink-0 text-violet-600" /> : <Plus className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <label className="block text-xs text-slate-600">🎁 Bonus πόντοι πιστότητας
              <select value={f.points_multiplier ?? 1} onChange={(e) => set("points_multiplier", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                <option value={1}>Κανονικοί πόντοι (×1)</option>
                <option value={2}>Διπλοί πόντοι (×2)</option>
                <option value={3}>Τριπλοί πόντοι (×3)</option>
                <option value={5}>×5 πόντοι</option>
              </select>
              <span className="mt-0.5 block text-[11px] text-slate-400">Δίνει bonus πόντους στην παράδοση (αν το πρόγραμμα επιβράβευσης είναι ενεργό).</span>
            </label>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">Άκυρο</button>
          <button onClick={() => onSave(f)} disabled={busy || !f.barcode || !f.name} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Αποθήκευση</button>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [rowTag, setRowTag] = useState("product");
  const [map, setMap] = useState<Record<string, string>>({ barcode: "barcode", name: "name", price: "price", stock: "stock", category: "category", description: "description", photo: "photo" });
  const [defType, setDefType] = useState("parapharmacy");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  async function run() {
    if (!file) return;
    setBusy(true); setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("row_tag", rowTag); fd.append("default_type", defType);
      fd.append("mapping", JSON.stringify(map));
      const r = await apiUpload<{ ok: boolean; imported?: number; skipped?: number; error?: string }>("/catalog/import-xml", fd);
      if (r.ok) { setResult(`✓ Εισήχθησαν ${r.imported} είδη (παραλείφθηκαν ${r.skipped}).`); setTimeout(onDone, 1200); }
      else setResult("⚠ " + (r.error || "Αποτυχία"));
    } catch { setResult("⚠ Σφάλμα δικτύου."); } finally { setBusy(false); }
  }
  const FIELDS: [string, string][] = [["barcode", "Barcode *"], ["name", "Όνομα"], ["price", "Τιμή"], ["stock", "Απόθεμα"], ["category", "Κατηγορία"], ["description", "Περιγραφή"], ["photo", "Φωτό (URL)"]];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between"><div className="text-lg font-semibold text-slate-800">Εισαγωγή από XML</div><button onClick={onClose}><X className="h-5 w-5 text-slate-400" /></button></div>
        <p className="mb-3 text-xs text-slate-500">Ανέβασε το XML του εμπορικού σου προγράμματος και αντιστοίχισε τα πεδία του στα δικά μας. Λειτουργεί με οποιοδήποτε format.</p>
        <div className="space-y-2.5">
          <input type="file" accept=".xml,text/xml" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-500">Ετικέτα γραμμής (επανάληψη)<input value={rowTag} onChange={(e) => setRowTag(e.target.value)} placeholder="product / item / row" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="text-xs text-slate-500">Προεπιλ. τύπος<select value={defType} onChange={(e) => setDefType(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"><option value="parapharmacy">Παραφάρμακο</option><option value="otc_medicine">ΜΗ.ΣΥ.ΦΑ. (OTC)</option><option value="rx_medicine">Συνταγογραφούμενο</option></select></label>
          </div>
          <div className="rounded-lg border border-slate-200 p-2">
            <div className="mb-1 text-[11px] font-semibold text-slate-500">Αντιστοίχιση πεδίων (το όνομα του tag/attribute στο XML σου)</div>
            <div className="grid grid-cols-2 gap-1.5">
              {FIELDS.map(([k, label]) => (
                <label key={k} className="text-[11px] text-slate-500">{label}<input value={map[k] ?? ""} onChange={(e) => setMap((s) => ({ ...s, [k]: e.target.value }))} className="mt-0.5 w-full rounded border border-slate-300 px-1.5 py-1 text-xs" /></label>
              ))}
            </div>
          </div>
          {result && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{result}</div>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">Κλείσιμο</button>
          <button onClick={run} disabled={busy || !file} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Εισαγωγή</button>
        </div>
      </div>
    </div>
  );
}
