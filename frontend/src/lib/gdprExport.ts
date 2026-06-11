import { fmtMoney } from "@/lib/formatters";
// Client-side GDPR data-subject export helpers (Art.15 access + Art.20 portability):
// a machine-readable JSON download and a human-readable PDF. The PDF is rendered via
// html2canvas (like lib/export.ts) so Greek text draws correctly — jsPDF core fonts are
// Latin-1 only and cannot render Greek with .text().

function esc(v: unknown): string {
  return String(v ?? "—").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type Bundle = {
  exported_at?: string;
  subject_id?: string;
  identity?: Record<string, unknown> | null;
  contact?: Record<string, unknown> | null;
  prescription_executions?: Array<Record<string, unknown>>;
  consents?: Array<Record<string, unknown>>;
  counts?: Record<string, number>;
};

function bundleHtml(b: Bundle): string {
  const id = b.identity || {};
  const c = b.contact || {};
  const eur = (v: unknown) => (typeof v === "number" ? fmtMoney(v) + " €" : "—");
  const rows = (b.prescription_executions || []).slice(0, 300).map((e) =>
    `<tr><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${esc(e.executed_at)}</td>
     <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${esc((e.icd10 as string[] || []).join(", "))}</td>
     <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;text-align:right;">${eur(e.amount_total)}</td></tr>`).join("");
  const consents = (b.consents || []).slice(0, 100).map((k) =>
    `<li>${esc(k.channel)}: <b>${esc(k.status)}</b> — ${esc(k.at)} (${esc(k.source)})</li>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;width:760px;padding:8px;">
    <div style="font-size:20px;font-weight:700;">RxVision — Εξαγωγή Προσωπικών Δεδομένων</div>
    <div style="color:#64748b;font-size:12px;margin-bottom:4px;">GDPR Άρθρο 15 (πρόσβαση) & Άρθρο 20 (φορητότητα)</div>
    <div style="font-size:12px;color:#475569;">Ημερομηνία εξαγωγής: ${esc(b.exported_at)} · Κωδικός υποκειμένου: ${esc(b.subject_id)}</div>
    <h3 style="margin:16px 0 4px;font-size:15px;">Ταυτότητα</h3>
    <div style="font-size:13px;">Όνομα: ${esc(id.full_name)} · Φύλο: ${esc(id.sex)} · Ηλικιακή ομάδα: ${esc(id.age_group)} · Περιοχή: ${esc(id.residence_area)}</div>
    <h3 style="margin:16px 0 4px;font-size:15px;">Στοιχεία επικοινωνίας</h3>
    <div style="font-size:13px;">Τηλέφωνο: ${esc(c.phone ?? c.mobile)} · Email: ${esc(c.email)}</div>
    <div style="font-size:13px;">Διεύθυνση: ${esc([c.address, c.city, c.postal_code].filter(Boolean).join(", "))}</div>
    <h3 style="margin:16px 0 4px;font-size:15px;">Εκτελέσεις συνταγών (${esc(b.counts?.executions ?? 0)})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr style="background:#4f46e5;color:#fff;"><th style="padding:5px 8px;text-align:left;">Ημ/νία</th><th style="padding:5px 8px;text-align:left;">ICD-10</th><th style="padding:5px 8px;text-align:right;">Ποσό</th></tr>
      ${rows || '<tr><td colspan="3" style="padding:6px 8px;color:#64748b;">—</td></tr>'}
    </table>
    <h3 style="margin:16px 0 4px;font-size:15px;">Συγκαταθέσεις επικοινωνίας</h3>
    <ul style="font-size:12px;margin:0;padding-left:18px;">${consents || "<li>—</li>"}</ul>
    <div style="margin-top:18px;font-size:11px;color:#94a3b8;">Τα κλινικά αρχεία συνταγών διατηρούνται κατά τη φαρμακευτική νομοθεσία (νόμιμη διατήρηση).</div>
  </div>`;
}

export async function downloadGdprPdf(filename: string, bundle: Bundle): Promise<void> {
  const [{ jsPDF }, html2canvas] = await Promise.all([
    import("jspdf"),
    import("html2canvas").then((m) => m.default),
  ]);
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-99999px;top:0;background:#fff;";
  wrap.innerHTML = bundleHtml(bundle);
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
  const pxPerPage = Math.floor((canvas.width * pageH) / pageW);
  let y = 0;
  let page = 0;
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
