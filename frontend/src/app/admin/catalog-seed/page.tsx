"use client";

/* Έτοιμος κατάλογος ειδών — φόρτωση καταλόγου από ένα φαρμακείο σε άλλο.

   ΓΙΑΤΙ ΕΙΝΑΙ ΔΙΚΟ ΜΑΣ ΕΡΓΑΛΕΙΟ ΚΑΙ ΟΧΙ ΚΟΥΜΠΙ ΣΤΗΝ ΚΑΡΤΕΛΑ ΠΕΛΑΤΗ: ο κατάλογος ενός
   φαρμακείου φεύγει προς άλλο φαρμακείο. Αυτό δεν είναι ρύθμιση του πελάτη — είναι υπηρεσία που
   δίνουμε εμείς, και χρεώνεται. Στην καρτέλα του πελάτη ήταν και αόρατο και παραπλανητικό.

   ΤΟ ΑΠΟΘΕΜΑ ΔΕΝ ΤΑΞΙΔΕΥΕΙ: κάθε αντιγραμμένο είδος ξεκινά με μηδέν τεμάχια. Αντιγράφουμε το
   ΡΑΦΙ (ονόματα, barcodes, τιμές, κατηγορίες, φωτογραφίες), όχι την αποθήκη κανενός. */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Package, ArrowRight, Calculator, Loader2, AlertTriangle } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";

type Ph = { id: string; name: string | null; status?: string; items: number; has_addon: boolean };
type Bucket = { key: string | null; n: number };
type Breakdown = { total: number; by_type: Bucket[]; by_category: Bucket[] };

const TYPE_LABELS: Record<string, string> = {
  rx_medicine: "Συνταγογραφούμενα φάρμακα",
  otc_medicine: "Μη συνταγογραφούμενα (ΜΗ.ΣΥ.ΦΑ.)",
  parapharmacy: "Παραφάρμακα / καλλυντικά",
};

const num = (n: number) => n.toLocaleString("el-GR");

