"use client";

/* Έτοιμος κατάλογος ειδών — «ποια προϊόντα, σε ποιο φαρμακείο».

   ΟΧΙ «από ποιο φαρμακείο σε ποιο»: αυτό που πουλάμε είναι έτοιμος κατάλογος, όχι αντιγραφή από
   τον τάδε πελάτη. Το ποιο φαρμακείο τυχαίνει να κρατά σήμερα τον πληρέστερο κατάλογο είναι δική
   μας λεπτομέρεια — φαίνεται, αλλά δεν είναι επιλογή του χρήστη.

   ΤΟ ΑΠΟΘΕΜΑ ΔΕΝ ΤΑΞΙΔΕΥΕΙ: κάθε είδος ξεκινά με μηδέν τεμάχια. Δίνουμε το ΡΑΦΙ (ονόματα,
   barcodes, τιμές, κατηγορίες, φωτογραφίες), όχι την αποθήκη κανενός. */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Package, Calculator, Loader2, AlertTriangle, Pill, Sparkles } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";

type Ph = { id: string; name: string | null; items: number; has_addon: boolean; is_master: boolean };
type Bucket = { key: string | null; n: number };
type Pair = { type: string | null; key: string | null; n: number };
type Catalog = { source: { id: string; name: string | null } | null; total: number;
                 by_type: Bucket[]; by_category: Bucket[]; by_type_category: Pair[] };

const TYPES = [
  { key: "rx_medicine", label: "Συνταγογραφούμενα φάρμακα", icon: Pill },
  { key: "otc_medicine", label: "Μη συνταγογραφούμενα (ΜΗ.ΣΥ.ΦΑ.)", icon: Pill },
  { key: "parapharmacy", label: "Παραφάρμακα & καλλυντικά", icon: Sparkles },
];

const num = (n: number) => n.toLocaleString("el-GR");

