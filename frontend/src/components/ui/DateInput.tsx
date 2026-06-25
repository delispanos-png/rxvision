"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import { useT } from "@/store/prefStore";

/**
 * Date field in DD/MM/YYYY. The user can either TYPE the date (ΗΗ/ΜΜ/ΕΕΕΕ) OR click the
 * calendar icon to pick it. value/onChange use the canonical YYYY-MM-DD string.
 */
function toDisplay(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : "";
}
function mask(s: string): string {
  const d = (s || "").replace(/\D/g, "").slice(0, 8);   // μόνο ψηφία, έως 8 (ΗΗΜΜΕΕΕΕ)
  let out = d.slice(0, 2);
  if (d.length > 2) out += "/" + d.slice(2, 4);
  if (d.length > 4) out += "/" + d.slice(4, 8);
  return out;
}
function parse(s: string): string | null {
  const m = (s || "").trim().match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/);
  if (!m) return null;
  const dd = +m[1], mm = +m[2], yy = +m[3];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yy < 1900 || yy > 2200) return null;
  const iso = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const d = new Date(iso);
  return d.getMonth() + 1 === mm && d.getDate() === dd ? iso : null;   // reject 31/02 κ.λπ.
}

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
  const t = useT();
  const [text, setText] = useState(toDisplay(value));
  const nativeRef = useRef<HTMLInputElement>(null);
  useEffect(() => setText(toDisplay(value)), [value]);

  return (
    <div className={`relative inline-flex items-center rounded-lg border border-slate-300 bg-white focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 ${className}`}>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        placeholder={t("ΗΗ/ΜΜ/ΕΕΕΕ", "DD/MM/YYYY")}
        onChange={(e) => {
          const masked = mask(e.target.value);   // βάζει τα «/» μόνα τους καθώς πληκτρολογείς
          setText(masked);
          const iso = parse(masked);
          if (iso) onChange(iso);
        }}
        onBlur={(e) => {
          const iso = parse(e.target.value);
          if (iso) onChange(iso);
          else setText(toDisplay(value));   // επανέφερε αν είναι μισοτελειωμένο/άκυρο
        }}
        className="w-[7.5rem] bg-transparent px-3 py-2 text-sm text-slate-900 outline-none disabled:cursor-not-allowed dark:text-slate-200"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => nativeRef.current?.showPicker?.()}
        aria-label={t("Επιλογή από ημερολόγιο", "Pick from calendar")}
        className="px-2 text-slate-400 hover:text-brand-600 disabled:cursor-not-allowed"
      >
        <Calendar className="h-4 w-4" />
      </button>
      {/* κρυφό native input — ανοίγει με το κουμπί ημερολογίου */}
      <input
        ref={nativeRef}
        type="date"
        value={value}
        disabled={disabled}
        tabIndex={-1}
        onChange={(e) => onChange(e.target.value)}
        className="pointer-events-none absolute right-2 bottom-0 h-0 w-0 opacity-0"
      />
    </div>
  );
}
