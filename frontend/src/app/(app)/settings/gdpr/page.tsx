"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { appConfirm } from "@/store/dialogStore";
import { toastError, toastSuccess } from "@/store/toastStore";
import { downloadGdprPdf, downloadJson } from "@/lib/gdprExport";

type DataCat = {
  category: string; fields: string; purpose: string; legal_basis: string; retention: string;
};
type Subject = { id: string; name?: string | null; age_group?: string; phone?: string; email?: string; erased?: boolean };
type ConsentEvent = { channel: string; status: string; at?: string; source?: string };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800";
const btn = "rounded-lg px-3 py-1.5 text-sm font-medium";

export default function GdprPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [sel, setSel] = useState<Subject | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

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
    onSuccess: () => { toastSuccess("Τα στοιχεία διορθώθηκαν."); setForm({}); },
    onError: () => toastError("Αποτυχία διόρθωσης."),
  });
  const consent = useMutation({
    mutationFn: (v: { channel: string; status: string }) =>
      api(`/gdpr/consents/${sel!.id}`, { method: "POST", body: JSON.stringify({ ...v, source: "pharmacist_ui" }) }),
    onSuccess: () => { toastSuccess("Καταγράφηκε η συγκατάθεση."); qc.invalidateQueries({ queryKey: ["gdpr", "consents", sel?.id] }); },
    onError: () => toastError("Αποτυχία καταγραφής."),
  });
  const restrict = useMutation({
    mutationFn: (v: { restrict?: boolean; object_marketing?: boolean }) =>
      api(`/gdpr/restrict/${sel!.id}`, { method: "POST", body: JSON.stringify(v) }),
    onSuccess: () => { toastSuccess("Εφαρμόστηκε."); qc.invalidateQueries({ queryKey: ["gdpr", "consents", sel?.id] }); },
    onError: () => toastError("Αποτυχία."),
  });

  async function doExport(kind: "json" | "pdf") {
    if (!sel) return;
    setBusy(true);
    try {
      const bundle = await api<Record<string, unknown>>(`/gdpr/export/${sel.id}`);
      const fn = `rxvision-gdpr-${sel.id}`;
      if (kind === "json") downloadJson(fn, bundle);
      else await downloadGdprPdf(fn, bundle);
      toastSuccess("Η εξαγωγή ολοκληρώθηκε.");
    } catch {
      toastError("Αποτυχία εξαγωγής.");
    } finally {
      setBusy(false);
    }
  }

  async function doErase() {
    if (!sel) return;
    const ok = await appConfirm(
      "Διαγραφή/ανωνυμοποίηση των προσωπικών στοιχείων του υποκειμένου; Αφαιρούνται όνομα/ΑΜΚΑ & στοιχεία επικοινωνίας· τα κλινικά αρχεία συνταγών διατηρούνται κατά νόμο (νόμιμη διατήρηση).",
      { title: "Δικαίωμα στη λήθη (Άρθρο 17)", danger: true, confirmText: "Διαγραφή" },
    );
    if (!ok) return;
    try {
      await api(`/gdpr/erase/${sel.id}`, { method: "POST", body: JSON.stringify({ confirm: true, reason: reason || null }) });
      toastSuccess("Ολοκληρώθηκε η ανωνυμοποίηση.");
      qc.invalidateQueries({ queryKey: ["gdpr"] });
      setSel(null); setReason("");
    } catch {
      toastError("Αποτυχία διαγραφής.");
    }
  }

  return (
    <div className="space-y-6">
      {/* Data categories + retention */}
      <PanelCard title="Κατηγορίες δεδομένων & διατήρηση">
        <div className="overflow-x-auto px-5 pb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-2 pr-3">Κατηγορία</th><th className="py-2 pr-3">Πεδία</th>
                <th className="py-2 pr-3">Νομική βάση</th><th className="py-2">Διατήρηση</th>
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

      {/* Subject lookup + DSAR tools */}
      <PanelCard title="Δικαιώματα υποκειμένου (DSAR)">
        <div className="space-y-4 px-5 pb-5">
          <form
            onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); setSel(null); }}
            className="flex gap-2"
          >
            <input className={inp} placeholder="Αναζήτηση με όνομα, τηλέφωνο ή email…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit" className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>Αναζήτηση</button>
          </form>

          {search.isFetching && <p className="text-sm text-slate-400">Αναζήτηση…</p>}
          {search.data && search.data.results.length === 0 && submitted && (
            <p className="text-sm text-slate-400">Δεν βρέθηκαν αποτελέσματα.</p>
          )}
          {!sel && search.data && search.data.results.length > 0 && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {search.data.results.map((r) => (
                <li key={r.id}>
                  <button onClick={() => { setSel(r); setForm({}); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                    <span>{r.name || "(χωρίς όνομα)"} {r.erased && <em className="text-amber-600">— διεγραμμένο</em>}</span>
                    <span className="text-slate-400">{r.phone || r.email || r.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {sel && (
            <div className="space-y-5 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div className="font-medium text-slate-800 dark:text-slate-200">{sel.name || "(χωρίς όνομα)"} <span className="text-xs text-slate-400">#{sel.id}</span></div>
                <button onClick={() => setSel(null)} className="text-sm text-slate-400 hover:text-slate-600">← Πίσω</button>
              </div>

              {/* Access / portability */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">Πρόσβαση & φορητότητα (Άρθρο 15/20)</h4>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => doExport("json")} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600 disabled:opacity-50`}>Εξαγωγή JSON</button>
                  <button disabled={busy} onClick={() => doExport("pdf")} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600 disabled:opacity-50`}>Εξαγωγή PDF</button>
                </div>
              </section>

              {/* Rectification */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">Διόρθωση στοιχείων (Άρθρο 16)</h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(["phone", "mobile", "email", "address", "city", "postal_code"] as const).map((f) => (
                    <input key={f} className={inp} placeholder={f} value={form[f] ?? ""} onChange={(e) => setForm((s) => ({ ...s, [f]: e.target.value }))} />
                  ))}
                </div>
                <button
                  disabled={rectify.isPending || Object.keys(form).length === 0}
                  onClick={() => rectify.mutate()}
                  className={`${btn} mt-2 bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50`}
                >Αποθήκευση διόρθωσης</button>
              </section>

              {/* Consent */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">Συγκατάθεση επικοινωνίας (Άρθρο 7/21)</h4>
                <p className="mb-2 text-xs text-slate-500">
                  Τρέχουσα: email={consents.data?.current?.email ?? consents.data?.current?.all ?? "—"} · sms={consents.data?.current?.sms ?? consents.data?.current?.all ?? "—"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(["email", "sms"] as const).map((ch) => (
                    <span key={ch} className="inline-flex gap-1">
                      <button onClick={() => consent.mutate({ channel: ch, status: "granted" })} className={`${btn} border border-emerald-300 text-emerald-700 hover:bg-emerald-50`}>{ch}: συγκατάθεση</button>
                      <button onClick={() => consent.mutate({ channel: ch, status: "withdrawn" })} className={`${btn} border border-amber-300 text-amber-700 hover:bg-amber-50`}>{ch}: ανάκληση</button>
                    </span>
                  ))}
                </div>
              </section>

              {/* Restrict / object */}
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">Περιορισμός & εναντίωση (Άρθρο 18/21)</h4>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => restrict.mutate({ restrict: true })} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600`}>Περιορισμός επεξεργασίας</button>
                  <button onClick={() => restrict.mutate({ object_marketing: true })} className={`${btn} border border-slate-300 hover:bg-slate-50 dark:border-slate-600`}>Εναντίωση στο marketing</button>
                </div>
              </section>

              {/* Erasure */}
              <section className="rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
                <h4 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">Δικαίωμα στη λήθη (Άρθρο 17)</h4>
                <p className="mb-2 text-xs text-slate-500">Αφαιρεί όνομα/ΑΜΚΑ & στοιχεία επικοινωνίας. Τα κλινικά αρχεία διατηρούνται κατά τη φαρμακευτική νομοθεσία.</p>
                <input className={`${inp} mb-2`} placeholder="Αιτιολογία (προαιρετικό)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button onClick={doErase} className={`${btn} bg-red-600 text-white hover:bg-red-700`}>Διαγραφή / ανωνυμοποίηση</button>
              </section>
            </div>
          )}
        </div>
      </PanelCard>
    </div>
  );
}
