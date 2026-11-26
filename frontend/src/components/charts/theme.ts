import { isDemoMode, maskBigAmounts } from "@/lib/formatters";

/** Shared brand palette for all ECharts wrappers (RxVision indigo). */
export const BRAND = "#6366f1";
export const BRAND_SOFT = "#a5b4fc";
export const PALETTE = ["#6366f1", "#818cf8", "#22c55e", "#f59e0b", "#f97316", "#06b6d4", "#ec4899", "#ef4444"];

export const BASE_GRID = { left: 48, right: 16, top: 24, bottom: 36 };

export const axisStyle = {
  axisLine: { lineStyle: { color: "#e2e8f0" } },
  axisTick: { show: false },
  axisLabel: { color: "#64748b", fontSize: 11 },
  splitLine: { lineStyle: { color: "#f1f5f9" } },
};

/** TEAL kept as alias so existing imports keep working. */
export const TEAL = BRAND;


// «Πελάτης παρουσίασης»: γράφημα με ποσά σε € → ίδια απόκρυψη με τους μορφοποιητές (12.3XX). Ποσό = σειρά/όνομα
// με «€». Επιστρέφει επιλογές για άξονα τιμών + tooltip, ή {} όταν δεν χρειάζεται τίποτα.
export function demoMoneyAxis(names: (string | undefined)[]): { axisLabel?: object; valueFormatter?: (v: number) => string } {
  if (!isDemoMode() || !names.some((n) => (n || "").includes("€"))) return {};
  const fmt = (v: number) => maskBigAmounts(new Intl.NumberFormat("el-GR").format(Math.round(Number(v) || 0)));
  return { axisLabel: { formatter: fmt }, valueFormatter: fmt };
}