export default function CatalogSeedPage() {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  const phs = useQuery({ queryKey: ["seed", "pharmacies"],
    queryFn: () => adminApi<{ items: Ph[] }>("/catalog-seed/pharmacies") });
  const bd = useQuery({ queryKey: ["seed", "breakdown", source],
    queryFn: () => adminApi<Breakdown>(`/catalog-seed/breakdown?source=${encodeURIComponent(source)}`),
    enabled: !!source });

  const toggle = (arr: string[], set: (v: string[]) => void, k: string) => {
    set(arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]);
    setPreview(null);
  };

  const srcPh = phs.data?.items.find((p) => p.id === source);
  const tgtPh = phs.data?.items.find((p) => p.id === target);

  async function run(dry: boolean) {
    if (!source || !target) { appAlert("Διάλεξε πηγή και προορισμό."); return; }
    if (!dry && !tgtPh?.has_addon) {
      if (!(await appConfirm(
        `Το «${tgtPh?.name}» ΔΕΝ έχει ενεργό το πρόσθετο «Έτοιμος κατάλογος ειδών» (15 €/μήνα). ` +
        "Να προχωρήσει η φόρτωση παρ' όλα αυτά;",
        { title: "Χωρίς ενεργή συνδρομή", danger: true, confirmText: "Ναι, φόρτωσε" }))) return;
    }
    if (!dry && !(await appConfirm(
      `Φόρτωση ${preview != null ? num(preview) + " ειδών" : "ειδών"} από «${srcPh?.name}» στο «${tgtPh?.name}»;` +
      (overwrite ? " Τα υπάρχοντα είδη θα ΕΝΗΜΕΡΩΘΟΥΝ." : " Τα υπάρχοντα είδη δεν θα πειραχτούν."),
      { title: "Φόρτωση καταλόγου", confirmText: "Φόρτωση" }))) return;
    setBusy(true);
    try {
      const r = await adminApi<{ would_copy?: number; copied?: number; updated?: number; skipped?: number }>(
        "/catalog-seed/copy", { method: "POST", body: JSON.stringify({
          source_tenant: source, target_tenant: target, types, categories: cats,
          overwrite, dry_run: dry }) });
      if (dry) setPreview(r.would_copy ?? 0);
      else {
        setPreview(null);
        await appAlert(`✓ Νέα: ${num(r.copied ?? 0)} · Ενημερωμένα: ${num(r.updated ?? 0)} · Παραλείφθηκαν: ${num(r.skipped ?? 0)}`,
          { title: "Ολοκληρώθηκε" });
        phs.refetch();
      }
    } catch { appAlert("Απέτυχε."); }
    finally { setBusy(false); }
  }

  return (
    <div className="w-full space-y-5">
      <header className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg">
          <Package className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Έτοιμος κατάλογος ειδών</h1>
          <p className="text-sm text-slate-500">
            Διάλεξε από ποιο φαρμακείο, ποιες κατηγορίες, και σε ποιο φαρμακείο πάνε. Το απόθεμα ξεκινά πάντα στο μηδέν.
          </p>
        </div>
      </header>

      {/* ΠΗΓΗ → ΠΡΟΟΡΙΣΜΟΣ */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <label className="block text-xs font-medium text-slate-500">
            Από ποιο φαρμακείο
            <select value={source} onChange={(e) => { setSource(e.target.value); setCats([]); setPreview(null); }}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="">— διάλεξε πηγή —</option>
              {(phs.data?.items || []).filter((p) => p.items > 0).map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {num(p.items)} είδη</option>
              ))}
            </select>
          </label>
          <ArrowRight className="mb-2.5 hidden h-5 w-5 text-slate-400 sm:block" />
          <label className="block text-xs font-medium text-slate-500">
            Σε ποιο φαρμακείο
            <select value={target} onChange={(e) => { setTarget(e.target.value); setPreview(null); }}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="">— διάλεξε προορισμό —</option>
              {(phs.data?.items || []).filter((p) => p.id !== source).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.has_addon ? "✅ " : "⚠️ "}{p.name}{p.items ? ` — έχει ήδη ${num(p.items)}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {target && !tgtPh?.has_addon && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            Δεν έχει ενεργό το πρόσθετο «Έτοιμος κατάλογος ειδών» (15 €/μήνα).
          </p>
        )}
      </section>

      {/* ΤΙ ΦΟΡΤΩΝΟΥΜΕ */}
      {source && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 text-sm font-semibold text-slate-700">
            Τι φορτώνουμε{bd.data ? ` — η πηγή έχει ${num(bd.data.total)} είδη` : ""}
          </div>
          {bd.isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}

          <div className="mb-1 text-xs font-medium text-slate-500">Τύπος (κενό = όλοι)</div>
          <div className="mb-4 flex flex-wrap gap-2">
            {(bd.data?.by_type || []).map((b) => (
              <button key={String(b.key)} onClick={() => toggle(types, setTypes, String(b.key))}
                className={`rounded-lg border px-3 py-1.5 text-sm ${types.includes(String(b.key))
                  ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                {TYPE_LABELS[String(b.key)] || String(b.key)} <span className="text-slate-400">{num(b.n)}</span>
              </button>
            ))}
          </div>

          <div className="mb-1 text-xs font-medium text-slate-500">Κατηγορία (κενό = όλες)</div>
          <div className="flex flex-wrap gap-2">
            {(bd.data?.by_category || []).filter((b) => b.key).map((b) => (
              <button key={String(b.key)} onClick={() => toggle(cats, setCats, String(b.key))}
                className={`rounded-lg border px-2.5 py-1 text-xs ${cats.includes(String(b.key))
                  ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                {String(b.key)} <span className="text-slate-400">{num(b.n)}</span>
              </button>
            ))}
          </div>
          {/* Ειλικρίνεια: όσα είδη δεν έχουν κατηγορία δεν μπορούν να επιλεγούν με κατηγορία. */}
          {!!bd.data?.by_category.find((b) => !b.key)?.n && (
            <p className="mt-2 text-xs text-slate-400">
              {num(bd.data.by_category.find((b) => !b.key)!.n)} είδη δεν έχουν ακόμη κατηγορία —
              μπαίνουν μόνο αν δεν περιορίσεις κατηγορία. Η νυχτερινή κατηγοριοποίηση τα πιάνει.
            </p>
          )}

          <label className="mt-4 flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setPreview(null); }} />
            Ενημέρωση και των υπαρχόντων ειδών (ίδιο barcode)
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={() => run(true)} disabled={busy || !source || !target}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <Calculator className="h-4 w-4" />Υπολογισμός
            </button>
            {preview != null && (
              <span className="text-sm font-medium text-slate-700">
                Θα φορτωθούν <b>{num(preview)}</b> είδη.
              </span>
            )}
            <button onClick={() => run(false)} disabled={busy || !source || !target}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}Φόρτωση καταλόγου
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
