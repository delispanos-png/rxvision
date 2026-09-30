"use client";

import { useState } from "react";
import { Upload, Download, FileSpreadsheet, CheckCircle2, Loader2, ArrowLeft, ShieldCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiUpload, apiBlob } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Modal } from "@/components/ui/Modal";

/** Εισαγωγή στοιχείων επικοινωνίας από το εμπορικό πρόγραμμα του φαρμακείου.
 *
 *  1) ανεβάζεις .xlsx/.csv → 2) λες ποια στήλη είναι τι (προτείνεται από τις επικεφαλίδες και
 *  θυμάται τη διάταξη του προγράμματός σου για την επόμενη φορά) → 3) έλεγχος χωρίς αποθήκευση →
 *  4) εφαρμογή. Ο έλεγχος και η εφαρμογή τρέχουν τον ΙΔΙΟ υπολογισμό στον server. */

type Preview = { columns: number; total_rows: number; has_header: boolean; suggested: Record<string, number>; rows: string[][] };
type FieldStat = { filled: number; overwritten: number; same: number; kept: number; protected: number; invalid: number };
type Sample = { row: number; name: string; amka?: string | null; count?: number; field?: string; current?: string; file?: string; outcome?: string };
type Result = {
  rows: number; matched: number; by_amka: number; by_name: number; not_found: number; ambiguous: number;
  no_key: number; deceased: number; duplicate: number; no_data: number; patients_updated: number;
  fields: Record<string, FieldStat>; samples: { not_found: Sample[]; ambiguous: Sample[]; conflicts: Sample[] };
  overwrite: boolean; applied: boolean;
};

const FIELD_LABELS: [string, string, string][] = [
  ["amka", "ΑΜΚΑ", "ΑΜΚΑ"],
  ["full_name", "Ονοματεπώνυμο", "Full name"],
  ["last_name", "Επώνυμο", "Last name"],
  ["first_name", "Όνομα", "First name"],
  ["mobile", "Κινητό", "Mobile"],
  ["phone", "Σταθερό", "Landline"],
  ["email", "Email", "Email"],
  ["address", "Διεύθυνση", "Address"],
  ["city", "Πόλη", "City"],
  ["postal_code", "ΤΚ", "Postal code"],
];
const DATA_FIELDS = ["mobile", "phone", "email", "address", "city", "postal_code"];
const STORE_KEY = "rxv.contactImportMap";

const colName = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
const signature = (header: string[]) => header.map((h) => h.trim().toLowerCase()).join("|");

function loadSaved(sig: string): Record<string, number> | null {
  try { const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); return all[sig] || null; } catch { return null; }
}
function saveMap(sig: string, m: Record<string, number>) {
  try { const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); all[sig] = m; localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* προαιρετικό */ }
}

