/** Prescription barcodes scan as 16 chars (13-digit barcode + 3-char type suffix, e.g. "…110").
 *  Everywhere we scan a prescription, keep ONLY the first 13 so it matches our stored barcode.
 *  Non-16-length input (manual typing, partial) is returned trimmed & untouched. */
export const scanRxBarcode = (raw: string): string => {
  const v = (raw ?? "").replace(/\s+/g, "");
  return v.length === 16 ? v.slice(0, 13) : v;
};

/** API money values are integer cents → divide by 100 for display. */
// ── «Πελάτης παρουσίασης»: απόκρυψη μεγάλων ποσών (26/11/2026) ─────────────────────────────────────
// Σε λογαριασμό παρουσίασης (tenant.demo ή χρήστης mask_pii → claim `demo` στο token) κάθε ποσό με 5+ ακέραια
// ψηφία δείχνει μόνο τα 3 πρώτα ψηφία: 12.345,67 € → 12.3XX,XX €. Ποσά κάτω από 10.000 μένουν ως έχουν.
// Η σημαία διαβάζεται ΣΥΓΧΡΟΝΑ από το token (όχι από κλήση API), ώστε να μην «αναβοσβήσουν» τα πραγματικά
// ποσά πριν φορτώσει κάτι. ΚΑΘΕ μορφοποιητής ποσού (κεντρικός ή τοπικός σελίδας) περνά από το `demoMask`.
let _demoTok: string | null | undefined;
let _demo = false;

export function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  let tok: string | null = null;
  try { tok = window.localStorage.getItem("access_token"); } catch { return false; }
  if (tok !== _demoTok) {
    _demoTok = tok;
    _demo = false;
    try {
      const part = tok?.split(".")[1];
      if (part) _demo = !!JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))).demo;
    } catch { /* άκυρο token → όχι παρουσίαση */ }
  }
  return _demo;
}

/** Καθαρή συνάρτηση (χωρίς σημαία): κρύβει τα ψηφία από το 4ο και μετά σε κάθε αριθμό με 5+ ακέραια ψηφία. */
export function maskBigAmounts(text: string): string {
  return text.replace(/\d[\d.,]*\d|\d/g, (num) => {
    const dec = num.match(/[.,]\d{1,2}$/);                       // δεκαδικό (ελληνικό «,» ή «.» του toFixed)
    const intDigits = (dec ? num.slice(0, -dec[0].length) : num).replace(/\D/g, "");
    if (intDigits.length < 5) return num;
    let seen = 0;
    return num.replace(/\d/g, (d) => (++seen <= 3 ? d : "X"));
  });
}

/** Ο ΕΝΑΣ τρόπος: ό,τι εμφανίζει ποσό σε € το περνά από εδώ. */
export function demoMask<T extends string | null | undefined>(text: T): T {
  return (typeof text === "string" && isDemoMode() ? maskBigAmounts(text) : text) as T;
}

export const fmtEur = (cents: number) =>
  demoMask(new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((cents ?? 0) / 100));

export const fmtNum = (n: number) => new Intl.NumberFormat("el-GR").format(n ?? 0);

/** Money (integer cents → €) the Greek way: 160.145,02 (no currency symbol — for "(€)" columns). */
export const fmtMoney = (cents: number) =>
  demoMask(new Intl.NumberFormat("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents ?? 0) / 100));

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
