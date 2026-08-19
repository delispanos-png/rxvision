"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, CheckCircle2, Loader2, X, QrCode, AlertTriangle, Link2, Trash2, Sparkles, User, Stethoscope, ChevronDown, FolderOpen, FolderSync, Layers } from "lucide-react";
import { api, apiUpload, apiBlob } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { appConfirm } from "@/store/dialogStore";

/** Loads a scan image from the server (auth'd) so ANY user on the tenant sees it,
 * not just the uploader. Falls back to a QR placeholder while loading/on error. */
function ScanImage({ scanId, onOpen }: { scanId: string; onOpen?: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; let obj = "";
    apiBlob(`/reimbursement/scans/${scanId}/image`)
     .then((b) => { if (!alive) return; obj = URL.createObjectURL(b); setUrl(obj); })
     .catch(() => {});
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [scanId]);
  if (!url) return <div className="grid h-full place-items-center text-slate-300"><QrCode className="h-8 w-8" /></div>;
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img src={url} alt="" onClick={(e) => { e.stopPropagation(); onOpen?.(url); }} className="h-full w-full cursor-zoom-in object-cover" />;
}

type Coupons = { meds: number; qr: number; eof: number; intangible?: boolean | null;
  needs_original?: boolean | null; has_opinion?: boolean | null; is_eopyy?: boolean | null;
  fund?: string | null; is_fyk?: boolean | null; partial?: boolean | null;
  items?: { name: string | null; type: string | null; qty?: number | null }[] };
type AiMed = { name: string; quantity: number; coupon: boolean; qr: boolean };
type AiReading = {
  readable: boolean; doc_type: string;
  patient: { name: string; amka: string }; doctor: { name: string; specialty: string };
  date: string; rx_barcode: string; medicines: AiMed[];
  coupons: { count: number; with_barcode: number; with_qr: number };
  signatures: { doctor: boolean; pharmacist: boolean; patient: boolean };
  stamps: { doctor: boolean; pharmacy: boolean };
  anomalies: string[]; notes: string;
};
type Finding = { level: "ok" | "info" | "warn" | "error"; msg: string };
type Verdict = "compliant" | "review" | "problem";
type Scan = {
  scan_id: string; case_id?: string | null; filename?: string; status: string; optical_risk?: number | null; band?: string | null;
  flags?: string[]; matched?: string | null; barcode?: string | null; quality?: number | null;
  signature?: boolean | null; stamp?: boolean | null; coupons?: Coupons | null; reviewed_ok?: boolean | null;
  ai?: AiReading | null; ai_findings?: Finding[] | null; auto_verdict?: Verdict | null; ai_error?: string | null;
};
type Local = { scan_id: string; preview: string };

const BAND: Record<string, { cls: string; el: string; en: string }> = {
  ok: { cls: "bg-emerald-100 text-emerald-700", el: "OK", en: "OK" },
  needs_review: { cls: "bg-amber-100 text-amber-700", el: "Προς έλεγχο", en: "Needs review" },
  high_risk: { cls: "bg-rose-100 text-rose-700", el: "Υψηλό ρίσκο", en: "High risk" },
};
const VERDICT: Record<Verdict, { cls: string; el: string; en: string }> = {
  compliant: { cls: "bg-emerald-600 text-white", el: "✓ Σύννομη", en: "✓ OK" },
  review: { cls: "bg-amber-500 text-white", el: "⚠ Έλεγχος", en: "⚠ Review" },
  problem: { cls: "bg-rose-600 text-white", el: "✗ Πρόβλημα", en: "✗ Problem" },
};
const LEVEL: Record<string, string> = {
  error: "bg-rose-50 text-rose-700 dark:bg-rose-950/40",
  warn: "bg-amber-50 text-amber-700 dark:bg-amber-950/40",
  info: "bg-sky-50 text-sky-700 dark:bg-sky-950/40",
  ok: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40",
};
const FLAG: Record<string, { el: string; en: string }> = {
  missing_coupon: { el: "Φάρμακα χωρίς κουπόνι (QR/ΕΟΦ)", en: "Meds without coupon" },
  barcode_unread: { el: "Δεν διαβάστηκε barcode — χειροκίνητη ταυτοποίηση", en: "Barcode unread — match manually" },
  data_mismatch: { el: "Ασυμφωνία δεδομένων", en: "Data mismatch" },
  image_quality: { el: "Κακή ποιότητα εικόνας", en: "Poor image quality" },
  low_text: { el: "Ελάχιστο κείμενο", en: "Low text" },
  ocr_failed: { el: "Αποτυχία OCR", en: "OCR failed" },
};

// Κατάσταση σάρωσης για προτεραιοποίηση: όσες χρειάζονται ενέργεια (problem/review) πρώτες·
// σύννομες (ok) = πράσινο περίγραμμα, προβληματικές = κόκκινο.
type ScanStatus = "processing" | "problem" | "review" | "ok";
function scanStatus(s?: Scan | null): ScanStatus {
  if (!s || s.status !== "done") return "processing";
  if (s.reviewed_ok === true) return "ok";
  if (s.reviewed_ok === false) return "problem";
  const f = s.ai_findings ?? [];
  if (s.auto_verdict === "problem" || f.some((x) => x.level === "error")) return "problem";
  if (s.auto_verdict === "review" || f.some((x) => x.level === "warn") || !s.matched) return "review";
  return "ok";
}
const ST_BORDER: Record<ScanStatus, string> = {
  ok: "border-emerald-400 dark:border-emerald-600",
  review: "border-amber-400 dark:border-amber-600",
  problem: "border-rose-500 dark:border-rose-600",
  processing: "border-slate-200 dark:border-slate-700",
};
const ST_RANK: Record<ScanStatus, number> = { problem: 0, review: 1, processing: 2, ok: 3 };

