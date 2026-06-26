"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Truck, Search, Plus, Pencil, Trash2, Upload, X, Loader2, Sparkles, Package, Pill } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Product = {
  barcode: string; name: string; description_short?: string | null; description_long?: string | null;
  photo_url?: string | null; price_cents: number; type: string; category?: string | null;
  discount_pct: number; stock_qty: number; active?: boolean;
};
type ListRes = { items: Product[]; total: number };
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const EMPTY: Product = { barcode: "", name: "", price_cents: 0, type: "parapharmacy", discount_pct: 0, stock_qty: 0 };

export default function CatalogPage() {
  return <ModuleGuard module="order_delivery"><Catalog /></ModuleGuard>;
}

function Catalog() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [type, setType] = useState("");
  const [edit, setEdit] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = useQuery({
    queryKey: ["catalog", term, type],
    queryFn: () => api<ListRes>(`/catalog?page_size=60&q=${encodeURIComponent(term)}&type=${type}`),
    retry: false,
  });

  async function save(p: Product) {
    setBusy(true);
    try {
      const price_cents = Math.round((Number((p as unknown as { price_eur?: number }).price_eur ?? p.price_cents / 100)) * 100);
      await api("/catalog", { method: "POST", body: JSON.stringify({ ...p, price_cents }) });
      setEdit(null); await list.refetch();
    } finally { setBusy(false); }
  }
  async function del(barcode: string) {
    if (!confirm("Διαγραφή του είδους από τον κατάλογο;")) return;
    await api(`/catalog/${encodeURIComponent(barcode)}`, { method: "DELETE" }); list.refetch();
  }

  const items = list.data?.items ?? [];
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-800"><Truck className="h-6 w-6 text-brand-600" /> Παραγγελίες & Κατάλογος</div>
      <p className="mb-4 text-sm text-slate-500">Ο κατάλογος ειδών του φαρμακείου σου (OTC φάρμακα + παραφάρμακα) — οι πελάτες παραγγέλνουν από εδώ. <b>Στα φάρμακα δεν επιτρέπονται εκπτώσεις.</b></p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση (όνομα/barcode)…" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
        </form>
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
          <option value="">Όλα</option>
          <option value="otc_medicine">Φάρμακα (OTC)</option>
          <option value="parapharmacy">Παραφάρμακα</option>
        </select>
        <button onClick={() => setImporting(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"><Upload className="h-4 w-4" /> Εισαγωγή XML</button>
        <button onClick={() => setEdit({ ...EMPTY })} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> Νέο είδος</button>
      </div>

      <div className="mb-3 text-xs text-slate-400">{list.isLoading ? "Φόρτωση…" : `${list.data?.total ?? 0} είδη`}</div>

      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((p) => {
          const med = p.type === "otc_medicine";
          return (
            <div key={p.barcode} className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3">
              <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-50">
                {p.photo_url ? <img src={p.photo_url} alt="" className="h-full w-full object-contain" /> : (med ? <Pill className="h-6 w-6 text-slate-300" /> : <Package className="h-6 w-6 text-slate-300" />)}
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
                  <span className={`rounded px-1.5 py-0.5 font-medium ${med ? "bg-sky-50 text-sky-600" : "bg-violet-50 text-violet-600"}`}>{med ? "Φάρμακο OTC" : "Παραφάρμακο"}</span>
                  {p.category && <span>{p.category}</span>}
                  <span>· {p.barcode}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-sm">
                  <b className="text-slate-800">{eur(p.price_cents)}</b>
                  {p.discount_pct > 0 && <span className="rounded bg-emerald-50 px-1.5 text-[11px] font-semibold text-emerald-700">-{p.discount_pct}%</span>}
                  <span className={`ml-auto text-[11px] ${p.stock_qty > 0 ? "text-slate-500" : "text-rose-500"}`}>{p.stock_qty > 0 ? `απόθεμα: ${p.stock_qty}` : "εξαντλημένο"}</span>
                </div>
              </div>
            </div>
          );
        })}
        {!list.isLoading && items.length === 0 && <div className="col-span-full rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Άδειος κατάλογος — πρόσθεσε είδη ή κάνε εισαγωγή XML.</div>}
      </div>

      {edit && <EditModal product={edit} busy={busy} onClose={() => setEdit(null)} onSave={save} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); list.refetch(); }} />}
    </div>
  );
}

