/** API money values are integer cents → divide by 100 for display. */
export const fmtEur = (cents: number) =>
  new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((cents ?? 0) / 100);

export const fmtNum = (n: number) => new Intl.NumberFormat("el-GR").format(n ?? 0);

/** Money (integer cents → €) the Greek way: 160.145,02 (no currency symbol — for "(€)" columns). */
export const fmtMoney = (cents: number) =>
  new Intl.NumberFormat("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents ?? 0) / 100);

/** Decimal number the Greek way (comma decimal): fmtDec(12.3) → "12,3". */
export const fmtDec = (n: number, digits = 1) =>
  new Intl.NumberFormat("el-GR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n ?? 0);

export const fmtPct = (n: number) =>
  new Intl.NumberFormat("el-GR", { style: "percent", maximumFractionDigits: 1 }).format((n ?? 0) / 100);

export const fmtDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("el-GR").format(d);
};
