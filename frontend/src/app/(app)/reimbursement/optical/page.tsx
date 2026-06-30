"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, CheckCircle2, Loader2, X, QrCode, AlertTriangle, Link2, Trash2, Sparkles, User, Stethoscope, ChevronDown } from "lucide-react";
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

type Coupons = { meds: number; qr: number; eof: number; intangible?: boolean | null; items?: { name: string | null; type: string | null; qty?: number | null }[] };
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
  scan_id: string; filename?: string; status: string; optical_risk?: number | null; band?: string | null;
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

export default function OpticalAuditPage() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [locals, setLocals] = useState<Local[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

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

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setUploading(true);
    for (const f of files) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        const r = await apiUpload<{ scan_id: string }>("/reimbursement/scans", fd);
        setLocals((s) => [{ scan_id: r.scan_id, preview: URL.createObjectURL(f) },...s]);
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

  function YesNo({ on, label }: { on?: boolean | null; label: string }) {
    return (
      <span className={`inline-flex items-center gap-0.5 ${on === true ? "text-emerald-600" : on === false ? "text-rose-500" : "text-slate-400"}`}>
        {on === true ? "✓" : on === false ? "✗" : "·"} {label}
      </span>
    );
  }

  function Card({ id, scan, preview }: { id: string; scan?: Scan; preview?: string }) {
    const done = scan?.status === "done";
    const band = scan?.band ? BAND[scan.band] : null;
    const verdict = scan?.auto_verdict ? VERDICT[scan.auto_verdict] : null;
    const a = scan?.ai;
    const findings = scan?.ai_findings ?? [];
    return (
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="relative aspect-[3/4] bg-slate-100 dark:bg-slate-800">
          {preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={preview} alt="" onClick={() => setLightbox(preview)} className="h-full w-full cursor-zoom-in object-cover" /> : <ScanImage scanId={id} onOpen={setLightbox} />}
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
          <Tooltip label={t("Διαγραφή", "Delete")}><button onClick={() => del(id)} className="absolute bottom-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white opacity-80 transition hover:bg-rose-600 hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></Tooltip>
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
                  <summary className="cursor-pointer text-slate-400">+{findings.length - 3} {t("ακόμη", "more")}</summary>
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
              <summary className="flex cursor-pointer items-center gap-1 text-[10px] text-violet-600"><ChevronDown className="h-3 w-3 transition group-open:rotate-180" /> {t("Ανάλυση AI", "AI reading")}</summary>
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

          {/* authoritative coupons (from our ΗΔΥΚΑ data) */}
          {done && scan?.coupons && scan.coupons.meds > 0 && (() => {
            const c = scan.coupons!; const ok = c.qr + c.eof >= c.meds;
            return (
              <div className="flex flex-wrap items-center gap-1 text-[10px] font-medium">
                <span className={ok ? "text-emerald-600" : "text-amber-600"}>{ok ? "✓" : "•"} {c.meds} {t("καταχ.", "rec.")}</span>
                {c.qr > 0 && <span className="rounded bg-sky-50 px-1 text-sky-700 dark:bg-sky-950/40">{c.qr} QR</span>}
                {c.eof > 0 && <span className="rounded bg-amber-50 px-1 text-amber-700 dark:bg-amber-950/40">{c.eof} ΕΟΦ</span>}
                {c.intangible && <span className="rounded bg-violet-50 px-1 text-violet-700 dark:bg-violet-950/40">{t("άυλη", "paperless")}</span>}
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
        {aiOn ? <Sparkles className="mx-auto h-10 w-10 text-violet-600" /> : <Camera className="mx-auto h-10 w-10 text-emerald-600" />}
        <h2 className="mt-2 text-lg font-bold text-slate-900 dark:text-slate-100">{aiOn ? t("Prescriptor — AI ανάγνωση συνταγών", "Prescriptor — AI reads your prescriptions") : t("Σάρωση & οπτικός έλεγχος", "Scan & optical audit")}</h2>
        <p className="mt-1 text-sm text-slate-500">{aiOn
          ? t("Φωτογράφισε τη συνταγή — το AI διαβάζει ασφαλισμένο, ιατρό, φάρμακα & ποσότητες, κουπόνια, υπογραφές & σφραγίδες, εντοπίζει ασυνέπειες και τις διασταυρώνει αυτόματα με τα δεδομένα ΗΔΥΚΑ. Παίρνεις έτοιμο πόρισμα.",
              "Photograph the prescription — the AI reads insured, doctor, drugs & quantities, coupons, signatures & stamps, spots inconsistencies and cross-checks them against your ΗΔΥΚΑ data automatically. You get a ready verdict.")
          : t("Φωτογράφισε συνταγή/κουπόνι/γνωμάτευση — OCR (ελληνικά) + ανάγνωση barcode/QR + αντιστοίχιση με τα δεδομένα σου.", "Photograph prescription/coupon/opinion — Greek OCR + barcode/QR read + matching to your data.")}</p>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple onChange={onPick} className="hidden" />
        <button onClick={() => inputRef.current?.click()} disabled={uploading} className={`mt-4 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${aiOn ? "bg-violet-600 hover:bg-violet-700" : "bg-emerald-600 hover:bg-emerald-700"}`}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} {t("Λήψη φωτογραφίας", "Take photo")}
        </button>
      </div>

      {(locals.length > 0 || serverOnly.length > 0) && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Optical Audit — ουρά", "Optical Audit — queue")} ({(queue.data?.items ?? []).length})</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {locals.map((l) => <Card key={l.scan_id} id={l.scan_id} scan={byId.get(l.scan_id)} preview={l.preview} />)}
            {serverOnly.map((s) => <Card key={s.scan_id} id={s.scan_id} scan={s} />)}
          </div>
        </div>
      )}

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60">
        {aiOn
          ? <>🔒 {t("Οι εικόνες αποθηκεύονται στη δική μας υποδομή (GridFS). Με ενεργό το Prescriptor, η εικόνα αναλύεται από το AI (Claude) βάσει της σύμβασης/συγκατάθεσης του φαρμακείου. Απενεργοποιείται από τις ρυθμίσεις.", "Images are stored on our own infrastructure (GridFS). With Prescriptor enabled, the image is analyzed by the AI (Claude) under the pharmacy's agreement/consent. Can be turned off in settings.")}</>
          : <>🔒 {t("Οι εικόνες αποθηκεύονται στη δική μας υποδομή (GridFS) — δεν φεύγουν σε τρίτους. OCR: Tesseract (ελληνικά), barcode/QR: zbar.", "Images stored on our own infrastructure (GridFS) — never sent to third parties. OCR: Tesseract (Greek), barcode/QR: zbar.")}</>}
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