export function ImportInsuredModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [colField, setColField] = useState<Record<number, string>>({});   // στήλη → πεδίο
  const [hasHeader, setHasHeader] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [check, setCheck] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState(false);

  const reset = () => { setFile(null); setPv(null); setColField({}); setCheck(null); setDone(null); setError(null); setOverwrite(false); setRemembered(false); };
  const close = () => { reset(); onClose(); };
  const errText = (e: unknown, fb: string) => {
    const p = (e as { problem?: { detail?: unknown } })?.problem?.detail;
    return typeof p === "string" ? p : fb;
  };

  async function downloadTemplate() {
    try {
      const url = URL.createObjectURL(await apiBlob("/patients/import/template"));
      const a = document.createElement("a");
      a.href = url; a.download = "rxvision_pelates_template.xlsx"; a.click();
      URL.revokeObjectURL(url);
    } catch { setError(t("Αποτυχία λήψης προτύπου.", "Failed to download template.")); }
  }

  async function choose(f: File | null) {
    reset();
    if (!f) return;
    setFile(f); setBusy(true);
    try {
      const form = new FormData(); form.append("file", f);
      const p = await apiUpload<Preview>("/patients/import/preview", form);
      setPv(p); setHasHeader(p.has_header);
      const saved = p.rows[0] ? loadSaved(signature(p.rows[0])) : null;
      const m = saved || p.suggested || {};
      setRemembered(!!saved);
      const cf: Record<number, string> = {};
      Object.entries(m).forEach(([field, col]) => { cf[col] = field; });
      setColField(cf);
    } catch (e) { setError(errText(e, t("Το αρχείο δεν διαβάζεται.", "The file cannot be read."))); }
    finally { setBusy(false); }
  }

  const mapping = (): Record<string, number> => {
    const m: Record<string, number> = {};
    Object.entries(colField).forEach(([col, field]) => { if (field && m[field] === undefined) m[field] = Number(col); });
    return m;
  };
  const m = mapping();
  const canMatch = m.amka !== undefined || m.full_name !== undefined || (m.last_name !== undefined && m.first_name !== undefined);
  const hasData = DATA_FIELDS.some((f) => m[f] !== undefined);

  async function run(dry: boolean) {
    if (!file || !pv) return;
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mapping", JSON.stringify(m));
      form.append("start_row", hasHeader ? "2" : "1");
      form.append("overwrite", String(overwrite));
      form.append("dry_run", String(dry));
      const r = await apiUpload<Result>("/patients/import", form);
      if (dry) setCheck(r);
      else {
        setDone(r);
        if (hasHeader && pv.rows[0]) saveMap(signature(pv.rows[0]), m);
        qc.invalidateQueries({ queryKey: ["needs-confirmation"] });
        qc.invalidateQueries({ queryKey: ["contacts-missing"] });
      }
    } catch (e) { setError(errText(e, t("Αποτυχία εισαγωγής.", "Import failed."))); }
    finally { setBusy(false); }
  }

  const setCol = (col: number, field: string) => {
    setCheck(null);
    setColField((prev) => {
      const next: Record<number, string> = {};
      Object.entries(prev).forEach(([c, f]) => { if (f !== field || !field) next[Number(c)] = f; });  // ένα πεδίο = μία στήλη
      if (field) next[col] = field; else delete next[col];
      return next;
    });
  };

  const label = (f: string) => { const x = FIELD_LABELS.find((l) => l[0] === f); return x ? t(x[1], x[2]) : f; };
  const sum = (r: Result, k: keyof FieldStat) => DATA_FIELDS.reduce((s, f) => s + (r.fields[f]?.[k] || 0), 0);
  const res = done || check;
  const btn = "inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 font-semibold disabled:opacity-50";

  return (
    <Modal open={open} onClose={close} size="3xl" title={t("Εισαγωγή στοιχείων επικοινωνίας από το εμπορικό πρόγραμμα", "Import contact details from your pharmacy software")}>
      <div className="space-y-4 text-sm">
        {!pv && (
          <>
            <p className="text-slate-600 dark:text-slate-300">
              {t("Βγάλε τη λίστα πελατών από το εμπορικό σου πρόγραμμα σε Excel (.xlsx) ή .csv και ανέβασέ την. Στο επόμενο βήμα θα πεις ποια στήλη είναι τι — δεν χρειάζεται συγκεκριμένη μορφή.",
                 "Export your customer list from your pharmacy software as Excel (.xlsx) or .csv and upload it. Next you will say which column is what — no fixed layout needed.")}
            </p>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-5 hover:border-brand-400 dark:border-slate-600">
              {busy ? <Loader2 className="h-5 w-5 animate-spin text-brand-600" /> : <FileSpreadsheet className="h-5 w-5 shrink-0 text-emerald-600" />}
              <span className="flex-1 truncate text-slate-600 dark:text-slate-300">{file ? file.name : t("Επίλεξε αρχείο .xlsx ή .csv…", "Choose an .xlsx or .csv file…")}</span>
              <input type="file" accept=".xlsx,.xlsm,.csv" className="hidden" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button onClick={downloadTemplate} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-brand-700">
              <Download className="h-3.5 w-3.5" /> {t("ή κατέβασε έτοιμο πρότυπο", "or download a ready template")}
            </button>
          </>
        )}

        {pv && !done && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-slate-600 dark:text-slate-300">
                <b>{file?.name}</b> · {pv.total_rows.toLocaleString("el-GR")} {t("γραμμές", "rows")}
                {remembered && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">{t("Αντιστοίχιση από την προηγούμενη φορά", "Mapping from last time")}</span>}
              </div>
              <button onClick={reset} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"><ArrowLeft className="h-3.5 w-3.5" /> {t("Άλλο αρχείο", "Another file")}</button>
            </div>

            <p className="text-xs text-slate-500">{t("Διάλεξε πάνω από κάθε στήλη τι περιέχει. Όσες στήλες δεν χρειάζονται, άφησέ τες «—».", "Pick what each column contains. Leave unneeded columns as «—».")}</p>
            <div className="max-h-[42vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-slate-400">#</th>
                    {Array.from({ length: pv.columns }, (_, c) => (
                      <th key={c} className="min-w-[130px] px-2 py-1.5 text-left">
                        <div className="mb-1 text-[10px] font-semibold text-slate-400">{t("Στήλη", "Column")} {colName(c)}</div>
                        <select value={colField[c] || ""} onChange={(e) => setCol(c, e.target.value)}
                          className={`w-full rounded-md border px-1.5 py-1 text-xs font-semibold ${colField[c] ? "border-brand-400 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200" : "border-slate-300 bg-white text-slate-500 dark:border-slate-600 dark:bg-slate-900"}`}>
                          <option value="">—</option>
                          {FIELD_LABELS.map(([f, el, en]) => <option key={f} value={f}>{t(el, en)}</option>)}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pv.rows.map((r, i) => (
                    <tr key={i} className={i === 0 && hasHeader ? "bg-amber-50/60 font-semibold text-slate-500 dark:bg-amber-950/20" : "border-t border-slate-100 dark:border-slate-800"}>
                      <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                      {r.map((c, j) => <td key={j} className={`max-w-[220px] truncate px-2 py-1 ${colField[j] ? "text-slate-800 dark:text-slate-100" : "text-slate-400"}`}>{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={hasHeader} onChange={(e) => { setHasHeader(e.target.checked); setCheck(null); }} /> {t("Η 1η γραμμή είναι επικεφαλίδες (δεν εισάγεται)", "Row 1 is headers (not imported)")}</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setCheck(null); }} /> {t("Αντικατάσταση στοιχείων που ήρθαν από ΗΔΥΚΑ ή προηγούμενη εισαγωγή, όταν διαφέρουν", "Replace ΗΔΥΚΑ / previously imported details when different")}</label>
            </div>

            <div className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>{t("Ταίριασμα με ΑΜΚΑ· όπου λείπει, με ονοματεπώνυμο μόνο αν είναι μοναδικό στο φαρμακείο. Στοιχεία που επιβεβαίωσες εσύ ή ο πελάτης δεν αλλάζουν ποτέ. Η εισαγωγή δεν δίνει συγκατάθεση μάρκετινγκ και δεν αλλάζει ονόματα. Κινητό/σταθερό αναγνωρίζονται από τον αριθμό (69… / 2…).",
                        "Matched by ΑΜΚΑ; where missing, by full name only if unique in the pharmacy. Details you or the patient confirmed never change. Import grants no marketing consent and changes no names. Mobile/landline are detected from the number (69… / 2…).")}</span>
            </div>
            {!canMatch && <div className="text-xs font-semibold text-amber-700">{t("Δήλωσε στήλη ΑΜΚΑ ή ονοματεπώνυμο για να βρεθούν οι πελάτες.", "Map an ΑΜΚΑ or name column so patients can be found.")}</div>}
            {canMatch && !hasData && <div className="text-xs font-semibold text-amber-700">{t("Δήλωσε τουλάχιστον μία στήλη στοιχείων (κινητό, σταθερό, email…).", "Map at least one detail column (mobile, landline, email…).")}</div>}
          </>
        )}

        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">{error}</div>}

        {res && (
          <div className={`space-y-2 rounded-xl border p-3 ${done ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30" : "border-brand-200 bg-brand-50/60 dark:border-brand-800 dark:bg-brand-950/30"}`}>
            <div className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
              {done ? <><CheckCircle2 className="h-4 w-4 text-emerald-600" /> {t("Ολοκληρώθηκε", "Done")}</> : t("Έλεγχος — τίποτα δεν έχει αποθηκευτεί ακόμα", "Check — nothing saved yet")}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                [t("Βρέθηκαν", "Matched"), res.matched, `${t("ΑΜΚΑ", "ΑΜΚΑ")} ${res.by_amka} · ${t("όνομα", "name")} ${res.by_name}`],
                [done ? t("Ενημερώθηκαν", "Updated") : t("Θα ενημερωθούν", "Will update"), res.patients_updated, `${t("νέα στοιχεία", "new values")} ${sum(res, "filled") + sum(res, "overwritten")}`],
                [t("Δεν βρέθηκαν", "Not found"), res.not_found + res.no_key, t("χωρίς πελάτη με συνταγή", "no matching patient")],
                [t("Αμφίσημα ονόματα", "Ambiguous names"), res.ambiguous, t("συνωνυμίες — χωρίς ΑΜΚΑ", "same name — no ΑΜΚΑ")],
              ].map(([l, v, s]) => (
                <div key={String(l)} className="rounded-lg bg-white/80 px-3 py-2 dark:bg-slate-900/60">
                  <div className="text-[11px] text-slate-500">{l}</div>
                  <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{Number(v).toLocaleString("el-GR")}</div>
                  <div className="text-[10px] text-slate-400">{s}</div>
                </div>
              ))}
            </div>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1">{t("Πεδίο", "Field")}</th><th>{t("Συμπληρώνεται", "Filled")}</th><th>{t("Αντικαθίσταται", "Replaced")}</th>
                <th>{t("Ίδιο ήδη", "Already same")}</th><th>{t("Διαφέρει — κρατήθηκε", "Differs — kept")}</th><th>{t("Επιβεβαιωμένο — προστατεύεται", "Confirmed — protected")}</th><th>{t("Άκυρο", "Invalid")}</th>
              </tr></thead>
              <tbody>
                {DATA_FIELDS.filter((f) => m[f] !== undefined || (f === "mobile" && m.phone !== undefined) || (f === "phone" && m.mobile !== undefined)).map((f) => {
                  const s = res.fields[f];
                  return (
                    <tr key={f} className="border-t border-slate-200/70 dark:border-slate-700">
                      <td className="py-1 font-semibold">{label(f)}</td><td className="text-emerald-700">{s.filled}</td><td>{s.overwritten}</td>
                      <td className="text-slate-400">{s.same}</td><td>{s.kept}</td><td>{s.protected}</td><td className={s.invalid ? "text-rose-600" : "text-slate-400"}>{s.invalid}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(res.deceased > 0 || res.duplicate > 0) && (
              <div className="text-[11px] text-slate-500">
                {res.deceased > 0 && <>{t("Θανόντες (παραλείπονται)", "Deceased (skipped)")}: {res.deceased} · </>}
                {res.duplicate > 0 && <>{t("Διπλές γραμμές ίδιου πελάτη (ενώθηκαν)", "Duplicate rows of same patient (merged)")}: {res.duplicate}</>}
              </div>
            )}
            {res.samples.conflicts.length > 0 && (
              <details className="text-xs"><summary className="cursor-pointer font-semibold text-slate-600">{t("Διαφορές με ό,τι υπάρχει", "Differences from existing")} ({res.samples.conflicts.length}{res.samples.conflicts.length >= 50 ? "+" : ""})</summary>
                <ul className="mt-1 space-y-0.5">{res.samples.conflicts.map((c, i) => (
                  <li key={i}>{t("Γραμμή", "Row")} {c.row} · {c.name} · {label(c.field || "")}: <span className="text-slate-500">{c.current}</span> → <b>{c.file}</b> <span className="text-slate-400">({c.outcome === "protected" ? t("προστατεύεται", "protected") : c.outcome === "overwritten" ? t("αντικαθίσταται", "replaced") : t("κρατήθηκε το υπάρχον", "kept existing")})</span></li>
                ))}</ul>
              </details>
            )}
            {(res.samples.not_found.length > 0 || res.samples.ambiguous.length > 0) && (
              <details className="text-xs"><summary className="cursor-pointer font-semibold text-slate-600">{t("Γραμμές που δεν ταίριαξαν", "Unmatched rows")}</summary>
                <ul className="mt-1 space-y-0.5">
                  {res.samples.ambiguous.map((c, i) => <li key={`a${i}`}>{t("Γραμμή", "Row")} {c.row} · {c.name} — {c.count} {t("πελάτες με αυτό το όνομα· πρόσθεσε ΑΜΚΑ", "patients share this name; add ΑΜΚΑ")}</li>)}
                  {res.samples.not_found.map((c, i) => <li key={`n${i}`}>{t("Γραμμή", "Row")} {c.row} · {c.name || c.amka || "—"} — {t("δεν υπάρχει στους πελάτες σου", "not among your patients")}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">{t("Κλείσιμο", "Close")}</button>
          {pv && !done && !check && (
            <button onClick={() => run(true)} disabled={!canMatch || !hasData || busy} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {t("Έλεγχος", "Check")}
            </button>
          )}
          {check && !done && (
            <button onClick={() => run(false)} disabled={busy || check.patients_updated === 0} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {t("Εφαρμογή σε", "Apply to")} {check.patients_updated.toLocaleString("el-GR")} {t("πελάτες", "patients")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
