"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Search, DownloadCloud, Loader2, Pencil, Phone, Mail } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Row = {
  patient_id: string; name: string; email: string | null; mobile: string | null;
  source: string | null; verified: boolean; contact_updated_at: string | null; marketing_consent: boolean;
};
type Res = { items: Row[]; total: number; limit: number; skip: number };

const ddmmyyyy = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

const PAGE = 50;

export default function VerifyContactsPage() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [skip, setSkip] = useState(0);

  const query = useQuery({
    queryKey: ["needs-confirmation", term, skip],
    queryFn: () => api<Res>(`/patients/contacts/needs-confirmation?limit=${PAGE}&skip=${skip}${term ? `&q=${encodeURIComponent(term)}` : ""}`),
  });

  const pull = useMutation({
    mutationFn: (pid: string) => api(`/patients/${encodeURIComponent(pid)}/contact/from-hdika`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["needs-confirmation"] }),
  });

  // Μαζικό ΗΔΥΚΑ backfill (μόνο όσοι λείπουν στοιχεία) — πρόοδος με polling όσο τρέχει.
  type Job = { status?: string; total?: number; done?: number; filled?: number; note?: string };
  const job = useQuery({
    queryKey: ["bulk-hdika"],
    queryFn: () => api<Job>("/patients/contacts/bulk-hdika"),
    refetchInterval: (query) => (["running", "queued"].includes((query.state.data as Job)?.status || "") ? 3000 : false),
  });
  const running = ["running", "queued"].includes(job.data?.status || "");
  const startBulk = useMutation({
    mutationFn: () => api("/patients/contacts/bulk-hdika", { method: "POST" }),
    onSuccess: () => { job.refetch(); qc.invalidateQueries({ queryKey: ["needs-confirmation"] }); },
  });

  const submit = (e: React.FormEvent) => { e.preventDefault(); setSkip(0); setTerm(q.trim()); };

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg"><ShieldAlert className="h-6 w-6" /></span>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Στοιχεία που θέλουν επιβεβαίωση", "Contacts needing confirmation")}</h1>
            <p className="text-xs text-slate-500">{t("Πελάτες με στοιχεία μόνο από ΗΔΥΚΑ, ανεπιβεβαίωτα ή παλαιότερα των 12 μηνών.", "Patients with ΗΔΥΚΑ-only, unconfirmed, or 12-month-stale details.")}</p>
          </div>
        </div>

        {/* Μαζική αρχικοποίηση από ΗΔΥΚΑ — μόνο όσοι λείπουν στοιχεία, background & throttled */}
        <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-800 dark:bg-brand-950/30">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <DownloadCloud className="mt-0.5 h-5 w-5 text-brand-600" />
              <div>
                <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{t("Αρχικοποίηση από ΗΔΥΚΑ", "Initialize from ΗΔΥΚΑ")}</div>
                <p className="text-xs text-slate-500">{t("Αντλεί στοιχεία μόνο για όσους πελάτες λείπουν εντελώς email & κινητό. Αργά & με ασφάλεια στο παρασκήνιο (χωρίς συγκατάθεση — μένουν ανεπιβεβαίωτα).", "Fetches details only for patients missing both email & mobile. Slow & safe in the background (no consent — stays unconfirmed).")}</p>
              </div>
            </div>
            <button onClick={() => startBulk.mutate()} disabled={running || startBulk.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {running || startBulk.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
              {running ? t("Σε εξέλιξη…", "Running…") : t("Έναρξη", "Start")}
            </button>
          </div>
          {job.data && job.data.status !== "idle" && (
            <div className="mt-3">
              {running && (job.data.total || 0) > 0 && (
                <div className="h-2 w-full overflow-hidden rounded-full bg-brand-100 dark:bg-brand-900">
                  <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${Math.min(100, Math.round(((job.data.done || 0) / (job.data.total || 1)) * 100))}%` }} />
                </div>
              )}
              <div className="mt-1.5 text-xs text-slate-500">
                {job.data.status === "running" && t("Επεξεργασία", "Processing")}
                {job.data.status === "queued" && t("Σε ουρά…", "Queued…")}
                {job.data.status === "done" && `✓ ${t("Ολοκληρώθηκε", "Completed")}`}
                {job.data.status === "paused" && `⏸ ${t("Παύση — δες τη Διασύνδεση ΗΔΥΚΑ", "Paused — check ΗΔΥΚΑ connection")}`}
                {job.data.status === "error" && `⚠ ${t("Σφάλμα", "Error")}`}
                {(job.data.total || 0) > 0 && `: ${job.data.done || 0}/${job.data.total} · ${t("συμπληρώθηκαν", "filled")}: ${job.data.filled || 0}`}
              </div>
            </div>
          )}
        </div>

        <form onSubmit={submit} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση με όνομα…", "Search by name…")}
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
          </div>
          <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">{t("Αναζήτηση", "Search")}</button>
        </form>

        <QueryState isLoading={query.isLoading} isError={query.isError} onRetry={() => query.refetch()}>
          {query.data && (
            <>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{t("Σύνολο", "Total")}: <b className="text-slate-800 dark:text-slate-100">{query.data.total.toLocaleString("el-GR")}</b></span>
                {query.data.total > PAGE && (
                  <div className="flex items-center gap-1">
                    <button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))} className="rounded-lg border border-slate-200 px-2 py-1 disabled:opacity-40 dark:border-slate-700">←</button>
                    <span>{Math.floor(skip / PAGE) + 1} / {Math.ceil(query.data.total / PAGE)}</span>
                    <button disabled={skip + PAGE >= query.data.total} onClick={() => setSkip(skip + PAGE)} className="rounded-lg border border-slate-200 px-2 py-1 disabled:opacity-40 dark:border-slate-700">→</button>
                  </div>
                )}
              </div>

              {query.data.items.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900">
                  {t("Όλα τα στοιχεία είναι επιβεβαιωμένα 🎉", "All contacts are confirmed 🎉")}
                </div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-400 dark:bg-slate-800/50">
                      <tr>
                        <th className="px-4 py-2 font-semibold">{t("Πελάτης", "Patient")}</th>
                        <th className="px-4 py-2 font-semibold">{t("Στοιχεία", "Details")}</th>
                        <th className="px-4 py-2 font-semibold">{t("Πηγή", "Source")}</th>
                        <th className="px-4 py-2 font-semibold">{t("Ενημέρωση", "Updated")}</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {query.data.items.map((r) => (
                        <tr key={r.patient_id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                          <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">{r.name}</td>
                          <td className="px-4 py-2.5 text-slate-500">
                            <div className="flex flex-col gap-0.5">
                              {r.mobile && <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 text-slate-400" />{r.mobile}</span>}
                              {r.email && <span className="inline-flex items-center gap-1.5"><Mail className="h-3.5 w-3.5 text-slate-400" />{r.email}</span>}
                              {!r.mobile && !r.email && <span className="text-slate-300">{t("— λείπουν —", "— missing —")}</span>}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.source === "idyka" ? "bg-amber-100 text-amber-700" : r.source ? "bg-slate-100 text-slate-600" : "bg-slate-100 text-slate-400"}`}>
                              {r.source === "idyka" ? t("Μόνο ΗΔΥΚΑ", "ΗΔΥΚΑ-only") : r.source === "pharmacist" ? t("Φαρμακείο", "Pharmacy") : r.source === "patient" ? t("Πελάτης", "Patient") : t("Κανένα", "None")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-slate-500">{ddmmyyyy(r.contact_updated_at) || "—"}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1.5">
                              <button onClick={() => pull.mutate(r.patient_id)} disabled={pull.isPending}
                                title={t("Άντληση από ΗΔΥΚΑ", "Fetch from ΗΔΥΚΑ")}
                                className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300">
                                {pull.isPending && pull.variables === r.patient_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />} ΗΔΥΚΑ
                              </button>
                              <button onClick={() => router.push(`/patients/${r.patient_id}`)}
                                title={t("Επεξεργασία & επιβεβαίωση", "Edit & confirm")}
                                className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700">
                                <Pencil className="h-3.5 w-3.5" /> {t("Επιβεβαίωση", "Confirm")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </QueryState>
      </div>
    </ModuleGuard>
  );
}
