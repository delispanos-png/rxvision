"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, CheckCircle2, Loader2, X, QrCode, AlertTriangle, Link2, Trash2 } from "lucide-react";
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
  return <img src={url} alt="" onClick={() => onOpen?.(url)} className="h-full w-full cursor-zoom-in object-cover" />;
}

type Coupons = { meds: number; qr: number; eof: number; intangible?: boolean | null; items?: { name: string | null; type: string | null }[] };
type Scan = {
  scan_id: string; filename?: string; status: string; optical_risk?: number | null; band?: string | null;
  flags?: string[]; matched?: string | null; barcode?: string | null; quality?: number | null;
  signature?: boolean | null; stamp?: boolean | null; coupons?: Coupons | null; reviewed_ok?: boolean | null;
};
type Local = { scan_id: string; preview: string };

const BAND: Record<string, { cls: string; el: string; en: string }> = {
  ok: { cls: "bg-emerald-100 text-emerald-700", el: "OK", en: "OK" },
  needs_review: { cls: "bg-amber-100 text-amber-700", el: "Προς έλεγχο", en: "Needs review" },
  high_risk: { cls: "bg-rose-100 text-rose-700", el: "Υψηλό ρίσκο", en: "High risk" },
};
const FLAG: Record<string, { el: string; en: string }> = {
  missing_coupon: { el: "Φάρμακα χωρίς κουπόνι (QR/ΕΟΦ)", en: "Meds without coupon" },
  barcode_unread: { el: "Δεν διαβάστηκε barcode — χειροκίνητη ταυτοποίηση", en: "Barcode unread — match manually" },
  data_mismatch: { el: "Ασυμφωνία δεδομένων", en: "Data mismatch" },
  image_quality: { el: "Κακή ποιότητα εικόνας", en: "Poor image quality" },
  low_text: { el: "Ελάχιστο κείμενο", en: "Low text" },
  ocr_failed: { el: "Αποτυχία OCR", en: "OCR failed" },
};