export default function OpticalAuditPage() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [locals, setLocals] = useState<Local[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [detailScan, setDetailScan] = useState<Scan | null>(null);
  const [showOk, setShowOk] = useState(false);   // αρχικά μόνο όσες χρειάζονται ενέργεια
  // Σάρωση από φάκελο σαρωτή (File System Access API): ο σαρωτής ρίχνει αρχεία σε φάκελο → η σελίδα
  // τον παρακολουθεί & ανεβάζει αυτόματα κάθε νέα σάρωση. importedRef = ήδη-ανεβασμένα (dedup, persist).
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const importedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    try { importedRef.current = new Set(JSON.parse(localStorage.getItem("optical-imported") || "[]")); } catch { /* noop */ }
  }, []);
  const rememberImported = (key: string) => {
    importedRef.current.add(key);
    try {
      const arr = Array.from(importedRef.current).slice(-4000);   // cap
      localStorage.setItem("optical-imported", JSON.stringify(arr));
    } catch { /* noop */ }
  };

  const ai = useQuery({
    queryKey: ["prescriptor-status"],
    queryFn: () => api<{ configured: boolean; enabled: boolean; model: string }>("/reimbursement/prescriptor/status"),
    staleTime: 60_000,
  });
  const aiOn = !!(ai.data?.configured && ai.data?.enabled);

  const queue = useQuery({
    queryKey: ["optical-queue"], queryFn: () => api<{ items: Scan[] }>("/reimbursement/scans"),
    refetchInterval: 3000,
  });
  const byId = new Map((queue.data?.items ?? []).map((s) => [s.scan_id, s]));

  const IMG_RE = /\.(jpe?g|png|webp|tiff?|bmp|gif)$/i;

  async function uploadFiles(files: File[], opts?: { dedup?: boolean }) {
    if (!files.length) return;
    setUploading(true);
    for (const f of files) {
      const key = `${f.name}:${f.size}:${f.lastModified}`;
      if (opts?.dedup && importedRef.current.has(key)) continue;
      try {
        const fd = new FormData();
        fd.append("file", f);
        const r = await apiUpload<{ scan_id: string }>("/reimbursement/scans", fd);
        if (opts?.dedup) rememberImported(key);
        setLocals((s) => [{ scan_id: r.scan_id, preview: URL.createObjectURL(f) },...s]);
      } catch { /* ignore single failure */ }
    }
    setUploading(false);
    queue.refetch();
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadFiles(files);
  }

  // Fallback (browsers χωρίς File System Access API): επιλογή φακέλου με <input webkitdirectory> — one-shot.
  async function onFolderInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => IMG_RE.test(f.name));
    e.target.value = "";
    await uploadFiles(files, { dedup: true });
  }

  // Διάβασμα ΟΛΩΝ των νέων εικόνων ενός φακέλου (File System Access API) → ανέβασμα με dedup.
  async function importFromDir(h: FileSystemDirectoryHandle) {
    const fresh: File[] = [];
    try {
      // @ts-expect-error — async iterator on directory handle (Chromium)
      for await (const entry of h.values()) {
        if (entry.kind !== "file" || !IMG_RE.test(entry.name)) continue;
        try {
          const file = await entry.getFile();
          if (!importedRef.current.has(`${file.name}:${file.size}:${file.lastModified}`)) fresh.push(file);
        } catch { /* skip locked/partial */ }
      }
    } catch { /* permission lost */ }
    await uploadFiles(fresh, { dedup: true });
  }

  async function pickFolder() {
    const w = window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
    if (!w.showDirectoryPicker) { folderInputRef.current?.click(); return; }   // fallback
    try {
      const h = await w.showDirectoryPicker();
      dirHandleRef.current = h;
      setFolderName(h.name);
      setWatching(true);
      await importFromDir(h);
    } catch { /* user cancelled */ }
  }

  // Παρακολούθηση φακέλου: κάθε 8'' ψάξε για νέες σαρώσεις (όσο το tab είναι ανοιχτό & watching ενεργό).
  useEffect(() => {
    if (!watching || !dirHandleRef.current) return;
    const id = setInterval(() => { if (dirHandleRef.current) importFromDir(dirHandleRef.current); }, 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  async function review(scanId: string, ok: boolean) {
    try { await api(`/reimbursement/scans/${scanId}/review`, { method: "POST", body: JSON.stringify({ ok }) }); } catch { /* ignore */ }
    queue.refetch();
  }

  async function del(scanId: string) {
    if (!scanId || !(await appConfirm(t("Διαγραφή αυτής της σάρωσης;", "Delete this scan?"), { danger: true }))) return;
    try { await api(`/reimbursement/scans/${scanId}`, { method: "DELETE" }); } catch { /* ignore */ }
    setLocals((s) => s.filter((l) => l.scan_id !== scanId));
    queue.refetch();
  }

  // merge: local previews first, then server scans not in locals
  const localIds = new Set(locals.map((l) => l.scan_id));
  const serverOnly = (queue.data?.items ?? []).filter((s) => !localIds.has(s.scan_id));

  // ── Φάκελος συνταγής: ομαδοποίηση πολλών σαρώσεων σε ΜΙΑ συνταγή ──
  // caseKey = case_id (ίδιο barcode → auto) ή scan_id (μεμονωμένη). Χειροκίνητη ένωση για barcode-less.
  const caseKey = (s?: Scan | null) => (s?.case_id || s?.scan_id || "");
  const pagesOf = (key: string) => (queue.data?.items ?? []).filter((s) => caseKey(s) === key);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  async function groupSelected() {
    const ids = Array.from(selected);
    if (ids.length < 2) return;
    const items = queue.data?.items ?? [];
    // case_id = barcode μιας επιλεγμένης που έχει ήδη case (ταυτοποιημένη), αλλιώς η 1η σάρωση.
    const withCase = ids.map((id) => items.find((x) => x.scan_id === id)).find((x) => x?.case_id);
    const cid = withCase?.case_id || ids[0];
    try { await api(`/reimbursement/scans/group`, { method: "POST", body: JSON.stringify({ scan_ids: ids, case_id: cid }) }); } catch { /* ignore */ }
    setSelected(new Set());
    queue.refetch();
  }
  async function ungroup(scanId: string) {
    try { await api(`/reimbursement/scans/${scanId}/ungroup`, { method: "POST" }); } catch { /* ignore */ }
    queue.refetch();
  }

  function YesNo({ on, label }: { on?: boolean | null; label: string }) {
    return (
      <span className={`inline-flex items-center gap-0.5 ${on === true ? "text-emerald-600" : on === false ? "text-rose-500" : "text-slate-400"}`}>
        {on === true ? "✓" : on === false ? "✗" : "·"} {label}
      </span>
    );
  }

  function Card({ id, scan, preview, pageCount = 1, caseKey: ck }: { id: string; scan?: Scan; preview?: string; pageCount?: number; caseKey?: string }) {
    const done = scan?.status === "done";
    const isSel = selected.has(id);
    const band = scan?.band ? BAND[scan.band] : null;
    const verdict = scan?.auto_verdict ? VERDICT[scan.auto_verdict] : null;
    const a = scan?.ai;
    const findings = scan?.ai_findings ?? [];
    return (
      <div onClick={() => scan && setDetailScan(scan)} title={t("Κλικ για πλήρες πόρισμα", "Click for full report")}
        className={`cursor-pointer overflow-hidden rounded-xl border-2 bg-white transition hover:shadow-md dark:bg-slate-900 ${ST_BORDER[scanStatus(scan)]}`}>
        <div className="relative aspect-[3/4] bg-slate-100 dark:bg-slate-800">
          {preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={preview} alt="" onClick={(e) => { e.stopPropagation(); setLightbox(preview); }} className="h-full w-full cursor-zoom-in object-cover" /> : <ScanImage scanId={id} onOpen={(u) => setLightbox(u)} />}
          {/* checkbox επιλογής (χειροκίνητη ομαδοποίηση barcode-less σελίδων) */}
          <button onClick={(e) => { e.stopPropagation(); toggleSel(id); }} title={t("Επιλογή για ομαδοποίηση", "Select to group")}
            className={`absolute bottom-1.5 left-1.5 grid h-6 w-6 place-items-center rounded-md border-2 transition ${isSel ? "border-indigo-500 bg-indigo-500 text-white" : "border-white/70 bg-black/30 text-transparent hover:text-white/80"}`}>
            <CheckCircle2 className="h-3.5 w-3.5" />
          </button>
          {/* φάκελος συνταγής: πλήθος σελίδων */}
          {pageCount > 1 && <span className="absolute left-1.5 top-8 inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white"><Layers className="h-3 w-3" /> {pageCount} {t("σελ.", "pg")}</span>}
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white">
            {done ? (aiOn ? <Sparkles className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />) : <Loader2 className="h-3 w-3 animate-spin" />} {done ? (aiOn ? "AI" : "OCR") : t("ανάλυση…", "analyzing…")}
          </span>
          {/* badge precedence: manual verdict > AI verdict > OCR band */}
          {scan?.reviewed_ok === true
            ? <span className="absolute right-1.5 top-1.5 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">✓ {t("Σύννομη", "OK")}</span>
            : scan?.reviewed_ok === false
            ? <span className="absolute right-1.5 top-1.5 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white">✗ {t("Μη σύννομη", "Not OK")}</span>
            : verdict
            ? <span className={`absolute right-1.5 top-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${verdict.cls}`}>{t(verdict.el, verdict.en)}</span>
            : band && <span className={`absolute right-1.5 top-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${band.cls}`}>{t(band.el, band.en)}{scan?.optical_risk != null ? ` ${scan.optical_risk}` : ""}</span>}
          <Tooltip label={t("Διαγραφή", "Delete")}><button onClick={(e) => { e.stopPropagation(); del(id); }} className="absolute bottom-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white opacity-80 transition hover:bg-rose-600 hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></Tooltip>
        </div>
        <div className="space-y-1 p-2 text-xs">
          {scan?.barcode && <div className="flex items-center gap-1 font-mono text-slate-600 dark:text-slate-300"><QrCode className="h-3 w-3" /> {scan.barcode}</div>}
          {scan?.matched ? <div className="flex items-center gap-1 text-emerald-600"><Link2 className="h-3 w-3" /> {t("Ταυτοποιήθηκε", "Matched")}</div>
            : done && scan?.barcode ? <div className="flex items-center gap-1 text-rose-600"><AlertTriangle className="h-3 w-3" /> {t("Χωρίς αντιστοίχιση", "No match")}</div> : null}

          {/* ── Prescriptor: what the AI eye read ── */}
          {a && (
            <div className="space-y-1 rounded-lg bg-violet-50/60 p-1.5 dark:bg-violet-950/20">
              {a.patient?.name && <div className="flex items-center gap-1 truncate text-slate-600 dark:text-slate-300"><User className="h-3 w-3 shrink-0 text-violet-500" /> <span className="truncate">{a.patient.name}</span></div>}
              {a.doctor?.name && <div className="flex items-center gap-1 truncate text-slate-500"><Stethoscope className="h-3 w-3 shrink-0 text-violet-500" /> <span className="truncate">{a.doctor.name}</span></div>}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-medium">
                <span className="text-slate-600 dark:text-slate-300">💊 {a.medicines?.length ?? 0} {t("φάρμακα", "meds")}</span>
                {(a.coupons?.count ?? 0) > 0 && <span className="text-slate-600 dark:text-slate-300">🎟 {a.coupons.count} {t("κουπ.", "coup.")}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                <YesNo on={a.signatures?.doctor} label={t("Υπ.ιατ", "Dr sig")} />
                <YesNo on={a.stamps?.doctor} label={t("Σφρ.ιατ", "Dr stamp")} />
                <YesNo on={a.signatures?.pharmacist || a.stamps?.pharmacy} label={t("Φαρμ.", "Pharm")} />
              </div>
            </div>
          )}

          {/* findings (the discrepancies the eye might miss) */}
          {!!findings.length && (
            <div className="flex flex-col gap-1">
              {findings.slice(0, 3).map((f, i) => (
                <span key={i} className={`rounded px-1.5 py-0.5 text-[9px] font-medium leading-tight ${LEVEL[f.level] ?? LEVEL.info}`}>{f.msg}</span>
              ))}
              {findings.length > 3 && (
                <details className="text-[9px]">
                  <summary onClick={(e) => e.stopPropagation()} className="cursor-pointer text-slate-400">+{findings.length - 3} {t("ακόμη", "more")}</summary>
                  <div className="mt-1 flex flex-col gap-1">{findings.slice(3).map((f, i) => (
                    <span key={i} className={`rounded px-1.5 py-0.5 font-medium leading-tight ${LEVEL[f.level] ?? LEVEL.info}`}>{f.msg}</span>
                  ))}</div>
                </details>
              )}
            </div>
          )}
          {scan?.ai_error && <div className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-500 dark:bg-slate-800">{t("AI μη διαθέσιμο", "AI unavailable")}: {scan.ai_error}</div>}

          {/* full AI reading (medicines with quantities) */}
          {a && !!a.medicines?.length && (
            <details className="group">
              <summary onClick={(e) => e.stopPropagation()} className="flex cursor-pointer items-center gap-1 text-[10px] text-violet-600"><ChevronDown className="h-3 w-3 transition group-open:rotate-180" /> {t("Ανάλυση AI", "AI reading")}</summary>
              <ul className="mt-1 space-y-0.5">
                {a.medicines.map((m, i) => (
                  <li key={i} className="flex items-center justify-between gap-1 text-[10px] text-slate-600 dark:text-slate-300">
                    <span className="truncate">{m.name}</span>
                    <span className="shrink-0 font-medium">×{m.quantity}{m.qr ? " QR" : m.coupon ? " 🎟" : ""}</span>
                  </li>
                ))}
              </ul>
              {a.date && <div className="mt-1 text-[10px] text-slate-400">📅 {a.date}</div>}
              {a.notes && <div className="mt-1 text-[10px] italic text-slate-400">{a.notes}</div>}
            </details>
          )}

          {/* authoritative coupons + submission flags (from our ΗΔΥΚΑ data — same as closing) */}
          {done && scan?.coupons && scan.coupons.meds > 0 && (() => {
            const c = scan.coupons!; const ok = c.qr + c.eof >= c.meds;
            return (
              <div className="flex flex-wrap items-center gap-1 text-[10px] font-medium">
                <span className={ok ? "text-emerald-600" : "text-amber-600"}>{ok ? "✓" : "•"} {c.meds} {t("καταχ.", "rec.")}</span>
                {c.qr > 0 && <span className="rounded bg-sky-50 px-1 text-sky-700 dark:bg-sky-950/40">{c.qr} QR</span>}
                {c.eof > 0 && <span className="rounded bg-amber-50 px-1 text-amber-700 dark:bg-amber-950/40">{c.eof} {t("ταινία", "strip")}</span>}
                {c.intangible && <span className="rounded bg-violet-50 px-1 text-violet-700 dark:bg-violet-950/40">{t("άυλη", "paperless")}</span>}
                {c.needs_original && <span className="rounded bg-amber-100 px-1 text-amber-800 dark:bg-amber-950/40" title={t("Χρειάζεται πρωτότυπη έντυπη συνταγή", "Needs original paper Rx")}>📄 {t("πρωτότυπη", "original")}</span>}
                {c.has_opinion && <span className="rounded bg-indigo-50 px-1 text-indigo-700 dark:bg-indigo-950/40" title={t("Απαιτείται γνωμάτευση", "Medical opinion required")}>📋 {t("γνωμ.", "opinion")}</span>}
                {c.is_eopyy === false && c.fund && <span className="rounded bg-rose-50 px-1 text-rose-700 dark:bg-rose-950/40" title={t("Δεν είναι ΕΟΠΥΥ — ξεχωριστή κατάθεση", "Not ΕΟΠΥΥ — separate submission")}>🏛️ {c.fund}</span>}
                {c.is_fyk && <span className="rounded bg-fuchsia-50 px-1 text-fuchsia-700 dark:bg-fuchsia-950/40">ΦΥΚ</span>}
                {c.partial && <span className="rounded bg-orange-50 px-1 text-orange-700 dark:bg-orange-950/40">{t("μερική", "partial")}</span>}
              </div>
            );
          })()}
          {!aiOn && done && (
            <div className="flex items-center gap-2 text-[10px] text-slate-400">
              <Tooltip label={t("Αυτόματη εκτίμηση OCR — επιβεβαίωσε οπτικά (αναξιόπιστο)", "OCR estimate — confirm visually (unreliable)")}>
                <span className="cursor-help">{scan?.signature ? "~" : "·"} {t("Υπογρ.", "Sig")} · {scan?.stamp ? "~" : "·"} {t("Σφραγ.", "Stamp")} <span className="text-[8px] italic">({t("εκτίμηση", "estimate")})</span></span>
              </Tooltip>
            </div>
          )}
          {!!scan?.flags?.length && !a && <div className="flex flex-wrap gap-1">{scan.flags.map((f) => <span key={f} className="rounded bg-rose-50 px-1.5 py-0.5 text-[9px] font-medium text-rose-600 dark:bg-rose-950/40">{t(FLAG[f]?.el ?? f, FLAG[f]?.en ?? f)}</span>)}</div>}
          {done && (
            <div className="flex items-center gap-1 pt-0.5">
              <span className="text-[9px] text-slate-400">{a ? t("Επιβεβ.:", "Confirm:") : t("Έλεγχος:", "Verdict:")}</span>
              <button onClick={(e) => { e.stopPropagation(); review(id, true); }} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${scan?.reviewed_ok === true ? "bg-emerald-600 text-white" : "border border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}>✓ {t("Σύννομη", "OK")}</button>
              <button onClick={(e) => { e.stopPropagation(); review(id, false); }} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${scan?.reviewed_ok === false ? "bg-rose-600 text-white" : "border border-slate-300 text-slate-400 hover:bg-slate-50"}`}>✗</button>
            </div>
          )}
          {/* «Δες λεπτομέρειες» — πρόσκληση για το πλήρες πόρισμα (έντονο σε προβληματικές) */}
          {done && (() => {
            const st = scanStatus(scan);
            const cls = st === "problem" ? "bg-rose-600 text-white hover:bg-rose-700"
              : st === "review" ? "bg-amber-500 text-white hover:bg-amber-600"
              : "border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400";
            return <button onClick={(e) => { e.stopPropagation(); scan && setDetailScan(scan); }}
              className={`mt-1 w-full rounded-lg px-2 py-1.5 text-[11px] font-semibold transition ${cls}`}>
              {t("Δες λεπτομέρειες", "See details")} →</button>;
          })()}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 p-6 text-center dark:border-emerald-800 dark:bg-emerald-950/20">
        {aiOn ? <Sparkles className="mx-auto h-10 w-10 text-violet-600" /> : <Camera className="mx-auto h-10 w-10 text-emerald-600" />}
        <h2 className="mt-2 flex items-center justify-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100">
          {aiOn ? t("Prescriptor — AI ανάγνωση συνταγών", "Prescriptor — AI reads your prescriptions") : t("Σάρωση & οπτικός έλεγχος", "Scan & optical audit")}
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">beta</span>
        </h2>
        <p className="mt-1 text-sm text-slate-500">{aiOn
          ? t("Φωτογράφισε τη συνταγή — το AI διαβάζει ασφαλισμένο, ιατρό, φάρμακα & ποσότητες, κουπόνια, υπογραφές & σφραγίδες, εντοπίζει ασυνέπειες και τις διασταυρώνει αυτόματα με τα δεδομένα ΗΔΥΚΑ. Παίρνεις έτοιμο πόρισμα.",
              "Photograph the prescription — the AI reads insured, doctor, drugs & quantities, coupons, signatures & stamps, spots inconsistencies and cross-checks them against your ΗΔΥΚΑ data automatically. You get a ready verdict.")
          : t("Φωτογράφισε συνταγή/κουπόνι/γνωμάτευση — OCR (ελληνικά) + ανάγνωση barcode/QR + αντιστοίχιση με τα δεδομένα σου.", "Photograph prescription/coupon/opinion — Greek OCR + barcode/QR read + matching to your data.")}</p>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple onChange={onPick} className="hidden" />
        {/* @ts-expect-error webkitdirectory είναι μη-standard attribute (fallback επιλογής φακέλου) */}
        <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple onChange={onFolderInput} className="hidden" />
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button onClick={() => inputRef.current?.click()} disabled={uploading} className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${aiOn ? "bg-violet-600 hover:bg-violet-700" : "bg-emerald-600 hover:bg-emerald-700"}`}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} {t("Λήψη φωτογραφίας", "Take photo")}
          </button>
          <button onClick={pickFolder} disabled={uploading} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
            {watching ? <FolderSync className="h-4 w-4 text-emerald-600" /> : <FolderOpen className="h-4 w-4" />} {t("Από φάκελο σαρωτή", "From scanner folder")}
          </button>
        </div>
        {folderName && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              {watching ? <FolderSync className="h-3.5 w-3.5 animate-pulse" /> : <FolderOpen className="h-3.5 w-3.5" />}
              📁 {folderName} — {watching ? t("παρακολούθηση ενεργή", "watching") : t("σε παύση", "paused")}
            </span>
            <button onClick={() => setWatching((w) => !w)} className="rounded-full border border-slate-300 px-2.5 py-1 font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">
              {watching ? t("Παύση", "Pause") : t("Συνέχιση", "Resume")}
            </button>
          </div>
        )}
      </div>

      {(locals.length > 0 || serverOnly.length > 0) && (() => {
        const flat = [
          ...locals.map((l) => ({ id: l.scan_id, scan: byId.get(l.scan_id) as Scan | undefined, preview: l.preview as string | undefined })),
          ...serverOnly.map((s) => ({ id: s.scan_id, scan: s as Scan | undefined, preview: undefined as string | undefined })),
        ];
        // ── Ομαδοποίηση σε ΦΑΚΕΛΟΥΣ ΣΥΝΤΑΓΗΣ (ίδιο barcode/case_id → μία κάρτα με πολλές σελίδες) ──
        const groups = new Map<string, typeof flat>();
        for (const x of flat) {
          const key = x.scan ? caseKey(x.scan) : x.id;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(x);
        }
        const cases = Array.from(groups.entries()).map(([key, pages]) => {
          const primary = pages.find((p) => p.scan?.matched) ?? pages[0];
          const st = pages.reduce<ScanStatus>((w, p) => ST_RANK[scanStatus(p.scan)] < ST_RANK[w] ? scanStatus(p.scan) : w, "ok");
          return { key, pages, primary, st, count: pages.length };
        });
        const okCount = cases.filter((x) => x.st === "ok").length;
        const actionCount = cases.filter((x) => x.st === "problem" || x.st === "review").length;
        const procCount = cases.filter((x) => x.st === "processing").length;
        const visible = cases.filter((x) => showOk || x.st !== "ok").sort((a, b) => ST_RANK[a.st] - ST_RANK[b.st]);
        return (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Optical Audit", "Optical Audit")} ({cases.length})</h3>
              {actionCount > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"><AlertTriangle className="h-3.5 w-3.5" /> {actionCount} {t("χρειάζονται έλεγχο", "need review")}</span>}
              {procCount > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {procCount} {t("σε ανάλυση", "analyzing")}</span>}
              {okCount > 0 && <button onClick={() => setShowOk((v) => !v)} className="inline-flex items-center gap-1 rounded-full border border-emerald-300 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> {showOk ? t(`Απόκρυψη ${okCount} σύννομων`, `Hide ${okCount} compliant`) : t(`${okCount} σύννομες — εμφάνιση`, `${okCount} compliant — show`)}</button>}
              {selected.size >= 2 && <button onClick={groupSelected} className="ml-auto inline-flex items-center gap-1 rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700"><Layers className="h-3.5 w-3.5" /> {t(`Ομαδοποίηση ${selected.size} σε μία συνταγή`, `Group ${selected.size} into one Rx`)}</button>}
              {selected.size > 0 && <button onClick={() => setSelected(new Set())} className="text-xs text-slate-400 underline">{t("άκυρο", "clear")}</button>}
            </div>
            {visible.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {visible.map((x) => <Card key={x.key} id={x.primary.id} scan={x.primary.scan} preview={x.primary.preview} pageCount={x.count} caseKey={x.key} />)}
              </div>
            ) : (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">
                ✓ {t("Όλες οι σαρώσεις είναι σύννομες — καμία δεν χρειάζεται ενέργεια.", "All scans are compliant — none need action.")}
                {okCount > 0 && <button onClick={() => setShowOk(true)} className="ml-2 underline">{t("Εμφάνιση όλων", "Show all")}</button>}
              </div>
            )}
          </div>
        );
      })()}

      <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
        📁 {t("Αυτόματη σάρωση από φάκελο: ρύθμισε τον σαρωτή σου να αποθηκεύει τις εικόνες σε έναν φάκελο (ή δικτυακό δίσκο), πάτησε «Από φάκελο σαρωτή» και επίλεξέ τον μία φορά. Κάθε νέα σάρωση ανεβαίνει & ελέγχεται αυτόματα όσο η καρτέλα είναι ανοιχτή — χωρίς εγκατάσταση. (Chrome/Edge)",
                "Auto-scan from a folder: set your scanner to save images into a folder (or mapped network drive), click «From scanner folder» and pick it once. Every new scan uploads & is checked automatically while the tab is open — no install. (Chrome/Edge)")}
      </p>
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60">
        {aiOn
          ? <>🔒 {t("Οι εικόνες αποθηκεύονται στη δική μας υποδομή (GridFS). Με ενεργό το Prescriptor, η εικόνα αναλύεται από το AI (Claude) βάσει της σύμβασης/συγκατάθεσης του φαρμακείου. Απενεργοποιείται από τις ρυθμίσεις.", "Images are stored on our own infrastructure (GridFS). With Prescriptor enabled, the image is analyzed by the AI (Claude) under the pharmacy's agreement/consent. Can be turned off in settings.")}</>
          : <>🔒 {t("Οι εικόνες αποθηκεύονται στη δική μας υποδομή (GridFS) — δεν φεύγουν σε τρίτους. OCR: Tesseract (ελληνικά), barcode/QR: zbar.", "Images stored on our own infrastructure (GridFS) — never sent to third parties. OCR: Tesseract (Greek), barcode/QR: zbar.")}</>}
      </p>

      {/* ── Πλήρες πόρισμα (modal) — ευανάγνωστο, κλικ σε κάρτα ── */}
      {detailScan && (() => {
        const key = caseKey(detailScan);
        const pages = pagesOf(key);
        // πρωτεύουσα σελίδα (ταυτοποιημένο φύλλο εκτέλεσης) οδηγεί το πόρισμα· οι υπόλοιπες = συνοδευτικά
        const s = pages.find((p) => p.matched) ?? byId.get(detailScan.scan_id) ?? detailScan;
        const v = s.auto_verdict ? VERDICT[s.auto_verdict] : null;
        const a = s.ai; const c = s.coupons;
        // aggregate findings ΑΠΟ ΟΛΕΣ τις σελίδες (dedup ανά μήνυμα)
        const seenMsg = new Set<string>();
        const findings = (pages.length ? pages : [s]).flatMap((p) => p.ai_findings ?? [])
          .filter((f) => { if (seenMsg.has(f.msg)) return false; seenMsg.add(f.msg); return true; });
        const intangible = c?.intangible;
        const LEV_ICON: Record<string, string> = { error: "⛔", warn: "⚠️", info: "ℹ️", ok: "✓" };
        return (
          <div onClick={() => setDetailScan(null)} className="fixed inset-0 z-40 overflow-y-auto bg-black/70 p-4">
            <div onClick={(e) => e.stopPropagation()} className="mx-auto my-6 w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {s.reviewed_ok === true ? <span className="rounded-full bg-emerald-600 px-3 py-1 text-sm font-bold text-white">✓ {t("Σύννομη", "Compliant")}</span>
                      : s.reviewed_ok === false ? <span className="rounded-full bg-rose-600 px-3 py-1 text-sm font-bold text-white">✗ {t("Μη σύννομη", "Not OK")}</span>
                      : v ? <span className={`rounded-full px-3 py-1 text-sm font-bold ${v.cls}`}>{t(v.el, v.en)}</span> : null}
                    {a?.patient?.name && <h3 className="truncate text-xl font-bold text-slate-900 dark:text-slate-100">{a.patient.name}</h3>}
                  </div>
                  {a?.doctor?.name && <div className="mt-1 text-sm text-slate-500">🩺 {a.doctor.name}{a.doctor.specialty ? ` · ${a.doctor.specialty}` : ""}</div>}
                  {s.barcode && <div className="mt-0.5 font-mono text-xs text-slate-400">{s.barcode}{s.matched ? ` · ✓ ${t("ταυτοποιήθηκε", "matched")}` : ""}</div>}
                </div>
                <button onClick={() => setDetailScan(null)} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"><X className="h-5 w-5" /></button>
              </div>

              <div className="grid gap-5 sm:grid-cols-[240px_1fr]">
                <div className="space-y-2">
                  <div className="aspect-[3/4] overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800">
                    <ScanImage scanId={s.scan_id} onOpen={(u) => setLightbox(u)} />
                  </div>
                  {pages.length > 1 && (
                    <div>
                      <div className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400"><Layers className="h-3.5 w-3.5" /> {pages.length} {t("σελίδες φακέλου συνταγής", "pages in this Rx case")}</div>
                      <div className="flex flex-wrap gap-2">
                        {pages.map((p) => (
                          <div key={p.scan_id} className={`relative h-16 w-12 overflow-hidden rounded-md border-2 ${p.scan_id === s.scan_id ? "border-indigo-500" : "border-slate-200 dark:border-slate-700"}`}>
                            <ScanImage scanId={p.scan_id} onOpen={(u) => setLightbox(u)} />
                            {p.scan_id !== s.scan_id && (
                              <button onClick={() => ungroup(p.scan_id)} title={t("Αφαίρεση από φάκελο", "Remove from case")}
                                className="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl bg-black/60 text-white hover:bg-rose-600"><X className="h-2.5 w-2.5" /></button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  {/* Ταμείο / κουπόνια (authoritative) */}
                  {c && c.meds > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-semibold text-slate-700 dark:text-slate-200">{c.meds} {t("φάρμακα", "meds")}:</span>
                      {c.qr > 0 && <span className="rounded-md bg-sky-100 px-2 py-0.5 text-sky-700 dark:bg-sky-950/40">{c.qr} QR</span>}
                      {c.eof > 0 && <span className="rounded-md bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950/40">{c.eof} {t("ταινία", "strip")}</span>}
                      {c.intangible && <span className="rounded-md bg-violet-100 px-2 py-0.5 text-violet-700 dark:bg-violet-950/40">{t("άυλη", "paperless")}</span>}
                      {c.is_eopyy === false && c.fund && <span className="rounded-md bg-rose-100 px-2 py-0.5 text-rose-700 dark:bg-rose-950/40">🏛️ {c.fund}</span>}
                      {c.needs_original && <span className="rounded-md bg-amber-100 px-2 py-0.5 text-amber-800">📄 {t("πρωτότυπη", "original")}</span>}
                      {c.has_opinion && <span className="rounded-md bg-indigo-100 px-2 py-0.5 text-indigo-700">📋 {t("γνωμάτευση", "opinion")}</span>}
                      {c.is_fyk && <span className="rounded-md bg-fuchsia-100 px-2 py-0.5 text-fuchsia-700">ΦΥΚ</span>}
                      {c.partial && <span className="rounded-md bg-orange-100 px-2 py-0.5 text-orange-700">{t("μερική", "partial")}</span>}
                    </div>
                  )}

                  {/* Ευρήματα ελέγχου — ΕΥΑΝΑΓΝΩΣΤΑ */}
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold uppercase tracking-wide text-slate-400">{t("Ευρήματα ελέγχου", "Check findings")}</div>
                    {findings.length ? findings.map((f, i) => (
                      <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm leading-snug ${LEVEL[f.level] ?? LEVEL.info}`}>
                        <span className="shrink-0">{LEV_ICON[f.level] ?? "•"}</span><span>{f.msg}</span>
                      </div>
                    )) : <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">✓ {t("Καμία ασυνέπεια — η συνταγή φαίνεται εντάξει.", "No inconsistencies — the prescription looks fine.")}</div>}
                    {s.ai_error && <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800">{t("AI μη διαθέσιμο", "AI unavailable")}: {s.ai_error}</div>}
                  </div>

                  {/* Ανάλυση AI — φάρμακα */}
                  {a && !!a.medicines?.length && (
                    <div className="space-y-1">
                      <div className="text-xs font-bold uppercase tracking-wide text-slate-400">{t("Ανάλυση AI — φάρμακα στη φωτό", "AI reading — meds on photo")}</div>
                      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                        {a.medicines.map((m, i) => (
                          <li key={i} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-200">
                            <span className="truncate">{m.name}</span>
                            <span className="shrink-0 font-medium text-slate-500">×{m.quantity}{m.qr ? " QR" : m.coupon ? " 🎟" : ""}</span>
                          </li>
                        ))}
                      </ul>
                      {a.date && <div className="text-xs text-slate-400">📅 {a.date}</div>}
                    </div>
                  )}

                  {/* Υπογραφές/σφραγίδες — ΜΟΝΟ σε έντυπη (άυλη = δεν χρειάζεται) */}
                  {intangible ? (
                    <div className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-700 dark:bg-violet-950/30 dark:text-violet-300">
                      {t("Άυλη συνταγή — δεν απαιτείται φυσικός έλεγχος (υπογραφή/σφραγίδα/ταινία).", "Paperless — no physical check required (signature/stamp/strip).")}
                    </div>
                  ) : a && (
                    <div className="flex flex-wrap gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
                      <YesNo on={a.signatures?.doctor} label={t("Υπογρ. ιατρού", "Dr signature")} />
                      <YesNo on={a.stamps?.doctor} label={t("Σφραγ. ιατρού", "Dr stamp")} />
                      <YesNo on={a.signatures?.pharmacist || a.stamps?.pharmacy} label={t("Φαρμακείο", "Pharmacy")} />
                      <YesNo on={a.signatures?.patient} label={t("Παραλήπτης", "Recipient")} />
                    </div>
                  )}
                </div>
              </div>

              {/* Επιβεβαίωση φαρμακοποιού — μεγάλα κουμπιά */}
              {s.status === "done" && (
                <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                  <span className="text-sm font-medium text-slate-500">{t("Η κρίση σου:", "Your verdict:")}</span>
                  <button onClick={() => { review(s.scan_id, true); setDetailScan(null); }} className={`rounded-lg px-4 py-2 text-sm font-semibold ${s.reviewed_ok === true ? "bg-emerald-600 text-white" : "border border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}>✓ {t("Σύννομη", "Compliant")}</button>
                  <button onClick={() => { review(s.scan_id, false); setDetailScan(null); }} className={`rounded-lg px-4 py-2 text-sm font-semibold ${s.reviewed_ok === false ? "bg-rose-600 text-white" : "border border-slate-300 text-slate-500 hover:bg-slate-50"}`}>✗ {t("Μη σύννομη", "Not OK")}</button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          <button onClick={() => setLightbox(null)} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-slate-800 hover:bg-white"><X className="h-5 w-5" /></button>
        </div>
      )}
    </div>
  );
}
