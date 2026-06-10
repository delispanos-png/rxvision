// Year-over-year comparison helpers for KPIs: same calendar period, one year earlier.

/** The same date range shifted back exactly one year (πέρσι, ίδια περίοδος). */
export function prevYearRange(from?: string | null, to?: string | null): { from: string; to: string } | null {
  if (!from || !to) return null;
  const sub = (s: string) => {
    const d = new Date(s);
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  };
  return { from: sub(from), to: sub(to) };
}

/** Percent change current vs previous-year value (undefined if no comparable base). */
export const pctDelta = (cur?: number, prev?: number): number | undefined =>
  prev && prev > 0 && cur !== undefined ? ((cur - prev) / prev) * 100 : undefined;
