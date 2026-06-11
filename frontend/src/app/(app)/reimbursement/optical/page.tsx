"use client";

import { useState, useRef } from "react";
import { Camera, ScanLine, QrCode, FileText, Stamp, CheckCircle2, X } from "lucide-react";
import { useT } from "@/store/prefStore";

type Shot = { url: string; name: string };

export default function OpticalAuditPage() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setShots((s) => [...files.map((f) => ({ url: URL.createObjectURL(f), name: f.name })), ...s]);
    e.target.value = "";
  }

  const pipeline = [
    { icon: ScanLine, el: "Επεξεργασία εικόνας", en: "Image processing", d: t("auto crop · deskew · contrast · blur detection", "auto crop · deskew · contrast · blur detection") },
    { icon: FileText, el: "OCR & αναγνώριση", en: "OCR & recognition", d: t("αρ. συνταγής · φάρμακα · ημ/νία · ταμείο", "Rx no · meds · date · fund") },
    { icon: QrCode, el: "QR & κουπόνια", en: "QR & coupons", d: t("QR/barcode · κουπόνι σωστό; · ευανάγνωστο;", "QR/barcode · coupon valid? · readable?") },
    { icon: Stamp, el: "Οπτική συμμόρφωση", en: "Visual compliance", d: t("υπογραφές · σφραγίδες · δικαιολογητικά", "signatures · stamps · documents") },
    { icon: CheckCircle2, el: "Data matching", en: "Data matching", d: t("OCR vs δεδομένα RxVision → optical risk score", "OCR vs RxVision data → optical risk score") },
  ];

  return (
    <div className="space-y-6">
      {/* capture */}
      <div className="rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 p-6 text-center dark:border-emerald-800 dark:bg-emerald-950/20">
        <Camera className="mx-auto h-10 w-10 text-emerald-600" />
        <h2 className="mt-2 text-lg font-bold text-slate-900 dark:text-slate-100">{t("Σάρωση συνταγής από κινητό", "Scan prescription from mobile")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("Φωτογράφισε συνταγή, γνωμάτευση, κουπόνια ή δικαιολογητικά. Android · iPhone · tablet.", "Photograph the prescription, opinion, coupons or documents. Android · iPhone · tablet.")}</p>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple onChange={onPick} className="hidden" />
        <button onClick={() => inputRef.current?.click()} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">
          <Camera className="h-4 w-4" /> {t("Λήψη φωτογραφίας", "Take photo")}
        </button>
      </div>

      {!!shots.length && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Λήψεις", "Captures")} ({shots.length})</h3>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {shots.map((s, i) => (
              <div key={i} className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={s.name} className="h-full w-full object-cover" />
                <button onClick={() => setShots((arr) => arr.filter((_, j) => j !== i))} className="absolute right-1 top-1 rounded-full bg-black/50 p-1 text-white opacity-0 group-hover:opacity-100"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {t("Η αποθήκευση & αυτόματη ανάλυση (OCR/QR/οπτικός έλεγχος) είναι το επόμενο βήμα ενσωμάτωσης — δες το pipeline παρακάτω.", "Storage & automatic analysis (OCR/QR/visual check) is the next integration step — see the pipeline below.")}
          </p>
        </div>
      )}

      {/* pipeline roadmap */}
      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{t("Pipeline οπτικού ελέγχου (αρχιτεκτονική)", "Optical audit pipeline (architecture)")}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {pipeline.map((p, i) => {
            const Icon = p.icon;
            return (
              <div key={i} className="rx-card p-4">
                <div className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950"><Icon className="h-4 w-4" /></span><span className="text-[10px] font-bold text-slate-300">{i + 1}</span></div>
                <h4 className="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-100">{t(p.el, p.en)}</h4>
                <p className="mt-0.5 text-xs text-slate-500">{p.d}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
