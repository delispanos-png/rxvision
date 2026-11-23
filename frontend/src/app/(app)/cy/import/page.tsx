"use client";

/* RxVision Κύπρος — Εισαγωγή XML εκτελέσεων ΓεΣΥ. ΤΡΕΙΣ τρόποι, ΕΝΑΣ importer (backend
   services/cy/importer.py): το ίδιο αρχείο δύο φορές μετράει μία, αρχείο άλλου φαρμακείου απορρίπτεται.
   1) ανέβασμα (εδώ) · 2) αυτόματα από την PharmacyOne (το ενεργοποιεί η RxVision) ·
   3) τοπικός φάκελος του υπολογιστή (lib/cyFolder.ts + components/cy/CyFolderSync). */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CloudDownload, FileUp, FolderSync, Loader2, TriangleAlert } from "lucide-react";
import { ApiError, api, apiUpload, queryKeys } from "@/lib/apiClient";
import { fmtDateTime, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";
import { folderState, folderSupported, forgetFolder, pickFolder, resumeFolder, scanFolder, type FolderState } from "@/lib/cyFolder";

type P1 = { configured: boolean; enabled: boolean; last_ok_at: string | null; last_run_at: string | null;
  last_result: { ok?: boolean; fetched?: number; imported?: number; updated?: number; error?: string } };

function Way({ n, icon: Icon, title, children }: { n: number; icon: typeof FileUp; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{n}</span>
        <Icon className="h-4 w-4 text-indigo-600" />{title}
      </h2>
      {children}
    </section>
  );
}

function PharmacyOneWay() {
  const t = useT();
  const q = useQuery({ queryKey: ["cy", "pharmacyone"], queryFn: () => api<P1>("/cy/pharmacyone") });
  const d = q.data;
  if (!d) return null;
  if (!d.enabled) return (
    <p className="text-sm text-slate-500">{t("Αν το φαρμακείο σου δουλεύει με PharmacyOne, οι εκτελέσεις μπορούν να έρχονται μόνες τους κάθε ώρα, χωρίς κανένα αρχείο. Ζήτησέ το από την υποστήριξη RxVision.",
      "If your pharmacy works with PharmacyOne, dispensings can arrive by themselves every hour, with no files. Ask RxVision support to enable it.")}</p>);
  const r = d.last_result || {};
  return (
    <div className="text-sm text-slate-600 dark:text-slate-300">
      <p className="font-medium text-emerald-700">✓ {t("Ενεργό: οι εκτελέσεις έρχονται μόνες τους κάθε ώρα.", "On: dispensings arrive by themselves every hour.")}</p>
      {d.last_run_at && <p className="mt-1 text-xs text-slate-500">
        {t("Τελευταία λήψη", "Last fetch")}: {fmtDateTime(d.last_run_at)}
        {r.ok === false ? <span className="text-rose-600"> · {t("απέτυχε", "failed")} ({r.error})</span>
          : <> · {fmtNum(r.imported ?? 0)} {t("νέες", "new")}, {fmtNum(r.updated ?? 0)} {t("ενημερώθηκαν", "updated")}</>}
      </p>}
    </div>
  );
}

function FolderWay() {
  const t = useT();
  const { data: me } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<{ tenant_id?: string }>("/auth/me"), retry: false });
  const tid = me?.tenant_id;
  const [st, setSt] = useState<FolderState | null>(null);
  const [busy, setBusy] = useState(false);
  // ΜΟΝΟ στον browser (ο server δεν έχει window → θα έβγαζε άλλο HTML: React #418, 23/11/2026)
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => { setSupported(folderSupported()); }, []);
  const refresh = useCallback(async () => { if (tid) setSt(await folderState(tid)); }, [tid]);
  useEffect(() => {
    refresh();
    window.addEventListener("cy-folder-scanned", refresh);
    return () => window.removeEventListener("cy-folder-scanned", refresh);
  }, [refresh]);
  if (supported === null) return null;
  if (!supported) return (
    <p className="text-sm text-slate-500">{t("Χρειάζεται Google Chrome ή Microsoft Edge στον υπολογιστή.", "Needs Google Chrome or Microsoft Edge on the computer.")}</p>);
  if (!tid) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* ο χρήστης ακύρωσε ή δίκτυο */ }
    await refresh();
    window.dispatchEvent(new Event("cy-folder-changed"));
    setBusy(false);
  };
  const btn = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200";
  return (
    <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
      <p>{t("Δείξε μία φορά τον φάκελο του υπολογιστή όπου κατεβαίνουν τα XML. Όσο το RxVision είναι ανοιχτό, κάθε 10 λεπτά ανεβαίνουν μόνα τους μόνο τα νέα αρχεία.",
        "Point once to the computer folder where the XML files are downloaded. While RxVision is open, only new files are uploaded by themselves every 10 minutes.")}</p>
      {st ? (
        <>
          <p className="font-medium">📁 {st.name} {st.perm === "granted"
            ? <span className="text-emerald-700">· {t("ενεργός", "active")}</span>
            : <span className="text-amber-700">· {t("θέλει ένα κλικ άδειας", "needs one permission click")}</span>}</p>
          {st.last && <p className="text-xs text-slate-500">{t("Τελευταία σάρωση", "Last scan")}: {fmtDateTime(st.last.at)} · {fmtNum(st.last.uploaded)} {t("νέα αρχεία", "new files")}, {fmtNum(st.last.imported)} {t("νέες εκτελέσεις", "new dispensings")}{st.last.failed ? `, ${fmtNum(st.last.failed)} ${t("απορρίφθηκαν", "rejected")}` : ""}</p>}
          <div className="flex flex-wrap gap-2">
            {st.perm !== "granted"
              ? <button disabled={busy} onClick={() => run(() => resumeFolder(tid))} className={btn}>{t("Δώσε άδεια", "Grant access")}</button>
              : <button disabled={busy} onClick={() => run(() => scanFolder(tid))} className={btn}>{busy ? <Loader2 className="inline h-4 w-4 animate-spin" /> : t("Σάρωση τώρα", "Scan now")}</button>}
            <button disabled={busy} onClick={() => run(() => pickFolder(tid))} className={btn}>{t("Άλλος φάκελος", "Change folder")}</button>
            <button disabled={busy} onClick={() => run(() => forgetFolder(tid))} className={btn}>{t("Αποσύνδεση", "Disconnect")}</button>
          </div>
        </>
      ) : (
        <button disabled={busy} onClick={() => run(async () => { await pickFolder(tid); await scanFolder(tid); })}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? <Loader2 className="inline h-4 w-4 animate-spin" /> : t("Σύνδεση φακέλου", "Connect a folder")}
        </button>
      )}
      <p className="text-xs text-slate-400">{t("Διαβάζονται μόνο αρχεία .xml και .zip. Μετά από επανεκκίνηση του browser, ζητείται ένα κλικ άδειας (κανόνας ασφαλείας του browser).",
        "Only .xml and .zip files are read. After the browser restarts, one permission click is needed (a browser security rule).")}</p>
    </div>
  );
}

