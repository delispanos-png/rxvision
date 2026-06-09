/** Client-side CSV export — builds a UTF-8 (BOM) file from rows and triggers a
 *  download. No backend needed; works on whatever list is already on screen.
 *  Excel opens it directly (the BOM makes Greek render correctly). */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  columns: { key: string; header: string; value?: (row: T) => unknown }[],
  rows: T[],
): void {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.header)).join(";");
  const body = rows
    .map((r) => columns.map((c) => esc(c.value ? c.value(r) : r[c.key])).join(";"))
    .join("\n");
  const blob = new Blob(["﻿" + head + "\n" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
