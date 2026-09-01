"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Warehouse, Plus, ArrowUpDown, History, Pencil, AlertTriangle, CalendarClock, X, PackageX, FileSpreadsheet, Upload, ImagePlus, ZoomIn } from "lucide-react";
import { api, apiUpload, apiBlob } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appAlert } from "@/store/dialogStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { DateInput } from "@/components/ui/DateInput";
import { CategoryPicker, useCategoryTree } from "@/components/catalog/CategoryPicker";
import { SupplierPhotoCard } from "@/components/catalog/SupplierPhotoCard";

type Item = {
  barcode: string; name: string; type: string; category?: string | null;
  stock_qty: number; min_stock?: number; wholesale_cents?: number; price_cents: number;
  supplier?: string | null; location?: string | null; batch?: string | null; expiry?: string | null;
  active?: boolean; for_sale?: boolean; image_id?: string | null;
  barcodes?: string[]; variants?: Variant[];
  cat1_id?: string | null; cat2_id?: string | null; cat3_id?: string | null;
  vat_rate?: number; price_includes_vat?: boolean; usage_video_url?: string | null;
  // ── πωλησιακά χαρακτηριστικά e-shop (worksheet, όταν «στο e-shop») ──
  description_long?: string | null; discount_pct?: number; featured?: boolean; tags?: string[];
  highlights?: string[]; points_multiplier?: number; sale_starts_at?: string | null; sale_ends_at?: string | null;
};
type Variant = { color?: string | null; size?: string | null; barcode?: string | null; stock_qty?: number };
type Summary = { skus: number; active: number; for_sale: number; units: number; value_cents: number; low: number; expiring: number };
type WH = { items: Item[]; total: number; summary: Summary; suppliers?: string[] };
type Move = { kind: string; qty: number; reason?: string | null; batch?: string | null; expiry?: string | null; new_stock?: number; at: string; by?: string | null };

const typeElMap = (t: (a: string, b: string) => string): Record<string, string> => ({ rx_medicine: t("Συνταγογρ.", "Rx"), otc_medicine: t("ΜΗ.ΣΥ.ΦΑ.", "OTC"), parapharmacy: t("Παραφάρμακο", "Parapharmacy") });
const kindElMap = (t: (a: string, b: string) => string): Record<string, string> => ({ in: t("Παραλαβή", "Receipt"), out: t("Πώληση/Έξοδος", "Sale/Out"), adjust: t("Απογραφή", "Stock count"), waste: t("Απόσυρση", "Write-off") });
const daysTo = (iso?: string | null) => iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86400000) : null;
const dmy = (iso?: string | null) => iso ? iso.split("-").reverse().join("/") : "—";
const margin = (p: Item) => (p.wholesale_cents && p.price_cents) ? Math.round((p.price_cents - p.wholesale_cents) / p.price_cents * 100) : null;

