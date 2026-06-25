"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, RotateCcw, Save, Percent } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Markup = { bands: number[][]; is_default: boolean; default_bands: number[][]; updated_at: string | null };

export default function MarkupConfigPage() {
  const { data } = useQuery({ queryKey: ["admin", "markup"], queryFn: () => adminApi<Markup>("/admin/markup"), retry: false });
  const [bands, setBands] = useState<number[][]>([]);
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setBands(data.bands.map((b) => [b[0], b[1]]));
    setIsDefault(data.is_default);
  }, [data]);

  const setCell = (i: number, j: number, v: string) =>
    setBands((s) => s.map((row, ri) => (ri === i ? (j === 0 ? [Number(v), row[1]] : [row[0], Number(v)]) : row)));
  const addRow = () => setBands((s) => [...s, [s.length ? s[s.length - 1][0] + 250 : 50, 0]]);
  const delRow = (i: number) => setBands((s) => s.filter((_, ri) => ri !== i));
  const resetDefault = () => { if (data) setBands(data.default_bands.map((b) => [b[0], b[1]])); };

  async function save() {
    setBusy(true); setNotice(null);
    try {
      const clean = bands.filter((b) => b[0] > 0 && b[1] >= 0).sort((a, b) => a[0] - b[0]);
      await adminApi("/admin/markup", { method: "PUT", body: JSON.stringify({ bands: clean }) });
      setNotice("✓ Αποθηκεύτηκε. Εφαρμόζεται σε ΟΛΟΥΣ τους πελάτες — τα ιστορικά δεδομένα επανυπολογίζονται στο παρασκήνιο.");
      setIsDefault(false);
    } catch {
      setNotice("⚠ Αποτυχία αποθήκευσης.");
    } finally { setBusy(false); }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-1 flex items-center gap-2">
        <Percent className="h-5 w-5 text-brand-600" />
        <h1 className="text-xl font-bold text-slate-900">Διατίμηση — Κλιμακωτό μεικτό κέρδος φαρμακείου</h1>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Κλίμακα Υπουργείου Υγείας: μεικτό κέρδος (%) ανά μοναδιαία λιανική τιμή. Χρησιμοποιείται για την
        εκτίμηση χονδρικής/κέρδους όλων των συνταγογραφούμενων. <b>Ισχύει καθολικά σε όλους τους πελάτες.</b>
        {isDefault ? " (Ισχύει η προεπιλεγμένη κλίμακα.)" : ""}
      </p>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 grid grid-cols-[1fr_auto_1fr_1fr_auto] items-center gap-2 text-xs font-semibold uppercase text-slate-400">
          <span>Από (€)</span><span></span><span>Μέχρι (€)</span><span>Κέρδος (%)</span><span></span>
        </div>
        <div className="space-y-1.5">
          {bands.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_1fr_1fr_auto] items-center gap-2">
              <input type="number" value={i === 0 ? 0 : Number((bands[i - 1][0] + 0.01).toFixed(2))} readOnly tabIndex={-1}
                className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-500" />
              <span className="text-slate-400">–</span>
              <input type="number" step="0.01" value={row[0]} onChange={(e) => setCell(i, 0, e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
              <input type="number" step="0.01" value={row[1]} onChange={(e) => setCell(i, 1, e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
              <button onClick={() => delRow(i)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Διαγραφή"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <button onClick={addRow} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"><Plus className="h-4 w-4" /> Προσθήκη κλιμακίου</button>
      </div>

      <p className="mt-2 text-xs text-slate-400">Το «Από» κάθε κλιμακίου προκύπτει αυτόματα από το «Μέχρι» του προηγουμένου. Το τελευταίο κλιμάκιο ισχύει και για τιμές πάνω από το όριό του. Τα γαληνικά/μαγιστρικά σκευάσματα εξαιρούνται (Ν/Α).</p>

      {notice && <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${notice.startsWith("✓") ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{notice}</div>}

      <div className="mt-4 flex items-center gap-2">
        <button onClick={save} disabled={busy || bands.length === 0} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"><Save className="h-4 w-4" /> {busy ? "Αποθήκευση…" : "Αποθήκευση & εφαρμογή σε όλους"}</button>
        <button onClick={resetDefault} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"><RotateCcw className="h-4 w-4" /> Επαναφορά προεπιλογής</button>
      </div>
    </div>
  );
}
