// Year-over-year comparison helpers for KPIs: same WEEKDAY one year earlier (52 weeks = 364 days),
// NOT the same calendar date. A Friday must compare to a Friday — weekday dynamics (e.g. a recurring
// Friday local event, or weekday-vs-weekend traffic) otherwise distort YoY deltas and mislead
// decisions. Mirrors the backend `_yago` (patient_intelligence.py) so all KPIs agree.

/** The same date range shifted back exactly 52 weeks (364 days) → same weekday, "πέρσι". */
export function prevYearRange(from?: string | null, to?: string | null): { from: string; to: string } | null {
  if (!from || !to) return null;
  const sub = (s: string) => {
    const d = new Date(s);
    d.setDate(d.getDate() - 364); // 52 weeks → preserves day-of-week
    return d.toISOString().slice(0, 10);
  };
  return { from: sub(from), to: sub(to) };
}

/** Percent change current vs previous-year value (undefined if no comparable base). */
export const pctDelta = (cur?: number, prev?: number): number | undefined =>
  prev && prev > 0 && cur !== undefined ? ((cur - prev) / prev) * 100 : undefined;