export default function CatalogSeedPage() {
  const [target, setTarget] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  const phs = useQuery({ queryKey: ["seed", "pharmacies"],
    queryFn: () => adminApi<{ items: Ph[]; hidden_without_addon?: number }>("/admin/catalog-seed/pharmacies") });
  const cat = useQuery({ queryKey: ["seed", "catalog"],
    queryFn: () => adminApi<Catalog>("/admin/catalog-seed/catalog") });

  const countOf = (k: string) => cat.data?.by_type.find((b) => b.key === k)?.n ?? 0;
  const tgtPh = phs.data?.items.find((p) => p.id === target);

  /* Οι κατηγορίες ακολουθούν τον τύπο. Οι θεραπευτικές («Καρδιαγγειακά») ανήκουν στα φάρμακα,
     τα «Αντηλιακά/Μαλλιά» στα παραφάρμακα. Σε ενιαία λίστα διάλεγες «Καρδιαγγειακά» ενώ είχες
     ζητήσει παραφάρμακα και έπαιρνες μηδέν είδη, χωρίς να καταλαβαίνεις γιατί. */
  const visibleCats = (() => {
    const pairs = (cat.data?.by_type_category || [])
      .filter((p) => p.key && (types.length === 0 || types.includes(String(p.type))));
    const sum = new Map<string, number>();
    for (const p of pairs) sum.set(String(p.key), (sum.get(String(p.key)) ?? 0) + p.n);
    return [...sum.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
  })();
  const uncat = (cat.data?.by_type_category || [])
    .filter((p) => !p.key && (types.length === 0 || types.includes(String(p.type))))
    .reduce((a, p) => a + p.n, 0);

  const toggle = (arr: string[], set: (v: string[]) => void, k: string) => {
    set(arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]);
    setPreview(null);
  };
  // Αλλάζοντας τύπο, καθάρισε κατηγορίες που δεν ανήκουν πια σ' αυτόν — αλλιώς μένει κρυφό
  // φίλτρο που μηδενίζει το αποτέλεσμα.
  const toggleType = (k: string) => {
    const next = types.includes(k) ? types.filter((x) => x !== k) : [...types, k];
    const allowed = new Set((cat.data?.by_type_category || [])
      .filter((p) => p.key && (next.length === 0 || next.includes(String(p.type))))
      .map((p) => String(p.key)));
    setTypes(next);
    setCats((c) => c.filter((x) => allowed.has(x)));
    setPreview(null);
  };

  async function run(dry: boolean) {
    if (!target) { appAlert("Διάλεξε φαρμακείο."); return; }
    if (!dry && !(await appConfirm(
      `Φόρτωση ${preview != null ? num(preview) + " ειδών" : "ειδών"} στο «${tgtPh?.name}»;` +
      (overwrite ? " Τα υπάρχοντα θα ΕΝΗΜΕΡΩΘΟΥΝ." : " Τα υπάρχοντα δεν θα πειραχτούν."),
      { title: "Φόρτωση καταλόγου", confirmText: "Φόρτωση" }))) return;
    setBusy(true);
    try {
      const r = await adminApi<{ would_copy?: number; copied?: number; updated?: number; skipped?: number }>(
        "/admin/catalog-seed/copy", { method: "POST", body: JSON.stringify({
          target_tenant: target, types, categories: cats, overwrite, dry_run: dry }) });
      if (dry) setPreview(r.would_copy ?? 0);
      else {
        setPreview(null);
        await appAlert(`✓ Νέα: ${num(r.copied ?? 0)} · Ενημερωμένα: ${num(r.updated ?? 0)} · Παραλείφθηκαν: ${num(r.skipped ?? 0)}`,
          { title: "Ολοκληρώθηκε" });
        phs.refetch();
      }
    } catch (e) {
      const d = (e as { problem?: { detail?: { message?: string } } })?.problem?.detail;
      appAlert(d?.message || "Απέτυχε.");
    }
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
            Διάλεξε ποια προϊόντα και σε ποιο φαρμακείο. Το απόθεμα ξεκινά πάντα στο μηδέν.
          </p>
        </div>
      </header>

      {cat.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {cat.isError && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Δεν φορτώθηκε ο κατάλογος.
        </p>
      )}

      {/* 1. ΠΟΙΑ ΠΡΟΪΟΝΤΑ */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 text-sm font-semibold text-slate-700">1. Ποια προϊόντα</div>
        <div className="grid gap-3 sm:grid-cols-3">
          {TYPES.map((t) => {
            const on = types.includes(t.key);
            const n = countOf(t.key);
            return (
              <button key={t.key} onClick={() => toggleType(t.key)} disabled={!n}
                className={`rounded-xl border p-4 text-left transition disabled:opacity-40 ${on
                  ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                  : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"}`}>
                <t.icon className={`mb-2 h-5 w-5 ${on ? "text-indigo-600" : "text-slate-400"}`} />
                <div className={`text-sm font-medium ${on ? "text-indigo-900" : "text-slate-700"}`}>{t.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{num(n)} είδη</div>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Αν δεν διαλέξεις κανένα, μπαίνουν <b>όλα</b> ({num(cat.data?.total ?? 0)} είδη).
        </p>

        {/* Προαιρετικός, λεπτότερος περιορισμός */}
        {!!visibleCats.length && (
          <details className="mt-4" open>
            <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700">
              Περιορισμός σε συγκεκριμένες κατηγορίες (προαιρετικό)
            </summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {visibleCats.map((b) => (
                <button key={b.key} onClick={() => toggle(cats, setCats, b.key)}
                  className={`rounded-lg border px-2.5 py-1 text-xs ${cats.includes(b.key)
                    ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                  {b.key} <span className="text-slate-400">{num(b.n)}</span>
                </button>
              ))}
            </div>
            {!!uncat && (
              <p className="mt-2 text-xs text-slate-400">
                {num(uncat)} είδη δεν έχουν ακόμη κατηγορία — μπαίνουν μόνο αν δεν περιορίσεις
                κατηγορία. Η αυτόματη κατηγοριοποίηση τα πιάνει.
              </p>
            )}
          </details>
        )}
      </section>

      {/* 2. ΣΕ ΠΟΙΟ ΦΑΡΜΑΚΕΙΟ */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 text-sm font-semibold text-slate-700">2. Σε ποιο φαρμακείο</div>
        <select value={target} onChange={(e) => { setTarget(e.target.value); setPreview(null); }}
          className="block w-full max-w-xl rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">— διάλεξε φαρμακείο —</option>
          {(phs.data?.items || []).filter((p) => !p.is_master).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.items ? ` — έχει ήδη ${num(p.items)} είδη` : ""}
            </option>
          ))}
        </select>
        {/* Εμφανίζονται ΜΟΝΟ όσοι πληρώνουν το πρόσθετο: ένα λάθος κλικ εδώ φορτώνει δεκάδες
            χιλιάδες είδη σε πελάτη που δεν το αγόρασε, και το ξεφόρτωμα δεν είναι απλή ακύρωση. */}
        {!phs.isLoading && !phs.data?.items?.filter((p) => !p.is_master).length && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            Κανένα φαρμακείο δεν έχει ενεργό το πρόσθετο «Έτοιμος κατάλογος ειδών».
            Ενεργοποίησέ το πρώτα από την καρτέλα του πελάτη.
          </p>
        )}
        {!!phs.data?.hidden_without_addon && (
          <p className="mt-2 text-xs text-slate-400">
            {num(phs.data.hidden_without_addon)} φαρμακεία δεν εμφανίζονται — δεν έχουν το πρόσθετο.
          </p>
        )}

        <label className="mt-4 flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setPreview(null); }} />
          Ενημέρωση και των υπαρχόντων ειδών (ίδιο barcode)
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button onClick={() => run(true)} disabled={busy || !target}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <Calculator className="h-4 w-4" />Υπολογισμός
          </button>
          {preview != null && (
            <span className="text-sm font-medium text-slate-700">Θα φορτωθούν <b>{num(preview)}</b> είδη.</span>
          )}
          <button onClick={() => run(false)} disabled={busy || !target}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Φόρτωση καταλόγου
          </button>
        </div>
      </section>

    </div>
  );
}
