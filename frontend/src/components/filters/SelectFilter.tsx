"use client";

import { useT } from "@/store/prefStore";

export type SelectOption = { value: string; label: string };

/** Generic labeled select. Empty value selects the `all` placeholder option. */
export function SelectFilter({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: string | null;
  options: SelectOption[];
  onChange: (value: string | null) => void;
  allLabel?: string;
}) {
  const t = useT();
  const allText = allLabel ?? t("Όλα", "All");
  return (
    <label className="text-sm">
      <span className="mb-1 block text-slate-500">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-brand-600 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 sm:w-auto sm:min-w-44"
      >
        <option value="">{allText}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
