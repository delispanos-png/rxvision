"use client";

/* RxVision Κύπρος — Εισαγωγή XML εκτελέσεων από την πύλη ΓεΣΥ.
   Ένα ή πολλά XML, ή ZIP. Το ίδιο αρχείο δύο φορές μετράει μία. Αρχείο άλλου φαρμακείου
   απορρίπτεται (ο κωδικός παρόχου «δένεται» με το πρώτο αρχείο). */

import { useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileUp, Loader2, TriangleAlert } from "lucide-react";
import { ApiError, apiUpload } from "@/lib/apiClient";
import { fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Result = { files: number; imported: number; duplicates: number; failed: number;
  errors: { file: string; error: string }[]; provider_id: string | null };

export default function CyImportPage() {
  const t = useT();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    const form = new FormData();
    Array.from(list).forEach((f) => form.append("files", f));
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await apiUpload<Result>("/cy/import", form);
      setRes(r);
      qc.invalidateQueries({ queryKey: ["cy"] });
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: string })?.detail : "";
      setErr(d === "too_large" ? t("Πολύ μεγάλο ανέβασμα — χώρισέ το σε μικρότερα.", "Upload too large — split it.")
        : d || t("Η εισαγωγή απέτυχε — δοκίμασε ξανά.", "Import failed — try again."));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Εισαγωγή XML εκτελέσεων ΓεΣΥ", "Import GHS dispensing XML")}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("Κατέβασε από την πύλη ΓεΣΥ τα XML των εκτελέσεών σου και ανέβασέ τα εδώ — ένα-ένα, πολλά μαζί ή σε ZIP. Αν ανεβάσεις κάτι δεύτερη φορά, δεν θα μετρηθεί διπλό.",
             "Download your dispensing XML files from the GHS portal and upload them here — one, many, or as a ZIP. Uploading the same file twice never double-counts.")}
        </p>
      </header>

      <button type="button" disabled={busy} onClick={() => input.current?.click()}
        className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-6 py-10 text-slate-600 hover:border-indigo-400 hover:text-indigo-700 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900">
        {busy ? <Loader2 className="h-8 w-8 animate-spin" /> : <FileUp className="h-8 w-8" />}
        <span className="font-medium">{busy ? t("Εισαγωγή…", "Importing…") : t("Επίλεξε αρχεία XML ή ZIP", "Choose XML or ZIP files")}</span>
      </button>
      <input ref={input} type="file" multiple accept=".xml,.zip,application/xml,text/xml,application/zip" className="hidden"
        onChange={(e) => upload(e.target.files)} />

      {err && <div className="flex items-start gap-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-700"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />{err}</div>}

      {res && (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 font-semibold text-emerald-700"><CheckCircle2 className="h-5 w-5" />{t("Η εισαγωγή ολοκληρώθηκε", "Import finished")}</div>
          <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <li><b>{fmtNum(res.files)}</b> {t("αρχεία", "files")}</li>
            <li className="text-emerald-700"><b>{fmtNum(res.imported)}</b> {t("νέες εκτελέσεις", "new dispensings")}</li>
            <li className="text-slate-500"><b>{fmtNum(res.duplicates)}</b> {t("υπήρχαν ήδη", "already there")}</li>
            <li className={res.failed ? "text-rose-700" : "text-slate-500"}><b>{fmtNum(res.failed)}</b> {t("απορρίφθηκαν", "rejected")}</li>
          </ul>
          {res.errors.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              <div className="mb-1 font-semibold">{t("Αρχεία που δεν μπήκαν", "Files not imported")}</div>
              <ul className="space-y-0.5">{res.errors.map((e, i) => <li key={i}><b>{e.file}</b>: {e.error}</li>)}</ul>
            </div>
          )}
          {res.provider_id && <p className="text-xs text-slate-400">{t("Κωδικός φαρμακείου ΓεΣΥ", "GHS pharmacy code")}: {res.provider_id}</p>}
          <Link href="/cy" className="inline-block text-sm font-medium text-indigo-600 hover:underline">{t("Δες το Dashboard →", "See the Dashboard →")}</Link>
        </div>
      )}
    </div>
  );
}