type Result = { files: number; imported: number; duplicates: number; failed: number;
  errors: { file: string; error: string }[]; provider_id: string | null };

export default function CyImportPage() {
  const t = useT();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    const form = new FormData();
    Array.from(list).forEach((f) => form.append("files", f));
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await apiUpload<Result>("/cy/import", form);
      setRes(r);
      qc.invalidateQueries({ queryKey: ["cy"] });
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: string })?.detail : "";
      setErr(d === "too_large" ? t("Πολύ μεγάλο ανέβασμα — χώρισέ το σε μικρότερα.", "Upload too large — split it.")
        : d || t("Η εισαγωγή απέτυχε — δοκίμασε ξανά.", "Import failed — try again."));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Εισαγωγή XML εκτελέσεων ΓεΣΥ", "Import GHS dispensing XML")}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("Κατέβασε από την πύλη ΓεΣΥ τα XML των εκτελέσεών σου και ανέβασέ τα εδώ — ένα-ένα, πολλά μαζί ή σε ZIP. Αν ανεβάσεις κάτι δεύτερη φορά, δεν θα μετρηθεί διπλό.",
             "Download your dispensing XML files from the GHS portal and upload them here — one, many, or as a ZIP. Uploading the same file twice never double-counts.")}
        </p>
      </header>

      <Way n={1} icon={FileUp} title={t("Ανέβασμα αρχείων", "Upload files")}>
      <button type="button" disabled={busy} onClick={() => input.current?.click()}
        className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-6 py-10 text-slate-600 hover:border-indigo-400 hover:text-indigo-700 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900">
        {busy ? <Loader2 className="h-8 w-8 animate-spin" /> : <FileUp className="h-8 w-8" />}
        <span className="font-medium">{busy ? t("Εισαγωγή…", "Importing…") : t("Επίλεξε αρχεία XML ή ZIP", "Choose XML or ZIP files")}</span>
      </button>
      <input ref={input} type="file" multiple accept=".xml,.zip,application/xml,text/xml,application/zip" className="hidden"
        onChange={(e) => upload(e.target.files)} />
      </Way>

      {err && <div className="flex items-start gap-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-700"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />{err}</div>}

      {res && (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 font-semibold text-emerald-700"><CheckCircle2 className="h-5 w-5" />{t("Η εισαγωγή ολοκληρώθηκε", "Import finished")}</div>
          <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <li><b>{fmtNum(res.files)}</b> {t("αρχεία", "files")}</li>
            <li className="text-emerald-700"><b>{fmtNum(res.imported)}</b> {t("νέες εκτελέσεις", "new dispensings")}</li>
            <li className="text-slate-500"><b>{fmtNum(res.duplicates)}</b> {t("υπήρχαν ήδη", "already there")}</li>
            <li className={res.failed ? "text-rose-700" : "text-slate-500"}><b>{fmtNum(res.failed)}</b> {t("απορρίφθηκαν", "rejected")}</li>
          </ul>
          {res.errors.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              <div className="mb-1 font-semibold">{t("Αρχεία που δεν μπήκαν", "Files not imported")}</div>
              <ul className="space-y-0.5">{res.errors.map((e, i) => <li key={i}><b>{e.file}</b>: {e.error}</li>)}</ul>
            </div>
          )}
          {res.provider_id && <p className="text-xs text-slate-400">{t("Κωδικός φαρμακείου ΓεΣΥ", "GHS pharmacy code")}: {res.provider_id}</p>}
          <Link href="/cy" className="inline-block text-sm font-medium text-indigo-600 hover:underline">{t("Δες το Dashboard →", "See the Dashboard →")}</Link>
        </div>
      )}

      <Way n={2} icon={CloudDownload} title={t("Αυτόματα από την PharmacyOne", "Automatically from PharmacyOne")}><PharmacyOneWay /></Way>
      <Way n={3} icon={FolderSync} title={t("Από φάκελο του υπολογιστή", "From a computer folder")}><FolderWay /></Way>
    </div>
  );
}