export default function WarehousePage() {
  const t = useT();
  const TYPE_EL = typeElMap(t);
  const [q, setQ] = useState(() => { try { return new URLSearchParams(window.location.search).get("q") ?? ""; } catch { return ""; } });
  const [type, setType] = useState("");
  const [low, setLow] = useState(false);
  const [exp, setExp] = useState(false);
  const [inactive, setInactive] = useState(true);
  const [cat1, setCat1] = useState(""); const [cat2, setCat2] = useState(""); const [cat3, setCat3] = useState("");
  const [forSale, setForSale] = useState(""); const [stock, setStock] = useState(""); const [supplier, setSupplier] = useState("");
  const [noImg, setNoImg] = useState(false); const [noCat, setNoCat] = useState(false);
  const { data: catTree } = useCategoryTree();
  const cats = catTree?.items ?? [];
  const catOpts = (level: number, parent: string) => cats.filter((c) => c.level === level && (level === 1 || c.parent_id === parent));
  const [move, setMove] = useState<Item | null>(null);
  const [edit, setEdit] = useState<Item | null>(null);
  const [hist, setHist] = useState<Item | null>(null);
  const [imp, setImp] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE = 100;
  useEffect(() => { setPage(1); }, [q, type, low, exp, inactive, cat1, cat2, cat3, forSale, stock, supplier, noImg, noCat]);

  const list = useQuery({
    queryKey: ["warehouse", q, type, low, exp, inactive, cat1, cat2, cat3, forSale, stock, supplier, noImg, noCat, page],
    queryFn: () => {
      const p = new URLSearchParams({ q, type, low_stock: String(low), expiring: String(exp), include_inactive: String(inactive), page: String(page), page_size: String(PAGE) });
      if (cat1) p.set("cat1", cat1); if (cat2) p.set("cat2", cat2); if (cat3) p.set("cat3", cat3);
      if (forSale) p.set("for_sale", forSale === "yes" ? "true" : "false");
      if (stock) p.set("stock", stock);
      if (supplier) p.set("supplier", supplier);
      if (noImg) p.set("no_image", "true"); if (noCat) p.set("no_category", "true");
      return api<WH>(`/catalog/warehouse?${p.toString()}`);
    },
    retry: false,
  });
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  const s = list.data?.summary;

  async function toggle(bc: string, patch: { for_sale?: boolean; active?: boolean }) {
    const r = await api<{ ok: boolean; need_category?: boolean }>("/catalog/warehouse/flags", { method: "POST", body: JSON.stringify({ barcode: bc, ...patch }) }).catch(() => ({ ok: false, need_category: false }));
    if (!r.ok && r.need_category) { await appAlert(t("Όρισε πρώτα Κατηγορία 1 (Επεξεργασία είδους) για να το βάλεις προς πώληση.", "Set Category 1 first (Edit item) to put it on sale.")); return; }
    list.refetch();
  }

  const Toggle = ({ on, label, onClick, tone }: { on: boolean; label: string; onClick: () => void; tone: string }) => (
    <button onClick={onClick} title={label} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${on ? tone : "bg-slate-100 text-slate-400 dark:bg-slate-800"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-current" : "bg-slate-300"}`} />{label}
    </button>
  );

  const cols: Column<Item>[] = [
    { key: "name", header: t("Είδος", "Item"), render: (r) => (
      <div className="min-w-0">
        <div className={`truncate font-medium ${r.active === false ? "text-slate-400 line-through" : "text-slate-800 dark:text-slate-100"}`}>{r.name || "—"}</div>
        <div className="font-mono text-[10px] text-slate-400">{r.barcode}{r.category ? ` · ${r.category}` : ""} · {TYPE_EL[r.type] ?? r.type}
          {(r.barcodes?.length ?? 0) > 0 && <span className="ml-1 rounded bg-slate-100 px-1 text-slate-500 dark:bg-slate-800">+{r.barcodes!.length} bc</span>}
          {(r.variants?.length ?? 0) > 0 && <span className="ml-1 rounded bg-violet-100 px-1 text-violet-600 dark:bg-violet-950/40">{r.variants!.length} {t("εκδοχές", "variants")}</span>}
        </div>
      </div>
    ) },
    { key: "stock", header: t("Απόθεμα", "Stock"), align: "right", sortValue: (r) => r.stock_qty, render: (r) => {
      const lowS = r.stock_qty <= (r.min_stock ?? 0);
      return <span className={`inline-flex items-center gap-1 font-semibold ${lowS ? "text-amber-600" : "text-slate-700 dark:text-slate-200"}`}>{lowS && <AlertTriangle className="h-3 w-3" />}{fmtNum(r.stock_qty)}<span className="text-[10px] font-normal text-slate-400">/{r.min_stock ?? 0}</span></span>;
    } },
    { key: "cost", header: t("Κόστος", "Cost"), align: "right", sortValue: (r) => r.wholesale_cents ?? 0, render: (r) => r.wholesale_cents ? fmtEur(r.wholesale_cents) : "—" },
    { key: "price", header: t("Λιανική", "Retail"), align: "right", sortValue: (r) => r.price_cents, render: (r) => <span>{fmtEur(r.price_cents)}{margin(r) != null && <span className="ml-1 text-[10px] text-emerald-600">+{margin(r)}%</span>}</span> },
    { key: "value", header: t("Αξία", "Value"), align: "right", sortValue: (r) => r.stock_qty * (r.wholesale_cents ?? 0), render: (r) => <span className="text-slate-500">{fmtEur(r.stock_qty * (r.wholesale_cents ?? 0))}</span> },
    { key: "supplier", header: t("Προμηθευτής / Θέση", "Supplier / Location"), render: (r) => <div className="text-xs text-slate-500"><div className="truncate">{r.supplier || "—"}</div>{r.location && <div className="text-[10px] text-slate-400">📍 {r.location}</div>}</div> },
    { key: "expiry", header: t("Λήξη", "Expiry"), render: (r) => {
      const d = daysTo(r.expiry);
      const near = d != null && d <= 90;
      return r.expiry ? <span className={`inline-flex items-center gap-1 text-xs ${d != null && d < 0 ? "text-rose-600" : near ? "text-amber-600" : "text-slate-500"}`}>{near && <CalendarClock className="h-3 w-3" />}{dmy(r.expiry)}</span> : <span className="text-slate-300">—</span>;
    } },
    { key: "flags", header: t("Κατάσταση", "Status"), render: (r) => (
      <div className="flex flex-col gap-1">
        <Toggle on={r.active !== false} label={t("Ενεργό", "Active")} tone="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" onClick={() => toggle(r.barcode, { active: r.active === false })} />
        <Toggle on={!!r.for_sale} label={t("e-shop", "e-shop")} tone="bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300" onClick={() => toggle(r.barcode, { for_sale: !r.for_sale })} />
      </div>
    ) },
    { key: "act", header: "", render: (r) => (
      <div className="flex items-center gap-0.5">
        <button onClick={() => setMove(r)} title={t("Κίνηση αποθέματος (εισαγωγή/εξαγωγή)", "Stock movement (in/out)")} className="grid h-7 w-7 place-items-center rounded-lg text-brand-600 hover:bg-brand-50 dark:hover:bg-slate-800"><ArrowUpDown className="h-4 w-4" /></button>
        <button onClick={() => setHist(r)} title={t("Ιστορικό κινήσεων", "Movement history")} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><History className="h-4 w-4" /></button>
        <button onClick={() => setEdit(r)} title={t("Επεξεργασία", "Edit")} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><Pencil className="h-4 w-4" /></button>
      </div>
    ) },
  ];

  const kpis = s ? [
    { v: fmtNum(s.skus), l: t("Είδη (SKU)", "SKUs") },
    { v: fmtNum(s.active), l: t("Ενεργά", "Active"), c: "text-emerald-600" },
    { v: fmtNum(s.for_sale), l: t("Στο e-shop", "In e-shop"), c: "text-brand-600" },
    { v: fmtNum(s.units), l: t("Τεμάχια", "Units") },
    { v: fmtEur(s.value_cents), l: t("Αξία αποθέματος", "Inventory value"), c: "text-slate-800 dark:text-slate-100" },
    { v: fmtNum(s.low), l: t("Χαμηλό απόθεμα", "Low stock"), c: s.low ? "text-amber-600" : "text-slate-400" },
    { v: fmtNum(s.expiring), l: t("Λήγοντα (90ημ)", "Expiring (90d)"), c: s.expiring ? "text-rose-600" : "text-slate-400" },
  ] : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xl font-semibold text-slate-800 dark:text-slate-100"><Warehouse className="h-6 w-6 text-brand-600" /> {t("Προϊόντα", "Products")}</div>
          <p className="text-sm text-slate-500">{t("Όλα τα προϊόντα του φαρμακείου (αποθήκη + e-shop σε μία ενότητα). Φίλτραρε ανά απόθεμα, κατάσταση e-shop, κατηγορία. Όσα βάλεις «στο e-shop» πωλούνται online.", "All pharmacy products (warehouse + e-shop in one section). Filter by stock, e-shop status, category. Those marked «in e-shop» sell online.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setImp(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"><FileSpreadsheet className="h-4 w-4 text-emerald-600" /> {t("Εισαγωγή Excel/CSV", "Import Excel/CSV")}</button>
          <button onClick={() => setEdit({ barcode: "", name: "", type: "parapharmacy", price_cents: 0, stock_qty: 0, active: true, for_sale: false })} className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> {t("Νέο είδος", "New item")}</button>
        </div>
      </div>

      <SupplierPhotoCard />

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {kpis.map((k) => (
          <div key={k.l} className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
            <div className={`text-lg font-extrabold leading-none ${k.c ?? "text-slate-700 dark:text-slate-200"}`}>{k.v}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">{k.l}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση όνομα / barcode / προμηθευτή…", "Search name / barcode / supplier…")} className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
          <option value="">{t("Όλοι οι τύποι", "All types")}</option>
          {Object.entries(TYPE_EL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button onClick={() => setLow((v) => !v)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${low ? "bg-amber-100 text-amber-700" : "border border-slate-300 text-slate-600 dark:border-slate-600"}`}>⚠ {t("Χαμηλό", "Low")}</button>
        <button onClick={() => setExp((v) => !v)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${exp ? "bg-rose-100 text-rose-700" : "border border-slate-300 text-slate-600 dark:border-slate-600"}`}>⏱ {t("Λήγοντα", "Expiring")}</button>
        <label className="inline-flex items-center gap-1.5 px-2 text-sm text-slate-600 dark:text-slate-300"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} className="h-4 w-4" /> {t("+ ανενεργά", "+ inactive")}</label>
      </div>

      {/* Φίλτρα κατηγορίας (3 επίπεδα) + κατάσταση/προμηθευτής/κενά πεδία */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
        {cats.length > 0 && (<>
          <select value={cat1} onChange={(e) => { setCat1(e.target.value); setCat2(""); setCat3(""); }} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
            <option value="">{t("🗂️ Κατηγορία 1", "🗂️ Category 1")}</option>
            {catOpts(1, "").map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name}</option>)}
          </select>
          <select value={cat2} disabled={!cat1} onChange={(e) => { setCat2(e.target.value); setCat3(""); }} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800">
            <option value="">{t("Κατηγορία 2", "Category 2")}</option>
            {catOpts(2, cat1).map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name}</option>)}
          </select>
          <select value={cat3} disabled={!cat2} onChange={(e) => setCat3(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800">
            <option value="">{t("Κατηγορία 3", "Category 3")}</option>
            {catOpts(3, cat2).map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name}</option>)}
          </select>
        </>)}
        <select value={stock} onChange={(e) => setStock(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
          <option value="">{t("Απόθεμα: όλα", "Stock: all")}</option>
          <option value="in">{t("Σε απόθεμα", "In stock")}</option>
          <option value="out">{t("Εξαντλημένα", "Out of stock")}</option>
          <option value="low">{t("Χαμηλό", "Low")}</option>
        </select>
        <select value={forSale} onChange={(e) => setForSale(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
          <option value="">{t("Πώληση: όλα", "Sale: all")}</option>
          <option value="yes">{t("Προς πώληση", "For sale")}</option>
          <option value="no">{t("Όχι στο e-shop", "Not in e-shop")}</option>
        </select>
        {!!(list.data?.suppliers?.length) && (
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className="max-w-[12rem] rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
            <option value="">{t("Προμηθευτής: όλοι", "Supplier: all")}</option>
            {list.data!.suppliers!.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <button onClick={() => setNoImg((v) => !v)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${noImg ? "bg-indigo-100 text-indigo-700" : "border border-slate-300 text-slate-600 dark:border-slate-600"}`}>📷 {t("Χωρίς φωτο", "No photo")}</button>
        <button onClick={() => setNoCat((v) => !v)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${noCat ? "bg-indigo-100 text-indigo-700" : "border border-slate-300 text-slate-600 dark:border-slate-600"}`}>🗂️ {t("Χωρίς κατηγορία", "No category")}</button>
        {(q || type || low || exp || cat1 || forSale || stock || supplier || noImg || noCat) && (
          <button onClick={() => { setQ(""); setType(""); setLow(false); setExp(false); setCat1(""); setCat2(""); setCat3(""); setForSale(""); setStock(""); setSupplier(""); setNoImg(false); setNoCat(false); }} className="ml-auto rounded-lg px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30">✕ {t("Καθαρισμός", "Clear")}</button>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
        <DataTable pageSize={PAGE} columns={cols} rows={list.data?.items ?? []} rowKey={(r) => r.barcode} empty={list.isError ? t("Το κύκλωμα e-shop δεν είναι ενεργό για το φαρμακείο.", "The e-shop module is not enabled.") : t("Κανένα είδος.", "No items.")} />
        {/* Server pagination — 12k+ είδη: σελιδοποίηση από τον server (100/σελίδα) */}
        {total > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-2 py-2 text-sm dark:border-slate-800">
            <span className="text-slate-500">{t("Σελίδα", "Page")} {page} {t("από", "of")} {totalPages} · {fmtNum(total)} {t("είδη", "items")}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-600 disabled:opacity-40 dark:border-slate-600 dark:text-slate-300">← {t("Προηγούμενη", "Prev")}</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-600 disabled:opacity-40 dark:border-slate-600 dark:text-slate-300">{t("Επόμενη", "Next")} →</button>
            </div>
          </div>
        )}
      </div>

      {move && <MoveModal item={move} t={t} onClose={() => setMove(null)} onDone={() => { setMove(null); list.refetch(); }} />}
      {edit && <EditModal item={edit} t={t} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.refetch(); }} />}
      {hist && <HistoryModal item={hist} t={t} onClose={() => setHist(null)} />}
      {imp && <ImportModal t={t} onClose={() => setImp(false)} onDone={() => { setImp(false); list.refetch(); }} />}
    </div>
  );
}

function Modal({ title, onClose, size = "md", children }: { title: string; onClose: () => void; size?: "md" | "xl"; children: ReactNode }) {
  const w = size === "xl" ? "max-w-5xl" : "max-w-lg";
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-3 sm:p-6">
      <div onClick={(e) => e.stopPropagation()} className={`flex max-h-[92vh] w-full ${w} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 dark:border-slate-800"><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3><button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800"><X className="h-4 w-4" /></button></div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function MoveModal({ item, t, onClose, onDone }: { item: Item; t: (a: string, b: string) => string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState("in");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [batch, setBatch] = useState(item.batch ?? "");
  const [expiry, setExpiry] = useState(item.expiry ?? "");
  const [cost, setCost] = useState((item.wholesale_cents ?? 0) / 100);
  const [setTo, setSetTo] = useState<number>(item.stock_qty);
  const [busy, setBusy] = useState(false);
  const isAdjust = kind === "adjust";
  const KIND_EL = kindElMap(t);
  async function submit() {
    setBusy(true);
    try {
      await api("/catalog/warehouse/move", { method: "POST", body: JSON.stringify({
        barcode: item.barcode, kind, qty: Math.max(1, qty), reason: reason.trim() || null,
        batch: batch.trim() || null, expiry: expiry || null,
        cost_cents: kind === "in" ? Math.round(cost * 100) || null : null,
        set_to: isAdjust ? Math.max(0, setTo) : null,
      }) });
      onDone();
    } catch { await appAlert(t("Αποτυχία κίνησης.", "Movement failed.")); }
    setBusy(false);
  }
  return (
    <Modal title={`${t("Κίνηση αποθέματος", "Stock movement")} — ${item.name}`} onClose={onClose}>
      <div className="mb-3 grid grid-cols-4 gap-1.5">
        {Object.entries(KIND_EL).map(([k, v]) => (
          <button key={k} onClick={() => setKind(k)} className={`rounded-lg px-2 py-2 text-xs font-semibold ${kind === k ? "bg-brand-600 text-white" : "border border-slate-200 text-slate-600 dark:border-slate-700"}`}>{v}</button>
        ))}
      </div>
      <div className="space-y-3">
        {isAdjust ? (
          <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Νέο υπόλοιπο (απογραφή)", "New balance (stock count)")}</span>
            <input type="number" value={setTo} onChange={(e) => setSetTo(parseInt(e.target.value) || 0)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
        ) : (
          <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Ποσότητα", "Quantity")}</span>
            <input type="number" min={1} value={qty} onChange={(e) => setQty(parseInt(e.target.value) || 1)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
        )}
        {kind === "in" && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Κόστος/τεμ (€)", "Cost/unit (€)")}</span>
              <input type="number" step="0.01" value={cost} onChange={(e) => setCost(parseFloat(e.target.value) || 0)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
            <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Παρτίδα", "Batch")}</span>
              <input value={batch} onChange={(e) => setBatch(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
          </div>
        )}
        {(kind === "in" || kind === "waste") && (
          <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Ημ. λήξης", "Expiry date")}</span><DateInput value={expiry} onChange={setExpiry} /></label>
        )}
        <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Αιτιολογία / σημείωση", "Reason / note")}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
      </div>
      <button onClick={submit} disabled={busy} className="mt-4 w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? t("Καταχώρηση…", "Saving…") : t("Καταχώρηση κίνησης", "Record movement")}</button>
    </Modal>
  );
}

/** Μεγέθυνση φωτογραφίας είδους. Portal στο body: ο backdrop του Modal έχει `backdrop-blur`,
 *  που κάνει τον ίδιο containing block για fixed παιδιά — χωρίς portal δεν καλύπτει όλη την οθόνη. */
function PhotoZoom({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    setMounted(true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Escape κλείνει ΜΟΝΟ τη μεγέθυνση — capture, ώστε να μην φτάσει στο Modal και κλείσει η καρτέλα.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div onMouseDown={() => closeRef.current()} className="fixed inset-0 z-[200] grid cursor-zoom-out place-items-center bg-black/80 p-4 sm:p-8">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
      <button type="button" onClick={() => closeRef.current()} aria-label={t("Κλείσιμο", "Close")}
        className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25">
        <X className="h-5 w-5" />
      </button>
    </div>,
    document.body,
  );
}

function EditModal({ item, t, onClose, onDone }: { item: Item; t: (a: string, b: string) => string; onClose: () => void; onDone: () => void }) {
  const isNew = !item.barcode;
  const TYPE_EL = typeElMap(t);
  const [f, setF] = useState<Item & { price_eur: number; cost_eur: number }>({ ...item, price_eur: item.price_cents / 100, cost_eur: (item.wholesale_cents ?? 0) / 100 });
  const [busy, setBusy] = useState(false);
  const [bcText, setBcText] = useState((item.barcodes ?? []).join(", "));
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }) as typeof s);
  const variants = f.variants ?? [];
  const setVar = (i: number, k: string, v: unknown) => set("variants", variants.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const addVar = () => set("variants", [...variants, { color: "", size: "", barcode: "", stock_qty: 0 }]);
  const delVar = (i: number) => set("variants", variants.filter((_, j) => j !== i));
  const [img, setImg] = useState<string | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgZoom, setImgZoom] = useState(false);
  const [tagIn, setTagIn] = useState("");
  const noDisc = f.type === "rx_medicine";   // συνταγογραφούμενα → καμία έκπτωση (διατίμηση)
  useEffect(() => {
    let alive = true; let obj = "";
    if (item.image_id) apiBlob(`/catalog/image/${item.image_id}`).then((b) => { if (!alive) return; obj = URL.createObjectURL(b); setImg(obj); }).catch(() => {});
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [item.image_id]);
  async function uploadPhoto(file: File) {
    setImgBusy(true);
    try { const fd = new FormData(); fd.append("file", file); const r = await apiUpload<{ image_id: string }>("/catalog/image", fd); set("image_id", r.image_id); setImg(URL.createObjectURL(file)); }
    catch { await appAlert(t("Αποτυχία ανεβάσματος φωτογραφίας.", "Photo upload failed.")); }
    setImgBusy(false);
  }
  async function save() {
    if (!f.barcode.trim() || !f.name.trim()) { await appAlert(t("Barcode & όνομα υποχρεωτικά.", "Barcode & name required.")); return; }
    setBusy(true);
    try {
      await api("/catalog", { method: "POST", body: JSON.stringify({
        ...f, price_cents: Math.round(f.price_eur * 100) || 0, wholesale_cents: Math.round(f.cost_eur * 100) || 0,
        barcodes: bcText.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
      }) });
      onDone();
    } catch { await appAlert(t("Αποτυχία αποθήκευσης.", "Save failed.")); }
    setBusy(false);
  }
  const Fld = ({ k, label, type = "text", ph }: { k: string; label: string; type?: string; ph?: string }) => (
    <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{label}</span>
      <input type={type} value={(f as Record<string, unknown>)[k] as string ?? ""} onChange={(e) => set(k, type === "number" ? parseFloat(e.target.value) || 0 : e.target.value)} placeholder={ph} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
  );
  return (
    <Modal size="xl" title={isNew ? t("Νέο είδος αποθήκης", "New warehouse item") : `${t("Επεξεργασία", "Edit")} — ${item.name}`} onClose={onClose}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Φωτογραφία είδους */}
        <div className="col-span-full flex items-center gap-4">
          {img ? (
            <button type="button" onClick={() => setImgZoom(true)} title={t("Μεγέθυνση φωτογραφίας", "Enlarge photo")}
              className="group relative grid h-24 w-24 shrink-0 cursor-zoom-in place-items-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt={f.name} className="h-full w-full object-cover" />
              <span className="absolute inset-0 grid place-items-center text-white opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100 group-focus-visible:bg-black/40 group-focus-visible:opacity-100">
                <ZoomIn className="h-6 w-6" />
              </span>
            </button>
          ) : (
            <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800">
              <ImagePlus className="h-7 w-7 text-slate-300" />
            </div>
          )}
          {imgZoom && img && <PhotoZoom src={img} alt={f.name} onClose={() => setImgZoom(false)} />}
          <div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">
              <Upload className="h-4 w-4" /> {imgBusy ? t("Ανέβασμα…", "Uploading…") : t("Φωτογραφία είδους", "Item photo")}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const fl = e.target.files?.[0]; if (fl) uploadPhoto(fl); e.target.value = ""; }} />
            </label>
            {img && <button onClick={() => { set("image_id", null); setImg(null); }} className="ml-2 text-xs text-rose-500 underline">{t("Αφαίρεση", "Remove")}</button>}
            <p className="mt-1 text-[11px] text-slate-400">{t("Εμφανίζεται στον Κατάλογο & στην πύλη πελατών.", "Shown in the Catalog & customer portal.")}</p>
          </div>
        </div>
        <label className="col-span-full block text-sm"><span className="mb-1 block text-xs font-medium text-slate-500">Barcode</span>
          <input value={f.barcode} disabled={!isNew} onChange={(e) => set("barcode", e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:disabled:bg-slate-800" /></label>
        <label className="col-span-full block text-sm sm:col-span-2 lg:col-span-3"><span className="mb-1 block text-xs font-medium text-slate-500">{t("Όνομα", "Name")}</span>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
        <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Τύπος", "Type")}</span>
          <select value={f.type} onChange={(e) => set("type", e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
            {Object.entries(TYPE_EL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {Fld({ k: "price_eur", label: t("Λιανική (€)", "Retail (€)"), type: "number" })}
        {Fld({ k: "cost_eur", label: t("Χονδρική/κόστος (€)", "Cost (€)"), type: "number" })}
        <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("ΦΠΑ %", "VAT %")}</span>
          <select value={f.vat_rate ?? 6} onChange={(e) => set("vat_rate", +e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
            <option value={6}>6%</option><option value={13}>13%</option><option value={24}>24%</option><option value={0}>{t("0% / Απαλλ.", "0% / Exempt")}</option>
          </select></label>
        <label className="flex items-center gap-2 self-end rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-600">
          <input type="checkbox" checked={f.price_includes_vat ?? true} onChange={(e) => set("price_includes_vat", e.target.checked)} className="h-4 w-4" />
          <span className="text-xs text-slate-600 dark:text-slate-300">{t("Η λιανική περιλαμβάνει ΦΠΑ", "Retail includes VAT")}</span>
        </label>
        {(f.price_eur > 0) && (f.vat_rate ?? 6) > 0 && (
          <p className="col-span-full rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {(() => { const v = (f.vat_rate ?? 6) / 100; const net = (f.price_includes_vat ?? true) ? f.price_eur / (1 + v) : f.price_eur; const gross = (f.price_includes_vat ?? true) ? f.price_eur : f.price_eur * (1 + v); return t(`Καθαρή: ${net.toFixed(2)}€ · ΦΠΑ ${(f.vat_rate ?? 6)}%: ${(gross - net).toFixed(2)}€ · Μικτή: ${gross.toFixed(2)}€`, `Net: ${net.toFixed(2)}€ · VAT: ${(gross - net).toFixed(2)}€ · Gross: ${gross.toFixed(2)}€`); })()}
          </p>
        )}
        {Fld({ k: "stock_qty", label: t("Απόθεμα (τεμ)", "Stock (units)"), type: "number" })}
        {Fld({ k: "min_stock", label: t("Σημείο αναπαραγγελίας", "Reorder point"), type: "number" })}
        {Fld({ k: "supplier", label: t("Προμηθευτής", "Supplier") })}
        {Fld({ k: "location", label: t("Θέση / ράφι", "Location / shelf") })}
        {Fld({ k: "batch", label: t("Παρτίδα", "Batch") })}
        <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Ημ. λήξης", "Expiry")}</span><DateInput value={f.expiry ?? ""} onChange={(v) => set("expiry", v)} /></label>
        {/* Εναλλακτικά barcodes */}
        <label className="col-span-full block text-sm"><span className="mb-1 block text-xs font-medium text-slate-500">{t("Εναλλακτικά barcodes", "Alternate barcodes")} <span className="font-normal text-slate-400">({t("κύριο = πάνω· εδώ επιπλέον, χωρισμένα με κόμμα", "main above; extra here, comma-separated")})</span></span>
          <input value={bcText} onChange={(e) => setBcText(e.target.value)} placeholder="5201234567890, 5209876543210" className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-800" /></label>

        {/* Εκδοχές (χρώμα/μέγεθος) */}
        <div className="col-span-full">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">{t("Εκδοχές (χρώμα / μέγεθος)", "Variants (color / size)")}</span>
            <button type="button" onClick={addVar} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300"><Plus className="h-3 w-3" /> {t("Προσθήκη", "Add")}</button>
          </div>
          {variants.length > 0 && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_1fr_1.4fr_70px_28px] gap-1.5 px-1 text-[10px] uppercase text-slate-400"><span>{t("Χρώμα", "Color")}</span><span>{t("Μέγεθος", "Size")}</span><span>Barcode</span><span>{t("Απόθ.", "Stock")}</span><span /></div>
              {variants.map((v, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr_70px_28px] gap-1.5">
                  <input value={v.color ?? ""} onChange={(e) => setVar(i, "color", e.target.value)} placeholder={t("π.χ. Κόκκινο", "e.g. Red")} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
                  <input value={v.size ?? ""} onChange={(e) => setVar(i, "size", e.target.value)} placeholder={t("π.χ. M", "e.g. M")} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
                  <input value={v.barcode ?? ""} onChange={(e) => setVar(i, "barcode", e.target.value)} placeholder="barcode" className="rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800" />
                  <input type="number" value={v.stock_qty ?? 0} onChange={(e) => setVar(i, "stock_qty", parseInt(e.target.value) || 0)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
                  <button type="button" onClick={() => delVar(i)} className="grid place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"><X className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Κατηγορίες e-shop (3 επίπεδα) — υποχρεωτική Κατ.1 για «προς πώληση» */}
        <div className="col-span-full">
          <div className="mb-1 text-xs font-medium text-slate-500">{t("Κατηγορίες e-shop", "e-shop categories")}</div>
          <CategoryPicker value={{ cat1_id: f.cat1_id, cat2_id: f.cat2_id, cat3_id: f.cat3_id }} onChange={(v) => setF((s) => ({ ...s, ...v }))} />
        </div>

        {/* Βίντεο οδηγιών χρήσης — εμφανίζεται στον πελάτη σε Συνταγές, Διαθεσιμότητα & e-Κατάστημα */}
        <label className="col-span-full block text-sm"><span className="mb-1 block text-xs text-slate-500">🎬 {t("Βίντεο οδηγιών χρήσης (YouTube/Vimeo)", "How-to-use video (YouTube/Vimeo)")}</span>
          <input value={f.usage_video_url ?? ""} onChange={(e) => set("usage_video_url", e.target.value || null)} placeholder={t("https://youtu.be/… ή https://vimeo.com/…", "https://youtu.be/… or https://vimeo.com/…")} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
          <span className="mt-0.5 block text-[11px] text-slate-400">{t("Δεκτά ΜΟΝΟ YouTube/Vimeo. Ο πελάτης το βλέπει στη Συνταγή του, στη Διαθεσιμότητα & στο e-Κατάστημα.", "Only YouTube/Vimeo accepted. The patient sees it in their prescription, in Availability & in the e-shop.")}</span></label>

        <div className="col-span-full mt-1 flex flex-wrap gap-5 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/40">
          <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active !== false} onChange={(e) => set("active", e.target.checked)} className="h-4 w-4" /> {t("Ενεργό είδος", "Active item")}</label>
          <label className={`inline-flex items-center gap-2 text-sm ${!f.cat1_id ? "text-slate-400" : ""}`} title={!f.cat1_id ? t("Χρειάζεται τουλάχιστον Κατηγορία 1", "Needs at least Category 1") : undefined}>
            <input type="checkbox" checked={!!f.for_sale && !!f.cat1_id} disabled={!f.cat1_id} onChange={(e) => set("for_sale", e.target.checked)} className="h-4 w-4" /> {t("Προς πώληση στο e-shop", "For sale in e-shop")}
            {!f.cat1_id && <span className="text-[11px] text-amber-600">— {t("όρισε Κατηγορία 1", "set Category 1")}</span>}
          </label>
        </div>

        {/* ── Worksheet: Πωλησιακά χαρακτηριστικά e-shop (inline, όταν «στο e-shop») ── */}
        {!!f.for_sale && (
          <div className="col-span-full space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-900 dark:bg-brand-950/20">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-brand-800 dark:text-brand-200">🛒 {t("Πωλησιακά χαρακτηριστικά e-shop", "e-shop selling attributes")}</div>
            <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Περιγραφή e-shop (marketing)", "e-shop description (marketing)")}</span>
              <textarea value={f.description_long ?? ""} onChange={(e) => set("description_long", e.target.value)} rows={3} placeholder={t("Περιγραφή που βλέπει ο πελάτης στη σελίδα προϊόντος…", "Description the customer sees on the product page…")} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Έκπτωση %", "Discount %")}{noDisc && <span className="ml-1 text-amber-600">— {t("όχι σε συνταγογραφούμενα", "not on prescription items")}</span>}</span>
                <input type="number" min={0} max={90} disabled={noDisc} value={noDisc ? 0 : (f.discount_pct ?? 0)} onChange={(e) => set("discount_pct", Math.max(0, Math.min(90, +e.target.value)))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:disabled:bg-slate-800" /></label>
              <label className="flex items-center gap-2 self-end rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-600"><input type="checkbox" checked={!!f.featured} onChange={(e) => set("featured", e.target.checked)} className="h-4 w-4" /> ⭐ {t("Προτεινόμενο (πρώτο στη βιτρίνα)", "Featured (first in storefront)")}</label>
            </div>
            {!noDisc && (f.discount_pct ?? 0) > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Έναρξη προσφοράς (προαιρετικό)", "Offer start (optional)")}</span><DateInput value={(f.sale_starts_at ?? "").split("T")[0]} onChange={(d) => set("sale_starts_at", d ? `${d}T00:00:00` : null)} /></label>
                <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Λήξη προσφοράς (προαιρετικό)", "Offer end (optional)")}</span><DateInput value={(f.sale_ends_at ?? "").split("T")[0]} onChange={(d) => set("sale_ends_at", d ? `${d}T23:59:59` : null)} /></label>
              </div>
            )}
            <div className="text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Ετικέτες (tags)", "Labels (tags)")}</span>
              <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-300 p-2 dark:border-slate-600">
                {(f.tags ?? []).map((tg) => <span key={tg} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200">{tg}<button type="button" onClick={() => set("tags", (f.tags ?? []).filter((x) => x !== tg))}><X className="h-3 w-3" /></button></span>)}
                <input value={tagIn} onChange={(e) => setTagIn(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); const v = tagIn.trim(); if (v && !(f.tags ?? []).includes(v)) set("tags", [...(f.tags ?? []), v].slice(0, 12)); setTagIn(""); } }} placeholder={(f.tags ?? []).length ? "" : t("π.χ. Προσφορά, Βιολογικό… (Enter)", "e.g. Offer, Organic… (Enter)")} className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm outline-none focus:ring-0" /></div>
            </div>
            <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Σημεία πώλησης (ένα ανά γραμμή, ως 6)", "Selling points (one per line, up to 6)")}</span>
              <textarea value={(f.highlights ?? []).join("\n")} onChange={(e) => set("highlights", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6))} rows={3} placeholder={t("π.χ.\nΓια ευαίσθητο δέρμα\nΧωρίς parabens", "e.g.\nFor sensitive skin\nParaben-free")} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
            <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Bonus πόντοι πιστότητας (×)", "Loyalty bonus points (×)")}</span>
              <input type="number" min={1} max={10} step={0.5} value={f.points_multiplier ?? 1} onChange={(e) => set("points_multiplier", Math.max(1, Math.min(10, +e.target.value)))} className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
          </div>
        )}
      </div>
      <button onClick={save} disabled={busy} className="mt-4 w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? t("Αποθήκευση…", "Saving…") : t("Αποθήκευση", "Save")}</button>
    </Modal>
  );
}

function HistoryModal({ item, t, onClose }: { item: Item; t: (a: string, b: string) => string; onClose: () => void }) {
  const KIND_EL = kindElMap(t);
  const h = useQuery({ queryKey: ["wh-hist", item.barcode], queryFn: () => api<{ items: Move[] }>(`/catalog/warehouse/${item.barcode}/movements`), retry: false });
  return (
    <Modal title={`${t("Ιστορικό κινήσεων", "Movement history")} — ${item.name}`} onClose={onClose}>
      <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
        {(h.data?.items ?? []).length === 0 && <div className="py-6 text-center text-sm text-slate-400"><PackageX className="mx-auto mb-1 h-6 w-6" />{t("Καμία κίνηση ακόμη.", "No movements yet.")}</div>}
        {(h.data?.items ?? []).map((m, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
            <div>
              <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${m.kind === "in" ? "bg-emerald-100 text-emerald-700" : m.kind === "out" ? "bg-sky-100 text-sky-700" : m.kind === "waste" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{KIND_EL[m.kind] ?? m.kind}</span>
              <span className="ml-2 font-semibold">{m.kind === "adjust" ? `→ ${m.new_stock}` : `${m.kind === "in" ? "+" : "−"}${m.qty}`}</span>
              {m.reason && <span className="ml-2 text-xs text-slate-400">{m.reason}</span>}
            </div>
            <div className="text-right text-[10px] text-slate-400">{new Date(m.at).toLocaleString("el-GR")}<div>{t("υπόλοιπο", "balance")}: {m.new_stock}</div></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

const importFields = (t: (a: string, b: string) => string): { k: string; label: string; req?: boolean }[] => [
  { k: "barcode", label: "Barcode", req: true },
  { k: "name", label: t("Όνομα", "Name"), req: true },
  { k: "stock", label: t("Απόθεμα", "Stock") },
  { k: "cost", label: t("Χονδρική/κόστος (€)", "Cost (€)") },
  { k: "price", label: t("Λιανική (€)", "Retail (€)") },
  { k: "category", label: t("Κατηγορία", "Category") },
  { k: "type", label: t("Τύπος", "Type") },
  { k: "supplier", label: t("Προμηθευτής", "Supplier") },
  { k: "location", label: t("Θέση/ράφι", "Location/shelf") },
  { k: "min_stock", label: t("Σημείο αναπαραγγελίας", "Reorder point") },
  { k: "expiry", label: t("Λήξη", "Expiry") },
  { k: "batch", label: t("Παρτίδα", "Batch") },
];

const GUESS: Record<string, string[]> = {
  barcode: ["barcode", "κωδικ", "ean", "bar code"], name: ["name", "ονομα", "όνομα", "περιγραφ", "είδος", "ειδος", "product"],
  stock: ["stock", "αποθεμα", "απόθεμα", "ποσοτητ", "ποσότητ", "qty", "υπολοιπ", "υπόλοιπ"],
  cost: ["cost", "χονδρικ", "κοστος", "κόστος", "buy", "αγορα"], price: ["price", "λιανικ", "τιμη", "τιμή", "retail", "πωλησ"],
  category: ["categ", "κατηγορ"], supplier: ["suppl", "προμηθευτ"], expiry: ["exp", "ληξη", "λήξη"],
  batch: ["batch", "παρτιδ", "lot"], location: ["locat", "θεση", "θέση", "ραφι", "ράφι"], min_stock: ["min", "αναπαραγγ", "reorder"],
};

function ImportModal({ t, onClose, onDone }: { t: (a: string, b: string) => string; onClose: () => void; onDone: () => void }) {
  const TYPE_EL = typeElMap(t);
  const IMPORT_FIELDS = importFields(t);
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<{ columns: number; rows: string[][]; total_rows: number } | null>(null);
  const [startRow, setStartRow] = useState(2);
  const [map, setMap] = useState<Record<string, string>>({});
  const [forSale, setForSale] = useState(false);
  const [dtype, setDtype] = useState("parapharmacy");
  const [busy, setBusy] = useState(false);

  async function pick(f: File) {
    setFile(f); setBusy(true);
    try {
      const fd = new FormData(); fd.append("file", f);
      const r = await apiUpload<{ columns: number; rows: string[][]; total_rows: number }>("/catalog/import/preview", fd);
      setPv(r);
      const header = (r.rows[0] || []).map((x) => (x || "").toLowerCase());
      const g: Record<string, string> = {};
      header.forEach((h, i) => { for (const [fld, kws] of Object.entries(GUESS)) { if (!g[fld] && kws.some((k) => h.includes(k))) g[fld] = String(i); } });
      setMap(g);
      setStartRow(Object.keys(g).length ? 2 : 1);
    } catch { await appAlert(t("Δεν διαβάστηκε το αρχείο. Δοκίμασε .xlsx ή .csv.", "Could not read the file. Try .xlsx or .csv.")); }
    setBusy(false);
  }

  async function commit() {
    if (!file || !map.barcode || map.barcode === "" || !map.name || map.name === "") { await appAlert(t("Όρισε τουλάχιστον στήλη για Barcode & Όνομα.", "Map at least Barcode & Name columns.")); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("mapping", JSON.stringify(map));
      fd.append("start_row", String(startRow)); fd.append("default_type", dtype); fd.append("for_sale", String(forSale));
      const r = await apiUpload<{ imported: number; skipped: number }>("/catalog/import/commit", fd);
      await appAlert(t(`✓ Εισήχθησαν ${r.imported} είδη (παραλείφθηκαν ${r.skipped}).`, `✓ Imported ${r.imported} (skipped ${r.skipped}).`));
      onDone();
    } catch { await appAlert(t("Αποτυχία εισαγωγής.", "Import failed.")); }
    setBusy(false);
  }

  const cols = pv?.columns ?? 0;
  const sample = (i: number) => { for (const r of (pv?.rows ?? []).slice(Math.max(0, startRow - 1))) { if ((r[i] || "").trim()) return r[i]; } return ""; };

  return (
    <Modal size="xl" title={t("Εισαγωγή από Excel / CSV", "Import from Excel / CSV")} onClose={onClose}>
      {!pv ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <FileSpreadsheet className="mx-auto h-10 w-10 text-emerald-600" />
          <p className="mt-2 text-sm text-slate-500">{t("Ανέβασε το αρχείο σου (.xlsx ή .csv). Στο επόμενο βήμα ορίζεις μόνος σου ποια στήλη έχει ποια πληροφορία — δεν χρειάζεται συγκεκριμένη μορφή.", "Upload your file (.xlsx or .csv). Next you map which column holds what — no fixed format needed.")}</p>
          <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">
            <Upload className="h-4 w-4" /> {busy ? t("Ανάγνωση…", "Reading…") : t("Επιλογή αρχείου", "Choose file")}
            <input type="file" accept=".xlsx,.xlsm,.csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
          </label>
        </div>
      ) : (
        <div className="space-y-4">
          {/* preview */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Δείγμα αρχείου", "File preview")} · {pv.total_rows} {t("γραμμές", "rows")}</div>
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="min-w-full text-xs">
                <thead><tr className="bg-slate-50 dark:bg-slate-800">{Array.from({ length: cols }, (_, i) => <th key={i} className="whitespace-nowrap px-2 py-1 text-left font-semibold text-slate-500">{t("Στήλη", "Col")} {i + 1}</th>)}</tr></thead>
                <tbody>{pv.rows.slice(0, 8).map((r, ri) => (
                  <tr key={ri} className={`border-t border-slate-100 dark:border-slate-800 ${ri + 1 < startRow ? "bg-amber-50/60 text-slate-400 dark:bg-amber-950/20" : ""}`}>
                    {Array.from({ length: cols }, (_, ci) => <td key={ci} className="max-w-[160px] truncate px-2 py-1">{r[ci]}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>

          {/* start row */}
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            {t("Τα δεδομένα ξεκινούν από τη γραμμή:", "Data starts at row:")}
            <input type="number" min={1} value={startRow} onChange={(e) => setStartRow(Math.max(1, parseInt(e.target.value) || 1))} className="w-20 rounded-lg border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-800" />
            <span className="text-xs text-slate-400">{t("(οι από πάνω γραμμές = τίτλοι/κενά, αγνοούνται)", "(rows above = titles/blank, ignored)")}</span>
          </label>

          {/* mapping */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Χαρτογράφηση στηλών", "Column mapping")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {IMPORT_FIELDS.map((fl) => (
                <label key={fl.k} className="text-sm">
                  <span className="mb-0.5 block text-xs text-slate-500">{fl.label}{fl.req && <span className="text-rose-500"> *</span>}</span>
                  <select value={map[fl.k] ?? ""} onChange={(e) => setMap((m) => ({ ...m, [fl.k]: e.target.value }))}
                    className={`w-full rounded-lg border px-2 py-1.5 text-sm dark:bg-slate-800 ${fl.req && !map[fl.k] ? "border-rose-300" : "border-slate-300 dark:border-slate-600"}`}>
                    <option value="">— {t("καμία", "none")} —</option>
                    {Array.from({ length: cols }, (_, i) => <option key={i} value={i}>{t("Στήλη", "Col")} {i + 1}{sample(i) ? ` · ${sample(i).slice(0, 18)}` : ""}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>

          {/* options */}
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800/40">
            <label className="flex items-center gap-1.5">{t("Προεπιλ. τύπος:", "Default type:")}
              <select value={dtype} onChange={(e) => setDtype(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-800">
                <option value="parapharmacy">{TYPE_EL.parapharmacy}</option><option value="otc_medicine">{TYPE_EL.otc_medicine}</option><option value="rx_medicine">{TYPE_EL.rx_medicine}</option>
              </select></label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={forSale} onChange={(e) => setForSale(e.target.checked)} className="h-4 w-4" /> {t("Εισαγωγή απευθείας «προς πώληση» (Κατάλογος)", "Import directly as «for sale» (Catalog)")}</label>
          </div>

          <div className="flex items-center justify-between">
            <button onClick={() => { setPv(null); setFile(null); }} className="text-sm text-slate-500 underline">{t("← Άλλο αρχείο", "← Another file")}</button>
            <button onClick={commit} disabled={busy} className="rounded-xl bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? t("Εισαγωγή…", "Importing…") : t("Εισαγωγή δεδομένων", "Import data")}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
