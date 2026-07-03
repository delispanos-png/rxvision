/** Prescription barcodes scan as 16 chars (13-digit barcode + 3-char type suffix, e.g. "…110").
 *  Everywhere we scan a prescription, keep ONLY the first 13 so it matches our stored barcode.
 *  Non-16-length input (manual typing, partial) is returned trimmed & untouched. */
export const scanRxBarcode = (raw: string): string => {
  const v = (raw ?? "").replace(/\s+/g, "");
  return v.length === 16 ? v.slice(0, 13) : v;
};

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

/** Ενιαία μορφή ημερομηνίας σε ΟΛΟ το project: DD/MM/YYYY (πάντα με μηδενικά). */
export const fmtDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
};

/** Ημερομηνία + ώρα: DD/MM/YYYY HH:mm (ενιαία μορφή). */
export const fmtDateTime = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${fmtDate(iso)} ${hh}:${mi}`;
};
