"use client";

import { useUiStore } from "@/store/uiStore";
import { DateInput } from "@/components/ui/DateInput";

/** From/to date inputs bound to the global Zustand filter store. */
export function DateRangeFilter() {
  const { dateFrom, dateTo, setDateRange } = useUiStore();

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="mb-1 block text-slate-500">Από</span>
        <DateInput value={dateFrom} onChange={(v) => setDateRange(v, dateTo)} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-slate-500">Έως</span>
        <DateInput value={dateTo} onChange={(v) => setDateRange(dateFrom, v)} />
      </label>
    </div>
  );
}
