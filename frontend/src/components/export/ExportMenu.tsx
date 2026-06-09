"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Loader2, FileText, FileSpreadsheet, FileType } from "lucide-react";
import { downloadCsv } from "@/lib/csv";
import { downloadXlsx, downloadPdf, type ExportCol } from "@/lib/export";

/** Real client-side export menu: CSV, XLSX (Excel) and a colour-branded PDF.
 *  Pass already-loaded `rows`, or `fetchRows` to pull the full dataset on demand. */
export function ExportMenu<T>({
  filename,
  title,
  columns,
  rows,
  fetchRows,
  label = "Εξαγωγή",
}: {
  filename: string;
  title: string;
  columns: ExportCol<T>[];
  rows?: T[];
  fetchRows?: () => Promise<T[]>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function run(fmt: "csv" | "xlsx" | "pdf") {
    setBusy(fmt);
    try {
      const data = fetchRows ? await fetchRows() : (rows ?? []);
      if (!data.length) { alert("Δεν υπάρχουν δεδομένα για εξαγωγή."); return; }
      if (fmt === "csv") downloadCsv(filename, columns, data);
      else if (fmt === "xlsx") await downloadXlsx(filename, columns, data);
      else await downloadPdf(filename, title, columns, data);
    } catch (e) {
      alert("Η εξαγωγή απέτυχε: " + (e instanceof Error ? e.message : "άγνωστο σφάλμα"));
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  const opts: { fmt: "csv" | "xlsx" | "pdf"; label: string; icon: typeof FileText }[] = [
    { fmt: "xlsx", label: "Excel (.xlsx)", icon: FileSpreadsheet },
    { fmt: "pdf", label: "PDF (έγχρωμο)", icon: FileType },
    { fmt: "csv", label: "CSV", icon: FileText },
  ];

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!!busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {busy ? "Εξαγωγή…" : label} ▾
      </button>
      {open && !busy && (
        <div className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl">
          {opts.map((o) => (
            <button
              key={o.fmt}
              onClick={() => run(o.fmt)}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <o.icon className="h-4 w-4 text-slate-400" /> {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
