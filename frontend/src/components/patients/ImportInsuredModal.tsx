"use client";

import { useState } from "react";
import { Upload, Download, FileSpreadsheet, CheckCircle2 } from "lucide-react";
import { apiUpload, apiBlob } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Modal } from "@/components/ui/Modal";

type Result = { updated: number; skipped: number; total: number; skipped_sample: string[] };

export function ImportInsuredModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function downloadTemplate() {
    setError(null);
    try {
      const blob = await apiBlob("/patients/import/template");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rxvision_asfalismenoi_template.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t("Αποτυχία λήψης προτύπου.", "Failed to download template."));
    }
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      setResult(await apiUpload<Result>("/patients/import", form));
    } catch (e: unknown) {
      const detail = (e as { problem?: { detail?: string } })?.problem?.detail;
      setError(detail || t("Αποτυχία εισαγωγής. Έλεγξε το αρχείο/πρότυπο.", "Import failed. Check the file/template."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" title={t("Εισαγωγή ασφαλισμένων από Excel", "Import patients from Excel")}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-500">
          {t("Ανέβασε αρχείο Excel (.xlsx) με στήλη ΑΜΚΑ. Τα στοιχεία ενημερώνουν τους υπάρχοντες ασθενείς (ταίριασμα με ΑΜΚΑ). Όσοι ΑΜΚΑ δεν υπάρχουν στο σύστημα, παραλείπονται.",
             "Upload an .xlsx with an ΑΜΚΑ column. Details update existing patients matched by ΑΜΚΑ; unmatched ΑΜΚΑ are skipped.")}
        </p>

        <button onClick={downloadTemplate} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">
          <Download className="h-4 w-4" /> {t("Κατέβασε πρότυπο Excel", "Download Excel template")}
        </button>

        <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-4 hover:border-brand-400 dark:border-slate-600">
          <FileSpreadsheet className="h-5 w-5 shrink-0 text-emerald-600" />
          <span className="flex-1 truncate text-slate-600 dark:text-slate-300">{file ? file.name : t("Επίλεξε αρχείο .xlsx…", "Choose .xlsx file…")}</span>
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(null); }} />
        </label>

        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">{error}</div>}

        {result && (
          <div className="space-y-1 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">
            <div className="flex items-center gap-1.5 font-semibold"><CheckCircle2 className="h-4 w-4" /> {t("Ολοκληρώθηκε", "Done")}</div>
            <div>
              {t("Ενημερώθηκαν", "Updated")}: <b>{result.updated}</b> · {t("Παραλείφθηκαν", "Skipped")}: <b>{result.skipped}</b> · {t("Σύνολο γραμμών", "Total rows")}: {result.total}
            </div>
            {result.skipped > 0 && result.skipped_sample?.length ? (
              <div className="text-xs text-emerald-700">
                {t("Δείγμα ΑΜΚΑ χωρίς αντιστοίχιση (χωρίς συνταγή στο σύστημα): ", "Sample unmatched ΑΜΚΑ: ")}
                {result.skipped_sample.join(", ")}{result.skipped > result.skipped_sample.length ? " …" : ""}
              </div>
            ) : null}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">{t("Κλείσιμο", "Close")}</button>
          <button onClick={upload} disabled={!file || busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-1.5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            <Upload className="h-4 w-4" /> {busy ? t("Εισαγωγή…", "Importing…") : t("Εισαγωγή", "Import")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
