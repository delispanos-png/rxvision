"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layers, Plus, Pencil, Trash2, ChevronRight, Upload, X, FileSpreadsheet, CheckCircle2, Image as ImageIcon, Wand2 } from "lucide-react";
import { api, apiUpload, API_BASE } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appPrompt, appConfirm, appAlert } from "@/store/dialogStore";
import { useCategoryTree, type Cat } from "@/components/catalog/CategoryPicker";

type Preview = { rows: string[][]; ncols: number; total_rows: number };
const colName = (i: number) => String.fromCharCode(65 + i);

export default function EshopCategoriesPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isError } = useCategoryTree();
  const cats = data?.items ?? [];
  const [importOpen, setImportOpen] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoFor, setPhotoFor] = useState<string | null>(null);
  const kids = (parent: string | null, level: number) => cats.filter((c) => c.level === level && (level === 1 ? true : c.parent_id === parent));
  const refetch = () => qc.invalidateQueries({ queryKey: ["catalog-cat-tree"] });

  async function onPhoto(f: File) {
    if (!photoFor) return;
    const fd = new FormData(); fd.append("file", f);
    try { await apiUpload(`/catalog/category/${photoFor}/image`, fd); } catch { await appAlert(t("Αποτυχία μεταφόρτωσης εικόνας.", "Image upload failed.")); }
    setPhotoFor(null); refetch();
  }
  async function delPhoto(c: Cat) { try { await api(`/catalog/category/${c.id}/image`, { method: "DELETE" }); } catch { /* ignore */ } refetch(); }
  async function setIcon(c: Cat) {
    const icon = await appPrompt(t("Εικονίδιο (emoji) κατηγορίας", "Category icon (emoji)"), { defaultValue: c.icon ?? "", placeholder: "❤️ 🧠 💊 …" });
    if (icon === null) return;
    await api(`/catalog/category/${c.id}/icon`, { method: "POST", body: JSON.stringify({ icon: icon.trim() }) });
    refetch();
  }

  const [seeding, setSeeding] = useState(false);
  async function seedFromProducts() {
    if (!(await appConfirm(t("Να δημιουργηθούν αυτόματα Κατηγορίες 1 από τις υπάρχουσες κατηγορίες των ειδών σου και να ανατεθούν στα είδη; (δεν αλλάζει ό,τι έχεις βάλει χειροκίνητα)", "Auto-create Category-1 nodes from your items' existing categories and assign them? (won't touch manual assignments)"), { title: t("Από κατηγορίες ειδών", "From item categories"), confirmText: t("Δημιουργία", "Create") }))) return;
    setSeeding(true);
    try {
      const r = await api<{ ok: boolean; categories: number; created: number; assigned: number }>("/catalog/category/seed-from-products", { method: "POST" });
      await appAlert(t(`Δημιουργήθηκαν ${r.created} κατηγορίες (${r.categories} σύνολο) και ανατέθηκαν σε ${r.assigned} είδη.`, `Created ${r.created} categories (${r.categories} total), assigned to ${r.assigned} items.`), { title: t("Ολοκληρώθηκε", "Done") });
      refetch();
    } catch { await appAlert(t("Αποτυχία μεταφοράς.", "Migration failed.")); }
    setSeeding(false);
  }
  async function add(level: number, parent: string | null) {
    const name = await appPrompt(t(`Νέα κατηγορία επιπέδου ${level}`, `New level-${level} category`), { placeholder: t("Όνομα κατηγορίας", "Category name") });
    if (!name || !name.trim()) return;
    await api("/catalog/category", { method: "POST", body: JSON.stringify({ name: name.trim(), parent_id: parent }) });
    refetch();
  }
  async function rename(c: Cat) {
    const name = await appPrompt(t("Μετονομασία κατηγορίας", "Rename category"), { defaultValue: c.name });
    if (!name || !name.trim()) return;
    await api(`/catalog/category/${c.id}`, { method: "PUT", body: JSON.stringify({ name: name.trim() }) });
    refetch();
  }
  async function del(c: Cat) {
    const nSub = cats.filter((x) => x.parent_id === c.id).length;
    if (!(await appConfirm(t(`Διαγραφή «${c.name}»${nSub ? ` και ${nSub} υποκατηγοριών` : ""}; Τα είδη θα χάσουν αυτή την κατηγορία.`, `Delete «${c.name}»${nSub ? ` and ${nSub} subcategories` : ""}? Items will lose this category.`), { danger: true, confirmText: t("Διαγραφή", "Delete") }))) return;
    await api(`/catalog/category/${c.id}`, { method: "DELETE" });
    refetch();
  }

  const Node = ({ c, level }: { c: Cat; level: number }) => (
    <div className={level === 1 ? "rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" : ""}>
      <div className="group flex items-center gap-1.5 py-1">
        {level > 1 && <ChevronRight className="h-3.5 w-3.5 text-slate-300" />}
        {c.image_id ? (
          <span className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${API_BASE}/catalog/image/${c.image_id}`} alt="" className="h-8 w-8 rounded-md object-cover" />
            <button onClick={() => delPhoto(c)} title={t("Αφαίρεση εικόνας", "Remove image")} className="absolute -right-1 -top-1 hidden h-4 w-4 place-items-center rounded-full bg-rose-600 text-white group-hover:grid"><X className="h-2.5 w-2.5" /></button>
          </span>
        ) : (
          <button onClick={() => { setPhotoFor(c.id); photoRef.current?.click(); }} title={t("Προσθήκη φωτογραφίας", "Add photo")} className="grid h-8 w-8 place-items-center rounded-md border border-dashed border-slate-300 text-slate-300 hover:border-brand-400 hover:text-brand-500 dark:border-slate-600"><ImageIcon className="h-4 w-4" /></button>
        )}
        <button onClick={() => setIcon(c)} title={t("Αλλαγή εικονιδίου", "Change icon")} className="text-lg leading-none transition hover:scale-110">{c.icon || "🏷️"}</button>
        <span className={`${level === 1 ? "text-sm font-bold text-slate-800 dark:text-slate-100" : level === 2 ? "text-sm text-slate-700 dark:text-slate-200" : "text-sm text-slate-500 dark:text-slate-400"}`}>{c.name}</span>
        <span className="ml-1 rounded bg-slate-100 px-1.5 text-[10px] text-slate-400 dark:bg-slate-800">L{level}</span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          {c.image_id && <button onClick={() => { setPhotoFor(c.id); photoRef.current?.click(); }} title={t("Αλλαγή φωτογραφίας", "Change photo")} className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><ImageIcon className="h-3.5 w-3.5" /></button>}
          {level < 3 && <button onClick={() => add(level + 1, c.id)} title={t("Προσθήκη υποκατηγορίας", "Add subcategory")} className="grid h-6 w-6 place-items-center rounded text-brand-600 hover:bg-brand-50 dark:hover:bg-slate-800"><Plus className="h-3.5 w-3.5" /></button>}
          <button onClick={() => rename(c)} title={t("Μετονομασία", "Rename")} className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><Pencil className="h-3.5 w-3.5" /></button>
          <button onClick={() => del(c)} title={t("Διαγραφή", "Delete")} className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {level < 3 && (
        <div className={level === 1 ? "mt-1 space-y-0.5 border-l border-slate-100 pl-3 dark:border-slate-800" : "border-l border-slate-100 pl-3 dark:border-slate-800"}>
          {kids(c.id, level + 1).map((k) => <Node key={k.id} c={k} level={level + 1} />)}
        </div>
      )}
    </div>
  );

  return (
    <div className="max-w-3xl space-y-4">
      <input ref={photoRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ""; }} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xl font-semibold text-slate-800 dark:text-slate-100"><Layers className="h-6 w-6 text-brand-600" /> {t("Κατηγορίες e-shop", "e-shop Categories")}</div>
          <p className="text-sm text-slate-500">{t("Δέντρο 3 επιπέδων — οδηγεί την κατηγοριοποίηση ειδών, το μενού της πύλης πελατών & τη στόχευση προσφορών. Ένα είδος χρειάζεται τουλάχιστον Κατηγορία 1 για να μπει στο e-shop.", "3-level tree — drives item categorization, the customer-portal menu & offer targeting. An item needs at least Category 1 to go on sale.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={seedFromProducts} disabled={seeding} className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"><Wand2 className="h-4 w-4" /> {t("Από κατηγορίες ειδών", "From item categories")}</button>
          <button onClick={() => setImportOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"><FileSpreadsheet className="h-4 w-4" /> {t("Εισαγωγή Excel", "Import Excel")}</button>
          <button onClick={() => add(1, null)} className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> {t("Νέα Κατηγορία 1", "New Category 1")}</button>
        </div>
      </div>
      {importOpen && <ImportModal t={t} onClose={() => setImportOpen(false)} onDone={refetch} />}

      {isError ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900">{t("Το κύκλωμα e-shop δεν είναι ενεργό.", "The e-shop module is not enabled.")}</div>
      ) : kids(null, 1).length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-600 dark:bg-slate-900">
          <Layers className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-2 text-sm text-slate-500">{t("Καμία κατηγορία ακόμη. Ξεκίνα με μια «Κατηγορία 1» (π.χ. Ομορφιά, Μαμά & Παιδί, Βιταμίνες).", "No categories yet. Start with a «Category 1» (e.g. Beauty, Mom & Baby, Vitamins).")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {kids(null, 1).map((c) => <Node key={c.id} c={c} level={1} />)}
        </div>
      )}
    </div>
  );
}

function ImportModal({ t, onClose, onDone }: { t: (a: string, b: string) => string; onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [prev, setPrev] = useState<Preview | null>(null);
  const [startRow, setStartRow] = useState(2);
  const [col1, setCol1] = useState(0);
  const [col2, setCol2] = useState(-1);
  const [col3, setCol3] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ processed: number; created: number } | null>(null);

  async function onFile(f: File) {
    setFile(f); setResult(null); setPrev(null);
    const fd = new FormData(); fd.append("file", f);
    try { setPrev(await apiUpload<Preview>("/catalog/category/import/preview", fd)); }
    catch { await appAlert(t("Αδύνατη ανάγνωση αρχείου (δέξου .xlsx ή .csv).", "Could not read file (accepts .xlsx or .csv).")); }
  }
  async function doImport() {
    if (!file) return; setBusy(true);
    const fd = new FormData();
    fd.append("file", file); fd.append("start_row", String(startRow));
    fd.append("col1", String(col1)); fd.append("col2", String(col2)); fd.append("col3", String(col3));
    try { setResult(await apiUpload<{ processed: number; created: number }>("/catalog/category/import", fd)); onDone(); }
    catch { await appAlert(t("Αποτυχία εισαγωγής.", "Import failed.")); }
    setBusy(false);
  }
  const ncols = prev?.ncols ?? 0;
  const ColSel = ({ label, val, set, optional }: { label: string; val: number; set: (n: number) => void; optional?: boolean }) => (
    <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{label}{!optional && <span className="text-rose-500"> *</span>}</span>
      <select value={val} onChange={(e) => set(parseInt(e.target.value))} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
        {optional && <option value={-1}>— {t("καμία", "none")} —</option>}
        {Array.from({ length: ncols }, (_, i) => <option key={i} value={i}>{t("Στήλη", "Col")} {colName(i)}{prev?.rows?.[startRow - 1]?.[i] ? ` — ${prev.rows[startRow - 1][i].slice(0, 20)}` : ""}</option>)}
      </select></label>
  );

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
        <div className="mb-4 flex items-center justify-between"><h3 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-slate-100"><FileSpreadsheet className="h-5 w-5 text-brand-600" /> {t("Εισαγωγή κατηγοριών από Excel/CSV", "Import categories from Excel/CSV")}</h3><button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800"><X className="h-4 w-4" /></button></div>

        {result ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center dark:border-emerald-900 dark:bg-emerald-950/20">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
            <p className="mt-2 font-semibold text-emerald-700 dark:text-emerald-300">{t("Ολοκληρώθηκε!", "Done!")}</p>
            <p className="text-sm text-slate-500">{t(`Επεξεργάστηκαν ${result.processed} γραμμές · δημιουργήθηκαν ${result.created} νέες κατηγορίες.`, `Processed ${result.processed} rows · created ${result.created} new categories.`)}</p>
            <button onClick={onClose} className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">{t("Κλείσιμο", "Close")}</button>
          </div>
        ) : (
          <>
            <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
            {!prev ? (
              <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-8 text-slate-500 hover:border-brand-400 dark:border-slate-600">
                <Upload className="h-8 w-8" /> {t("Επίλεξε αρχείο .xlsx ή .csv", "Choose a .xlsx or .csv file")}
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-500">{t(`${file?.name} · ${prev.total_rows} γραμμές. Όρισε από ποια γραμμή ξεκινούν τα δεδομένα και ποια στήλη έχει κάθε επίπεδο κατηγορίας.`, `${file?.name} · ${prev.total_rows} rows. Set the data start row and which column holds each category level.`)}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Γραμμή έναρξης", "Start row")}</span>
                    <input type="number" min={1} value={startRow} onChange={(e) => setStartRow(Math.max(1, parseInt(e.target.value) || 1))} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                  <ColSel label={t("Κατηγορία 1", "Category 1")} val={col1} set={setCol1} />
                  <ColSel label={t("Κατηγορία 2", "Category 2")} val={col2} set={setCol2} optional />
                  <ColSel label={t("Κατηγορία 3", "Category 3")} val={col3} set={setCol3} optional />
                </div>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                  <table className="min-w-full text-xs">
                    <thead><tr className="bg-slate-50 dark:bg-slate-800">{Array.from({ length: ncols }, (_, i) => <th key={i} className={`px-2 py-1 text-left font-semibold ${i === col1 ? "bg-brand-100 text-brand-700" : i === col2 ? "bg-emerald-100 text-emerald-700" : i === col3 ? "bg-violet-100 text-violet-700" : "text-slate-400"}`}>{colName(i)}</th>)}</tr></thead>
                    <tbody>{prev.rows.map((r, ri) => (
                      <tr key={ri} className={`${ri === startRow - 1 ? "bg-amber-50 dark:bg-amber-950/20" : ""} border-t border-slate-100 dark:border-slate-800`}>
                        {Array.from({ length: ncols }, (_, ci) => <td key={ci} className="max-w-[160px] truncate px-2 py-1 text-slate-600 dark:text-slate-300">{r[ci] ?? ""}</td>)}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between">
                  <button onClick={() => fileRef.current?.click()} className="text-xs text-slate-400 underline">{t("Άλλο αρχείο", "Different file")}</button>
                  <button onClick={doImport} disabled={busy} className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? t("Εισαγωγή…", "Importing…") : t("Εισαγωγή δέντρου", "Import tree")}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
