"use client";

import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, CheckCircle2, Loader2, X, QrCode, AlertTriangle, Link2 } from "lucide-react";
import { api, apiUpload } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Scan = {
  scan_id: string; filename?: string; status: string; optical_risk?: number | null; band?: string | null;
  flags?: string[]; matched?: string | null; barcode?: string | null; quality?: number | null;
  signature?: boolean | null; stamp?: boolean | null;
};
type Local = { scan_id: string; preview: string };

const BAND: Record<string, { cls: string; el: string; en: string }> = {
  ok: { cls: "bg-emerald-100 text-emerald-700", el: "OK", en: "OK" },
  needs_review: { cls: "bg-amber-100 text-amber-700", el: "Προς έλεγχο", en: "Needs review" },
  high_risk: { cls: "bg-rose-100 text-rose-700", el: "Υψηλό ρίσκο", en: "High risk" },
};
const FLAG: Record<string, { el: string; en: string }> = {
  missing_coupon: { el: "Λείπει κουπόνι/QR", en: "Missing coupon/QR" },
  data_mismatch: { el: "Ασυμφωνία δεδομένων", en: "Data mismatch" },
  image_quality: { el: "Κακή ποιότητα εικόνας", en: "Poor image quality" },
  low_text: { el: "Ελάχιστο κείμενο", en: "Low text" },
  ocr_failed: { el: "Αποτυχία OCR", en: "OCR failed" },
  missing_signature: { el: "Πιθανή έλλειψη υπογραφής", en: "Possible missing signature" },
  missing_stamp: { el: "Πιθανή έλλειψη σφραγίδας", en: "Possible missing stamp" },
};

export default function OpticalAuditPage() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [locals, setLocals] = useState<Local[]>([]);
  const [uploading, setUploading] = useState(false);

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

  // merge: local previews first, then server scans not in locals
  const localIds = new Set(locals.map((l) => l.scan_id));
  const serverOnly = (queue.data?.items ?? []).filter((s) => !localIds.has(s.scan_id));

  function Card({ scan, preview }: { scan?: Scan; preview?: string }) {
    const done = scan?.status === "done";
    const band = scan?.band ? BAND[scan.band] : null;
    return (
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="relative aspect-[3/4] bg-slate-100 dark:bg-slate-800">
          {preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={preview} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-slate-300"><QrCode className="h-8 w-8" /></div>}
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white">
            {done ? <CheckCircle2 className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />} {done ? "OCR" : t("ανάλυση…", "analyzing…")}
          </span>
          {band && <span className={`absolute right-1.5 top-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${band.cls}`}>{t(band.el, band.en)}{scan?.optical_risk != null ? ` ${scan.optical_risk}` : ""}</span>}
        </div>
        <div className="space-y-1 p-2 text-xs">
          {scan?.barcode && <div className="flex items-center gap-1 font-mono text-slate-600 dark:text-slate-300"><QrCode className="h-3 w-3" /> {scan.barcode}</div>}
          {scan?.matched ? <div className="flex items-center gap-1 text-emerald-600"><Link2 className="h-3 w-3" /> {t("Ταυτοποιήθηκε", "Matched")}</div>
            : done && scan?.barcode ? <div className="flex items-center gap-1 text-rose-600"><AlertTriangle className="h-3 w-3" /> {t("Χωρίς αντιστοίχιση", "No match")}</div> : null}
          {done && (
            <div className="flex gap-2 text-[10px] font-medium">
              <span className={scan?.signature ? "text-emerald-600" : "text-rose-500"}>{scan?.signature ? "✓" : "✗"} {t("Υπογραφή", "Signature")}</span>
              <span className={scan?.stamp ? "text-emerald-600" : "text-rose-500"}>{scan?.stamp ? "✓" : "✗"} {t("Σφραγίδα", "Stamp")}</span>
            </div>
          )}
          {!!scan?.flags?.length && <div className="flex flex-wrap gap-1">{scan.flags.map((f) => <span key={f} className="rounded bg-rose-50 px-1.5 py-0.5 text-[9px] font-medium text-rose-600 dark:bg-rose-950/40">{t(FLAG[f]?.el ?? f, FLAG[f]?.en ?? f)}</span>)}</div>}
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
            {locals.map((l) => <Card key={l.scan_id} scan={byId.get(l.scan_id)} preview={l.preview} />)}
            {serverOnly.map((s) => <Card key={s.scan_id} scan={s} />)}
          </div>
        </div>
      )}

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60">
        🔒 {t("Οι εικόνες αποθηκεύονται στη δική μας υποδομή (GridFS) — δεν φεύγουν σε τρίτους. OCR: Tesseract (ελληνικά), barcode/QR: zbar.", "Images stored on our own infrastructure (GridFS) — never sent to third parties. OCR: Tesseract (Greek), barcode/QR: zbar.")}
      </p>
    </div>
  );
}
