// Client-side exports — XLSX (SheetJS) + professional, colour-branded PDF (html2canvas
// → jsPDF, which renders Greek perfectly because the browser draws the text). All heavy
// libs are dynamically imported so they never bloat the main bundle.

export type ExportCol<T> = { key: string; header: string; value?: (row: T) => unknown };

const cell = <T,>(c: ExportCol<T>, r: T): unknown => {
  const v = c.value ? c.value(r) : (r as Record<string, unknown>)[c.key];
  return v == null ? "" : v;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function downloadXlsx<T>(filename: string, columns: ExportCol<T>[], rows: T[]): Promise<void> {
  const XLSX = await import("xlsx");
  const aoa = [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => cell(c, r)))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = columns.map((c) => ({ wch: Math.max(12, c.header.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "RxVision");
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}

export async function downloadPdf<T>(filename: string, title: string, columns: ExportCol<T>[], rows: T[]): Promise<void> {
  const [{ jsPDF }, html2canvas] = await Promise.all([
    import("jspdf"),
    import("html2canvas").then((m) => m.default),
  ]);
  const MAX = 1500;
  const data = rows.slice(0, MAX);
  const date = new Date().toLocaleDateString("el-GR", { day: "numeric", month: "long", year: "numeric" });

  const ths = columns.map((c) => `<th style="background:#4f46e5;color:#fff;text-align:left;padding:9px 11px;font-size:12px;font-weight:600;white-space:nowrap;">${esc(c.header)}</th>`).join("");
  const trs = data.map((r, i) =>
    `<tr style="background:${i % 2 ? "#f1f5f9" : "#ffffff"};">${columns.map((c) =>
      `<td style="padding:7px 11px;font-size:11px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${esc(String(cell(c, r)))}</td>`).join("")}</tr>`).join("");

  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-99999px;top:0;width:1040px;background:#fff;padding:34px;font-family:Arial,Helvetica,sans-serif;";
  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #4f46e5;padding-bottom:13px;margin-bottom:18px;">
      <div>
        <div style="font-size:23px;font-weight:800;color:#4f46e5;letter-spacing:-0.5px;">RxVision</div>
        <div style="font-size:15px;color:#334155;margin-top:3px;font-weight:600;">${esc(title)}</div>
      </div>
      <div style="font-size:12px;color:#94a3b8;text-align:right;">${date}<br/>${data.length}${rows.length > MAX ? ` από ${rows.length}` : ""} εγγραφές</div>
    </div>
    <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;">
      <thead><tr>${ths}</tr></thead><tbody>${trs}</tbody>
    </table>
    <div style="margin-top:16px;font-size:10px;color:#cbd5e1;">RxVision · CloudOn — αναλυτικά εκτέλεσης συνταγών</div>`;
  document.body.appendChild(wrap);
  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(wrap, { scale: 2, backgroundColor: "#ffffff" });
  } finally {
    document.body.removeChild(wrap);
  }

  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const pxPerPage = (canvas.width * pageH) / pageW; // canvas px that fit on one page
  let y = 0, page = 0;
  while (y < canvas.height) {
    const sliceH = Math.min(pxPerPage, canvas.height - y);
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sliceH;
    slice.getContext("2d")!.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
    if (page > 0) doc.addPage();
    doc.addImage(slice.toDataURL("image/png"), "PNG", 0, 0, pageW, (sliceH * pageW) / canvas.width);
    y += pxPerPage;
    page += 1;
  }
  doc.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}
