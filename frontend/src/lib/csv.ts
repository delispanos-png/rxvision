import { exportBlocked } from "./exportGate";
import { authorizeExport, downloadBlob, noteTruncated, reportExportDone } from "./exportAudit";

/** Client-side CSV export — builds a UTF-8 (BOM) file from rows and triggers a
 *  download. No backend needed; works on whatever list is already on screen.
 *  Excel opens it directly (the BOM makes Greek render correctly). */
export async function downloadCsv<T>(
  filename: string,
  columns: { key: string; header: string; value?: (row: T) => unknown }[],
  allRows: T[],
): Promise<void> {
  if (exportBlocked()) return;
  // Πολιτική πρόσβασης (Φάση 2): άδεια + καταγραφή + όριο γραμμών + υδατογράφημα. Fail closed.
  const ticket = await authorizeExport("csv", allRows.length);
  if (!ticket) return;
  const rows = allRows.slice(0, ticket.max_rows);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.header)).join(";");
  const body = rows
    .map((r) => columns.map((c) => esc(c.value ? c.value(r) : (r as Record<string, unknown>)[c.key])).join(";"))
    .join("\n");
  const content = "﻿" + esc(ticket.watermark) + "\n" + head + "\n" + body;
  downloadBlob(new Blob([content], { type: "text/csv;charset=utf-8;" }), filename.endsWith(".csv") ? filename : `${filename}.csv`);
  void reportExportDone(ticket, content, rows.length);
  await noteTruncated(allRows.length, ticket.max_rows);
}
