// ΠΟΛΙΤΙΚΗ ΠΡΟΣΒΑΣΗΣ — ΦΑΣΗ 2 (εξαγωγές). ΕΝΑ σημείο για κάθε Excel/CSV/PDF του UI (lib/csv.ts · lib/export.ts):
//   1) άδεια από τον server: όριο ανά ημέρα, όριο γραμμών, κείμενο υδατογραφήματος, καταγραφή·
//   2) μετά τη δημιουργία, το SHA-256 του αρχείου → η καταγραφή «δένει» με το συγκεκριμένο αρχείο.
// Fail CLOSED: αν η καταγραφή δεν γίνει, η εξαγωγή δεν γίνεται (δεδομένα υγείας).
import { appAlert } from "@/store/dialogStore";

export type ExportTicket = { id: string; watermark: string; max_rows: number };

type Surface = "admin" | "portal" | "app";

function surface(): Surface {
  if (typeof window === "undefined") return "app";
  if (window.location.hostname.startsWith("adminpanel.")) return "admin";
  if (window.location.pathname.startsWith("/portal")) return "portal";
  return "app";
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const init: RequestInit = { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
  const s = surface();
  if (s === "admin") return (await import("./adminClient")).adminApi<T>(`/access${path}`, init);
  if (s === "portal") return (await import("./patientClient")).patientApi<T>(`/access${path}`, init);
  return (await import("./apiClient")).api<T>(`/access${path}`, init);
}

function problemOf(e: unknown): { status?: number; detail?: { error?: string; message?: string } } {
  const x = e as { status?: number; problem?: { detail?: { error?: string; message?: string } } };
  return { status: x?.status, detail: x?.problem?.detail };
}

/** Άδεια εξαγωγής. null → ΔΕΝ γίνεται (ο χρήστης έχει ήδη ενημερωθεί). */
export async function authorizeExport(format: "csv" | "xlsx" | "pdf", rows: number, screen?: string): Promise<ExportTicket | null> {
  try {
    const where = typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;
    return await call<ExportTicket>("/export", {
      format, rows, screen: (screen || where).slice(0, 200), filters: (typeof window === "undefined" ? "" : window.location.search).slice(0, 500),
    });
  } catch (e) {
    const p = problemOf(e);
    await appAlert(p.status === 429 && p.detail?.message
      ? p.detail.message
      : "Η εξαγωγή δεν ήταν δυνατή γιατί δεν καταγράφηκε. Δοκιμάστε ξανά σε λίγο.");
    return null;
  }
}

async function sha256(data: BlobPart): Promise<string | null> {
  try {
    const buf = await new Blob([data]).arrayBuffer();
    const h = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Μετά τη δημιουργία: δένει την καταγραφή με το αρχείο (SHA-256). Best-effort. */
export async function reportExportDone(t: ExportTicket, data: BlobPart, rows: number): Promise<void> {
  const h = await sha256(data);
  if (!h) return;
  try { await call(`/export/${t.id}/done`, { sha256: h, rows }); } catch { /* η άδεια έχει ήδη καταγραφεί */ }
}

/** Μήνυμα όταν κόπηκαν γραμμές λόγω ορίου. */
export async function noteTruncated(total: number, max: number): Promise<void> {
  if (total > max) {
    await appAlert(`Η εξαγωγή περιέχει τις πρώτες ${max.toLocaleString("el-GR")} από ${total.toLocaleString("el-GR")} εγγραφές (όριο ασφαλείας για δεδομένα υγείας). Περιορίστε τα φίλτρα για τις υπόλοιπες.`);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
