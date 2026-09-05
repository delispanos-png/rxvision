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

  // ΣΥΜΒΑΣΗ: το date_to είναι ΑΠΟΚΛΕΙΣΤΙΚΟ πάνω όριο στο backend (executed_at < date_to). Ο χρήστης
  // όμως σκέφτεται το «Έως» ΠΕΡΙΛΗΠΤΙΚΑ (η τελευταία μέρα που θέλει να δει). Άρα: εμφανίζουμε το «Έως»
  // ως (dateTo − 1 μέρα) και αποθηκεύουμε (επιλογή + 1 μέρα). Έτσι «05/09 → 05/09» = [05/09, 06/09) →
  // περιλαμβάνει ΟΛΗ τη μέρα 05/09 (πριν έβγαινε κενό). Ίδια λογική στα presets (αλλιώς «κόβαν» το σήμερα).
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (isoStr: string, n: number) => {
    const [Y, M, D] = isoStr.split("-").map(Number);
    return iso(new Date(Y, M - 1, D + n));
  };
  const y = today.getFullYear();
  const tomorrow = iso(new Date(y, today.getMonth(), today.getDate() + 1));   // exclusive upper → περιλαμβάνει σήμερα
  const presets: { label: string; from: string; to: string }[] = [
    { label: t("Τρέχων μήνας", "This month"), from: iso(new Date(y, today.getMonth(), 1)), to: tomorrow },
    { label: t("Τρέχον έτος", "This year"), from: `${y}-01-01`, to: tomorrow },
    { label: t("Προηγ. έτος", "Last year"), from: `${y - 1}-01-01`, to: `${y}-01-01` },   // περιλαμβάνει 31/12
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
        {/* εμφανίζει την ΠΕΡΙΛΗΠΤΙΚΗ τελευταία μέρα· αποθηκεύει +1 (αποκλειστικό όριο για το backend) */}
        <DateInput value={addDays(dateTo, -1)} onChange={(v) => setDateRange(dateFrom, addDays(v, 1))} />
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
