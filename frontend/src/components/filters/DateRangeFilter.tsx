"use client";

import { useUiStore } from "@/store/uiStore";

/** From/to date inputs bound to the global Zustand filter store. */
export function DateRangeFilter() {
  const { dateFrom, dateTo, setDateRange } = useUiStore();

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="mb-1 block text-slate-500">Από</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateRange(e.target.value, dateTo)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-brand-600 focus:outline-none"
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-slate-500">Έως</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateRange(dateFrom, e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-brand-600 focus:outline-none"
        />
      </label>
    </div>
  );
}
