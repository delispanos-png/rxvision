"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export type MsOption = { value: string; label: string };
export type MsGroup = { title?: string; options: MsOption[] };

/** Dropdown πολλαπλής επιλογής (checkbox list, ομαδοποιημένο). Επαναχρησιμοποιήσιμο σε φίλτρα. */
export function MultiSelect({
  label, groups, selected, onChange, allLabel = "Όλα", selectedLabel = (n) => `${n} επιλεγμένα`,
  clearLabel = "Καθαρισμός",
}: {
  label: string;
  groups: MsGroup[];
  selected: string[];
  onChange: (v: string[]) => void;
  allLabel?: string;
  selectedLabel?: (n: number) => string;
  clearLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div ref={ref} className="relative text-sm">
      <span className="mb-1 block text-slate-500">{label}</span>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex min-w-[11rem] items-center justify-between gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
        <span className={selected.length ? "font-medium text-brand-700" : "text-slate-500"}>
          {selected.length ? selectedLabel(selected.length) : allLabel}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900">
          {groups.map((g, gi) => (
            <div key={gi} className="mb-1.5">
              {g.title ? <div className="px-1 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g.title}</div> : null}
              {g.options.map((o) => (
                <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-400" />
                  <span className="text-slate-700 dark:text-slate-200">{o.label}</span>
                </label>
              ))}
            </div>
          ))}
          {selected.length > 0 && (
            <button onClick={() => onChange([])} className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700">{clearLabel}</button>
          )}
        </div>
      )}
    </div>
  );
}
