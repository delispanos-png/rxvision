"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { appConfirm } from "@/store/dialogStore";
import { toastError, toastSuccess } from "@/store/toastStore";
import { downloadGdprPdf, downloadJson } from "@/lib/gdprExport";
import { useT } from "@/store/prefStore";

type DataCat = {
  category: string; fields: string; purpose: string; legal_basis: string; retention: string;
};
type Subject = { id: string; name?: string | null; age_group?: string; phone?: string; email?: string; erased?: boolean };
type ConsentEvent = { channel: string; status: string; at?: string; source?: string };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800";
const btn = "rounded-lg px-3 py-1.5 text-sm font-medium";

export default function GdprPage() {
  const t = useT();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [sel, setSel] = useState<Subject | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [retMonths, setRetMonths] = useState("");

  const dataMap = useQuery({ queryKey: ["gdpr", "data-map"], queryFn: () => api<{ categories: DataCat[] }>("/gdpr/data-map"), retry: false });
  const search = useQuery({
    queryKey: ["gdpr", "search", submitted],
    queryFn: () => api<{ results: Subject[] }>(`/gdpr/search?q=${encodeURIComponent(submitted)}`),
    enabled: submitted.length >= 2, retry: false,
  });
  const consents = useQuery({
    queryKey: ["gdpr", "consents", sel?.id],
    queryFn: () => api<{ current: Record<string, string>; history: ConsentEvent[] }>(`/gdpr/consents/${sel!.id}`),
    enabled: !!sel, retry: false,
  });

  const rectify = useMutation({
    mutationFn: () => api(`/gdpr/rectify/${sel!.id}`, { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => { toastSuccess(t("Τα στοιχεία διορθώθηκαν.", "Details corrected.")); setForm({}); },
    onError: () => toastError(t("Αποτυχία διόρθωσης.", "Correction failed.")),
  });
  const consent = useMutation({
    mutationFn: (v: { channel: string; status: string }) =>
      api(`/gdpr/consents/${sel!.id}`, { method: "POST", body: JSON.stringify({...v, source: "pharmacist_ui" }) }),
    onSuccess: () => { toastSuccess(t("Καταγράφηκε η συγκατάθεση.", "Consent recorded.")); qc.invalidateQueries({ queryKey: ["gdpr", "consents", sel?.id] }); },
    onError: () => toastError(t("Αποτυχία καταγραφής.", "Recording failed.")),
  });
  const restrict = useMutation({
    mutationFn: (v: { restrict?: boolean; object_marketing?: boolean }) =>
      api(`/gdpr/restrict/${sel!.id}`, { method: "POST", body: JSON.stringify(v) }),
    onSuccess: () => { toastSuccess(t("Εφαρμόστηκε.", "Applied.")); qc.invalidateQueries({ queryKey: ["gdpr", "consents", sel?.id] }); },
    onError: () => toastError(t("Αποτυχία.", "Failed.")),
  });

  const retention = useQuery({ queryKey: ["gdpr", "retention"], queryFn: () => api<{ retention_months: number | null }>("/gdpr/retention"), retry: false });
  const saveRetention = useMutation({
    mutationFn: (m: number) => api("/gdpr/retention", { method: "PUT", body: JSON.stringify({ retention_months: m }) }),
    onSuccess: () => { toastSuccess(t("Η περίοδος διατήρησης αποθηκεύτηκε.", "Retention period saved.")); setRetMonths(""); qc.invalidateQueries({ queryKey: ["gdpr", "retention"] }); },
    onError: () => toastError(t("Μη έγκυρη περίοδος (1–600 μήνες).", "Invalid period (1–600 months).")),
  });

  async function doExport(kind: "json" | "pdf") {
    if (!sel) return;
    setBusy(true);
    try {
      const bundle = await api<Record<string, unknown>>(`/gdpr/export/${sel.id}`);
      const fn = `rxvision-gdpr-${sel.id}`;
      if (kind === "json") downloadJson(fn, bundle);
      else await downloadGdprPdf(fn, bundle);
      toastSuccess(t("Η εξαγωγή ολοκληρώθηκε.", "Export completed."));
    } catch {
      toastError(t("Αποτυχία εξαγωγής.", "Export failed."));
    } finally {
      setBusy(false);
    }
  }

  async function doErase() {
    if (!sel) return;
    const ok = await appConfirm(
      t(
        "Διαγραφή/ανωνυμοποίηση των προσωπικών στοιχείων του υποκειμένου; Αφαιρούνται όνομα/ΑΜΚΑ & στοιχεία επικοινωνίας· τα κλινικά αρχεία συνταγών διατηρούνται κατά νόμο (νόμιμη διατήρηση).",
        "Delete/anonymize the subject's personal details? Name/ΑΜΚΑ & contact details are removed; clinical prescription records are kept by law (legal retention)."
      ),
      { title: t("Δικαίωμα στη λήθη (Άρθρο 17)", "Right to erasure (Article 17)"), danger: true, confirmText: t("Διαγραφή", "Delete") },
    );
    if (!ok) return;
    try {
      await api(`/gdpr/erase/${sel.id}`, { method: "POST", body: JSON.stringify({ confirm: true, reason: reason || null }) });
      toastSuccess(t("Ολοκληρώθηκε η ανωνυμοποίηση.", "Anonymization completed."));
      qc.invalidateQueries({ queryKey: ["gdpr"] });
      setSel(null); setReason("");
    } catch {
      toastError(t("Αποτυχία διαγραφής.", "Deletion failed."));
    }
  }

  return (
    <div className="space-y-6">
      {/* Data categories + retention */}
      <PanelCard title={t("Κατηγορίες δεδομένων & διατήρηση", "Data categories & retention")}>
        <div className="overflow-x-auto px-5 pb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-2 pr-3">{t("Κατηγορία", "Category")}</th><th className="py-2 pr-3">{t("Πεδία", "Fields")}</th>
                <th className="py-2 pr-3">{t("Νομική βάση", "Legal basis")}</th><th className="py-2">{t("Διατήρηση", "Retention")}</th>
              </tr>
            </thead>
            <tbody>
              {(dataMap.data?.categories ?? []).map((c) => (
                <tr key={c.category} className="border-t border-slate-100 dark:border-slate-800 align-top">
                  <td className="py-2 pr-3 font-medium text-slate-800 dark:text-slate-200">{c.category}</td>
                  <td className="py-2 pr-3 text-slate-600 dark:text-slate-400">{c.fields}</td>
                  <td className="py-2 pr-3 text-slate-600 dark:text-slate-400">{c.legal_basis}</td>
                  <td className="py-2 text-slate-600 dark:text-slate-400">{c.retention}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelCard>

      {/* Retention period — the pharmacy (controller) decides */}
      <PanelCard title={t("Περίοδος διατήρησης δεδομένων", "Data retention period")}>
        <div className="space-y-3 px-5 pb-5">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t(
              "Εσείς, ως υπεύθυνος επεξεργασίας, ορίζετε για πόσο διατηρούνται τα δεδομένα σας στο RxVision. Τα κλινικά αρχεία συνταγών διατηρούνται τουλάχιστον όσο επιβάλλει η φαρμακευτική νομοθεσία (νόμιμη διατήρηση)· πέραν αυτού ισχύει η δική σας επιλογή.",
              "You, as the data controller, decide how long your data is kept in RxVision. Clinical prescription records are kept at least as long as pharmaceutical law requires (legal retention); beyond that, your choice applies."
            )}
          </p>
          <p className="text-sm text-slate-500">
            {t("Τρέχουσα ρύθμιση:", "Current setting:")} <strong>{retention.data?.retention_months ? t(`${retention.data.retention_months} μήνες`, `${retention.data.retention_months} months`) : t("δεν έχει οριστεί", "not set")}</strong>
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} max={600}
              className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              placeholder={t("μήνες (1–600)", "months (1–600)")} value={retMonths} onChange={(e) => setRetMonths(e.target.value)}
            />
            <button
              disabled={saveRetention.isPending || !retMonths}
              onClick={() => saveRetention.mutate(parseInt(retMonths, 10))}
              className={`${btn} bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50`}
            >{t("Αποθήκευση", "Save")}</button>
          </div>
        </div>
      </PanelCard>

      {/* Subject lookup + DSAR tools */}
      <PanelCard title={t("Δικαιώματα υποκειμένου (DSAR)", "Data subject rights (DSAR)")}>
        <div className="space-y-4 px-5 pb-5">
          <form
            onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); setSel(null); }}
            className="flex gap-2"
          >
            <input className={inp} placeholder={t("Αναζήτηση με όνομα, τηλέφωνο ή email…", "Search by name, phone or email…")} value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit" className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>{t("Αναζήτηση", "Search")}</button>
          </form>

          {search.isFetching && <p className="text-sm text-slate-400">{t("Αναζήτηση…", "Searching…")}</p>}
          {search.data && search.data.results.length === 0 && submitted && (
            <p className="text-sm text-slate-400">{t("Δεν βρέθηκαν αποτελέσματα.", "No results found.")}</p>
          )}
          {!sel && search.data && search.data.results.length > 0 && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {search.data.results.map((r) => (
                <li key={r.id}>
                  <button onClick={() => { setSel(r); setForm({}); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                    <span>{r.name || t("(χωρίς όνομα)", "(no name)")} {r.erased && <em className="text-amber-600">{t("— διεγραμμένο", "— erased")}</em>}</span>
                    <span className="text-slate-400">{r.phone || r.email || r.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {sel && (
            <div className="space-y-5 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div className="font-medium text-slate-800 dark:text-slate-200">{sel.name || t("(χωρίς όνομα)", "(no name)")} <span className="text-xs text-slate-400">#{sel.id}</span></div>
                <button onClick={() => setSel(null)} className="text-sm text-slate-400 hover:text-slate-600">{t("← Πίσω", "← Back")}</button>
              </div>

              {/* Access / portability */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">{t("Πρόσβαση & φορητότητα (Άρθρο 15/20)", "Access & portability (Article 15/20)")}</h4>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => doExport("json")} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600 disabled:opacity-50`}>{t("Εξαγωγή JSON", "Export JSON")}</button>
                  <button disabled={busy} onClick={() => doExport("pdf")} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600 disabled:opacity-50`}>{t("Εξαγωγή PDF", "Export PDF")}</button>
                </div>
              </section>

              {/* Rectification */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">{t("Διόρθωση στοιχείων (Άρθρο 16)", "Rectification (Article 16)")}</h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(["phone", "mobile", "email", "address", "city", "postal_code"] as const).map((f) => (
                    <input key={f} className={inp} placeholder={f} value={form[f] ?? ""} onChange={(e) => setForm((s) => ({...s, [f]: e.target.value }))} />
                  ))}
                </div>
                <button
                  disabled={rectify.isPending || Object.keys(form).length === 0}
                  onClick={() => rectify.mutate()}
                  className={`${btn} mt-2 bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50`}
                >{t("Αποθήκευση διόρθωσης", "Save correction")}</button>
              </section>

              {/* Consent */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">{t("Συγκατάθεση επικοινωνίας (Άρθρο 7/21)", "Communication consent (Article 7/21)")}</h4>
                <p className="mb-2 text-xs text-slate-500">
                  {t("Τρέχουσα:", "Current:")} email={consents.data?.current?.email ?? consents.data?.current?.all ?? "—"} · sms={consents.data?.current?.sms ?? consents.data?.current?.all ?? "—"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(["email", "sms"] as const).map((ch) => (
                    <span key={ch} className="inline-flex gap-1">
                      <button onClick={() => consent.mutate({ channel: ch, status: "granted" })} className={`${btn} border border-emerald-300 text-emerald-700 hover:bg-emerald-50`}>{ch}: {t("συγκατάθεση", "consent")}</button>
                      <button onClick={() => consent.mutate({ channel: ch, status: "withdrawn" })} className={`${btn} border border-amber-300 text-amber-700 hover:bg-amber-50`}>{ch}: {t("ανάκληση", "withdraw")}</button>
                    </span>
                  ))}
                </div>
              </section>

              {/* Restrict / object */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">{t("Περιορισμός & εναντίωση (Άρθρο 18/21)", "Restriction & objection (Article 18/21)")}</h4>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => restrict.mutate({ restrict: true })} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600`}>{t("Περιορισμός επεξεργασίας", "Restrict processing")}</button>
                  <button onClick={() => restrict.mutate({ object_marketing: true })} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600`}>{t("Εναντίωση στο marketing", "Object to marketing")}</button>
                </div>
              </section>

              {/* Erasure */}
              <section className="rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
                <h4 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">{t("Δικαίωμα στη λήθη (Άρθρο 17)", "Right to erasure (Article 17)")}</h4>
                <p className="mb-2 text-xs text-slate-500">{t("Αφαιρεί όνομα/ΑΜΚΑ & στοιχεία επικοινωνίας. Τα κλινικά αρχεία διατηρούνται κατά τη φαρμακευτική νομοθεσία.", "Removes name/ΑΜΚΑ & contact details. Clinical records are kept under pharmaceutical law.")}</p>
                <input className={`${inp} mb-2`} placeholder={t("Αιτιολογία (προαιρετικό)", "Reason (optional)")} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button onClick={doErase} className={`${btn} bg-red-600 text-white hover:bg-red-700`}>{t("Διαγραφή / ανωνυμοποίηση", "Delete / anonymize")}</button>
              </section>
            </div>
          )}
        </div>
      </PanelCard>
    </div>
  );
}
