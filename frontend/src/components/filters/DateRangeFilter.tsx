"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useUiStore } from "@/store/uiStore";
import { DateInput } from "@/components/ui/DateInput";
import { useT } from "@/store/prefStore";

/** From/to date inputs bound to the global Zustand filter store + a reload button that
 *  refetches the data WITHOUT touching the selected range. */
export function DateRangeFilter() {
  const { dateFrom, dateTo, setDateRange } = useUiStore();
  const t = useT();
  const qc = useQueryClient();
  const [spinning, setSpinning] = useState(false);

  function reload() {
    setSpinning(true);
    // refetch everything· το διάστημα μένει ως έχει (είναι στο store, δεν το πειράζουμε)
    qc.invalidateQueries().finally(() => setTimeout(() => setSpinning(false), 600));
  }

  // γρήγορα φίλτρα
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const y = today.getFullYear();
  const presets: { label: string; from: string; to: string }[] = [
    { label: t("Τρέχων μήνας", "This month"), from: iso(new Date(y, today.getMonth(), 1)), to: iso(today) },
    { label: t("Τρέχον έτος", "This year"), from: `${y}-01-01`, to: iso(today) },
    { label: t("Προηγ. έτος", "Last year"), from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-wrap gap-1.5 self-center">
        {presets.map((p) => {
          const active = dateFrom === p.from && dateTo === p.to;
          return (
            <button key={p.label} type="button" onClick={() => setDateRange(p.from, p.to)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${active ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
              {p.label}
            </button>
          );
        })}
      </div>
      <label className="text-sm">
        <span className="mb-1 block text-slate-500">{t("Από", "From")}</span>
        <DateInput value={dateFrom} onChange={(v) => setDateRange(v, dateTo)} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-slate-500">{t("Έως", "To")}</span>
        <DateInput value={dateTo} onChange={(v) => setDateRange(dateFrom, v)} />
      </label>
      <button
        type="button"
        onClick={reload}
        title={t("Ανανέωση δεδομένων (κρατάει το διάστημα)", "Reload data (keeps the range)")}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
      >
        <RefreshCw className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`} /> {t("Ανανέωση", "Reload")}
      </button>
    </div>
  );
}