export default function OpticalAuditPage() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [locals, setLocals] = useState<Local[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ["optical-queue"], queryFn: () => api<{ items: Scan[] }>("/reimbursement/scans"),
    refetchInterval: 3000,
  });
  const byId = new Map((queue.data?.items ?? []).map((s) => [s.scan_id, s]));

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setUploading(true);
    for (const f of files) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        const r = await apiUpload<{ scan_id: string }>("/reimbursement/scans", fd);
        setLocals((s) => [{ scan_id: r.scan_id, preview: URL.createObjectURL(f) }, ...s]);
      } catch { /* ignore single failure */ }
    }
    setUploading(false);
    queue.refetch();
  }

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

  function Card({ id, scan, preview }: { id: string; scan?: Scan; preview?: string }) {
    const done = scan?.status === "done";
    const band = scan?.band ? BAND[scan.band] : null;
    return (
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="relative aspect-[3/4] bg-slate-100 dark:bg-slate-800">
          {preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={preview} alt="" onClick={() => setLightbox(preview)} className="h-full w-full cursor-zoom-in object-cover" /> : <ScanImage scanId={id} onOpen={setLightbox} />}
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white">
            {done ? <CheckCircle2 className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />} {done ? "OCR" : t("ανάλυση…", "analyzing…")}
          </span>
          {scan?.reviewed_ok === true
            ? <span className="absolute right-1.5 top-1.5 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">✓ {t("Σύννομη", "OK")}</span>
            : scan?.reviewed_ok === false
            ? <span className="absolute right-1.5 top-1.5 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white">✗ {t("Μη σύννομη", "Not OK")}</span>
            : band && <span className={`absolute right-1.5 top-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${band.cls}`}>{t(band.el, band.en)}{scan?.optical_risk != null ? ` ${scan.optical_risk}` : ""}</span>}
          <Tooltip label={t("Διαγραφή", "Delete")}><button onClick={() => del(id)} className="absolute bottom-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white opacity-80 transition hover:bg-rose-600 hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></Tooltip>
        </div>
        <div className="space-y-1 p-2 text-xs">
          {scan?.barcode && <div className="flex items-center gap-1 font-mono text-slate-600 dark:text-slate-300"><QrCode className="h-3 w-3" /> {scan.barcode}</div>}
          {scan?.matched ? <div className="flex items-center gap-1 text-emerald-600"><Link2 className="h-3 w-3" /> {t("Ταυτοποιήθηκε", "Matched")}</div>
            : done && scan?.barcode ? <div className="flex items-center gap-1 text-rose-600"><AlertTriangle className="h-3 w-3" /> {t("Χωρίς αντιστοίχιση", "No match")}</div> : null}
          {done && scan?.coupons && scan.coupons.meds > 0 && (() => {
            const c = scan.coupons!; const ok = c.qr + c.eof >= c.meds;
            return (
              <div className="flex flex-wrap items-center gap-1 text-[10px] font-medium">
                <span className={ok ? "text-emerald-600" : "text-amber-600"}>{ok ? "✓" : "•"} {c.meds} {t("φάρμακα", "meds")}</span>
                {c.qr > 0 && <span className="rounded bg-sky-50 px-1 text-sky-700 dark:bg-sky-950/40">{c.qr} QR</span>}
                {c.eof > 0 && <span className="rounded bg-amber-50 px-1 text-amber-700 dark:bg-amber-950/40">{c.eof} ΕΟΦ</span>}
                {c.intangible && <span className="rounded bg-violet-50 px-1 text-violet-700 dark:bg-violet-950/40">{t("άυλη", "paperless")}</span>}
              </div>
            );
          })()}
          {done && (
            <div className="flex items-center gap-2 text-[10px] text-slate-400">
              <Tooltip label={t("Αυτόματη εκτίμηση OCR — επιβεβαίωσε οπτικά (αναξιόπιστο)", "OCR estimate — confirm visually (unreliable)")}>
                <span className="cursor-help">{scan?.signature ? "~" : "·"} {t("Υπογρ.", "Sig")} · {scan?.stamp ? "~" : "·"} {t("Σφραγ.", "Stamp")} <span className="text-[8px] italic">({t("εκτίμηση", "estimate")})</span></span>
              </Tooltip>
            </div>
          )}
          {!!scan?.flags?.length && <div className="flex flex-wrap gap-1">{scan.flags.map((f) => <span key={f} className="rounded bg-rose-50 px-1.5 py-0.5 text-[9px] font-medium text-rose-600 dark:bg-rose-950/40">{t(FLAG[f]?.el ?? f, FLAG[f]?.en ?? f)}</span>)}</div>}
          {done && (
            <div className="flex items-center gap-1 pt-0.5">
              <span className="text-[9px] text-slate-400">{t("Έλεγχος:", "Verdict:")}</span>
              <button onClick={() => review(id, true)} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${scan?.reviewed_ok === true ? "bg-emerald-600 text-white" : "border border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}>✓ {t("Σύννομη", "OK")}</button>
              <button onClick={() => review(id, false)} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${scan?.reviewed_ok === false ? "bg-rose-600 text-white" : "border border-slate-300 text-slate-400 hover:bg-slate-50"}`}>✗</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 p-6 text-center dark:border-emerald-800 dark:bg-emerald-950/20">
        <Camera className="mx-auto h-10 w-10 text-emerald-600" />
        <h2 className="mt-2 text-lg font-bold text-slate-900 dark:text-slate-100">{t("Σάρωση & οπτικός έλεγχος", "Scan & optical audit")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("Φωτογράφισε συνταγή/κουπόνι/γνωμάτευση — OCR (ελληνικά) + ανάγνωση barcode/QR + αντιστοίχιση με τα δεδομένα σου.", "Photograph prescription/coupon/opinion — Greek OCR + barcode/QR read + matching to your data.")}</p>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple onChange={onPick} className="hidden" />
        <button onClick={() => inputRef.current?.click()} disabled={uploading} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} {t("Λήψη φωτογραφίας", "Take photo")}
        </button>
      </div>

      {(locals.length > 0 || serverOnly.length > 0) && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Optical Audit — ουρά", "Optical Audit — queue")} ({(queue.data?.items ?? []).length})</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {locals.map((l) => <Card key={l.scan_id} id={l.scan_id} scan={byId.get(l.scan_id)} preview={l.preview} />)}
            {serverOnly.map((s) => <Card key={s.scan_id} id={s.scan_id} scan={s} />)}
          </div>
        </div>
      )}

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60">
        🔒 {t("Οι εικόνες αποθηκεύονται στη δική μας υποδομή (GridFS) — δεν φεύγουν σε τρίτους. OCR: Tesseract (ελληνικά), barcode/QR: zbar.", "Images stored on our own infrastructure (GridFS) — never sent to third parties. OCR: Tesseract (Greek), barcode/QR: zbar.")}
      </p>

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