function EditModal({ product, busy, onClose, onSave }: { product: Product; busy: boolean; onClose: () => void; onSave: (p: Product) => void }) {
  const [f, setF] = useState<Product & { price_eur?: number }>({ ...product, price_eur: (product as { price_eur?: number }).price_eur ?? product.price_cents / 100 });
  const med = f.type === "otc_medicine";
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  async function prefill() {
    if (!f.barcode) return;
    const d = await api<{ found: boolean; name?: string; price_cents?: number; category?: string; type?: string }>(`/catalog/prefill?barcode=${encodeURIComponent(f.barcode)}`);
    if (d.found) setF((s) => ({ ...s, name: d.name || s.name, price_eur: d.price_cents ? d.price_cents / 100 : s.price_eur, category: d.category || s.category, type: d.type || s.type }));
    else alert("Δεν βρέθηκε στο μητρώο ΗΔΙΚΑ — συμπλήρωσέ το χειροκίνητα.");
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><div className="text-lg font-semibold text-slate-800">{product.barcode ? "Επεξεργασία είδους" : "Νέο είδος"}</div><button onClick={onClose}><X className="h-5 w-5 text-slate-400" /></button></div>
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-slate-500">Barcode<input value={f.barcode} onChange={(e) => set("barcode", e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <button onClick={prefill} className="mt-5 inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100"><Sparkles className="h-3.5 w-3.5" /> Auto από ΗΔΙΚΑ</button>
          </div>
          <label className="block text-xs text-slate-500">Όνομα / μικρή περιγραφή<input value={f.name} onChange={(e) => set("name", e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
          <label className="block text-xs text-slate-500">Μεγάλη περιγραφή<textarea value={f.description_long ?? ""} onChange={(e) => set("description_long", e.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
          <label className="block text-xs text-slate-500">Φωτογραφία (URL)<input value={f.photo_url ?? ""} onChange={(e) => set("photo_url", e.target.value)} placeholder="https://…" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-500">Τύπος<select value={f.type} onChange={(e) => set("type", e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"><option value="parapharmacy">Παραφάρμακο</option><option value="otc_medicine">Φάρμακο (OTC)</option></select></label>
            <label className="text-xs text-slate-500">Κατηγορία<input value={f.category ?? ""} onChange={(e) => set("category", e.target.value)} placeholder={med ? "π.χ. Αναλγητικά" : "π.χ. Συμπληρώματα"} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-slate-500">Τιμή (€)<input type="number" step="0.01" value={f.price_eur} onChange={(e) => set("price_eur", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="text-xs text-slate-500">Απόθεμα<input type="number" value={f.stock_qty} onChange={(e) => set("stock_qty", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className={`text-xs ${med ? "text-slate-300" : "text-slate-500"}`}>Έκπτωση %<input type="number" disabled={med} title={med ? "Στα φάρμακα δεν επιτρέπονται εκπτώσεις" : ""} value={med ? 0 : f.discount_pct} onChange={(e) => set("discount_pct", +e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100" /></label>
          </div>
          {med && <p className="text-[11px] text-amber-600">🔒 Φάρμακο — η έκπτωση είναι κλειδωμένη στο 0% από τον νόμο.</p>}
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
      const r = await api<{ ok: boolean; imported?: number; skipped?: number; error?: string }>("/catalog/import-xml", { method: "POST", body: fd });
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
            <label className="text-xs text-slate-500">Προεπιλ. τύπος<select value={defType} onChange={(e) => setDefType(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"><option value="parapharmacy">Παραφάρμακο</option><option value="otc_medicine">Φάρμακο (OTC)</option></select></label>
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
