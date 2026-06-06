/** API money values are integer cents → divide by 100 for display. */
export const fmtEur = (cents: number) =>
  new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((cents ?? 0) / 100);

export const fmtNum = (n: number) => new Intl.NumberFormat("el-GR").format(n ?? 0);

export const fmtPct = (n: number) =>
  new Intl.NumberFormat("el-GR", { style: "percent", maximumFractionDigits: 1 }).format((n ?? 0) / 100);

export const fmtDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("el-GR").format(d);
};
