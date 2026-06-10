"use client";

import { Calendar } from "lucide-react";

/**
 * Date field that ALWAYS displays DD/MM/YYYY regardless of browser locale.
 * A native <input type="date"> sits on top, transparent, so the calendar picker
 * still works; a styled overlay shows the value formatted as DD/MM/YYYY.
 * value/onChange use the canonical YYYY-MM-DD string.
 */
export function DateInput({
  value,
  onChange,
  className = "",
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const display = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
    : "ΗΗ/ΜΜ/ΕΕΕΕ";

  return (
    <div className={`relative ${className}`}>
      <input
        type="date"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <div className="pointer-events-none flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm peer-focus:border-brand-500 peer-focus:ring-1 peer-focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
        <span className={value ? "text-slate-900" : "text-slate-400"}>{display}</span>
        <Calendar className="h-4 w-4 text-slate-400" />
      </div>
    </div>
  );
}
