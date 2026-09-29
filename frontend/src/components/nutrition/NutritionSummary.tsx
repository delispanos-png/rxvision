"use client";

import { useT } from "@/store/prefStore";
import type { NutritionSummary as Summary } from "@/lib/nutrition";

/** «Η πρόταση με μια ματιά»: ΕΝΑ «προτίμησε / απόφυγε» από την ενεργή αγωγή ΚΑΙ τις μετρήσεις,
 *  με ρητή σημείωση όπου οι δύο πηγές συγκρούονται. Κοινό για φαρμακοποιό και πύλη πελάτη. */
export function NutritionSummary({ summary }: { summary?: Summary | null }) {
  const t = useT();
  if (!summary || (!summary.favor?.length && !summary.avoid?.length)) return null;
  const src = summary.sources ?? { measurements: 0, therapies: 0 };
  return (
    <div className="mb-3 rounded-2xl border-2 border-emerald-300 bg-emerald-50/60 p-4 shadow-sm dark:border-emerald-800 dark:bg-emerald-950/20">
      <div className="text-base font-bold text-emerald-800 dark:text-emerald-300">{t("Η πρόταση με μια ματιά", "The plan at a glance")}</div>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {t(`Από ${src.therapies} ενότητες της τρέχουσας αγωγής και ${src.measurements} από τις μετρήσεις.`,
           `From ${src.therapies} current-therapy items and ${src.measurements} from measurements.`)}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">{t("🥗 Προτίμησε", "🥗 Prefer")}</span>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-slate-700 dark:text-slate-200">{summary.favor.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div>
          <span className="inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">{t("⛔ Απόφυγε", "⛔ Avoid")}</span>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-slate-700 dark:text-slate-200">{summary.avoid.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
      {summary.conflicts?.map((c) => (
        <p key={c} className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"><span className="shrink-0">⚠️</span>{c}</p>
      ))}
    </div>
  );
}
