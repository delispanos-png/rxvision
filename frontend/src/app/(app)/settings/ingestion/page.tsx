"use client";

import { useEffect, useRef, useState } from "react";
import { DateInput } from "@/components/ui/DateInput";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Loader2, PlugZap, RefreshCw, ShieldCheck, XCircle, Square, Trash2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { appConfirm } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";
import { fmtDate } from "@/lib/formatters";

type Config = {
  configured: boolean;
  username?: string | null;
  afm?: string | null;
  eopyy_registry?: string | null;
  pharmacy_code?: string | null;
  pharmacy_id?: string | null;
  pharmacy_name?: string | null;
  environment?: string;
  base_url?: string | null;
  has_api_key?: boolean;
  doctor_ip?: string | null;
  client_id?: string | null;
  has_client_secret?: boolean;
  sync_enabled?: boolean;
  sync_interval_minutes?: number;
  history_from?: string | null;
  last_test?: { at: string; ok: boolean; message: string } | null;
  last_sync?: { at: string; status: string; stats: Record<string, number> } | null;
};
type Tenant = { country?: string };
type TestRes = { ok: boolean; mode: string; message: string };
type SyncRes = { status: string; stats: Record<string, number> };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
const inputCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100";

// Επίσημα ΗΔΥΚΑ endpoints ανά περιβάλλον — επιλέγεις περιβάλλον, μπαίνει το URL μόνο του.
const HDIKA_ENDPOINTS: Record<string, string> = {
  test: "https://testeps.e-prescription.gr/pharmapiv2",
  production: "https://eps.e-prescription.gr/pharmapiv2",
};

export default function IngestionSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const tenant = useQuery({ queryKey: ["tenant"], queryFn: () => api<Tenant>("/tenant"), retry: false });
  const cfg = useQuery({ queryKey: ["hdika-config"], queryFn: () => api<Config>("/ingestion/credentials/hdika"), retry: false });
  const [syncing, setSyncing] = useState(false);
  const syncStartRef = useRef(0);
  const jobs = useQuery({
    queryKey: ["ingestion-jobs"],
    queryFn: () => api<{ items: any[] }>("/ingestion/jobs"),
    retry: false,
    // steady poll so the progress bar appears whenever a sync/backfill is running
    // (not only right after the user clicks), and updates the live count.
    refetchInterval: 3000,
  });
  const latestJob = jobs.data?.items?.[0];
  const jobRunning = latestJob?.status === "running";
  const showProgress = syncing || jobRunning;

  // clear the just-clicked flag once our queued sync has finished
  useEffect(() => {
    if (!syncing || !latestJob) return;
    const started = latestJob.started_at ? new Date(latestJob.started_at).getTime() : 0;
    if (latestJob.status !== "running" && started >= syncStartRef.current - 4000) {
      setSyncing(false);
      qc.invalidateQueries({ queryKey: ["hdika-config"] });
    }
  }, [latestJob?.status, latestJob?._id, syncing, qc]);

  const country = (tenant.data?.country || "GR").toUpperCase();
  const c = cfg.data;

  const [f, setF] = useState({
    username: "", password: "", afm: "", eopyy_registry: "", pharmacy_code: "",
    environment: "test", base_url: HDIKA_ENDPOINTS.test, api_key: "", doctor_ip: "", client_id: "", client_secret: "",
    sync_enabled: true, sync_interval_minutes: 15, history_from: "",
  });
  const set = (k: string, v: any) => setF((s) => ({...s, [k]: v }));
  const [customUrl, setCustomUrl] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Επιλογή περιβάλλοντος → αυτόματη συμπλήρωση endpoint (εκτός custom).
  const selectEnv = (env: string) =>
    setF((s) => ({...s, environment: env, base_url: customUrl ? s.base_url : HDIKA_ENDPOINTS[env] }));

  // prefill non-secret fields from saved config
  useEffect(() => {
    if (!c) return;
    const env = c.environment ?? "test";
    const baseUrl = c.base_url || HDIKA_ENDPOINTS[env] || "";
    setCustomUrl(!!c.base_url && c.base_url !== HDIKA_ENDPOINTS[env]);  // saved a non-standard URL
    setF((s) => ({
     ...s,
      username: c.username ?? "",
      afm: c.afm ?? "", eopyy_registry: c.eopyy_registry ?? "", pharmacy_code: c.pharmacy_code ?? "",
      environment: env, base_url: baseUrl, doctor_ip: c.doctor_ip ?? "", client_id: c.client_id ?? "",
      sync_enabled: c.sync_enabled ?? true, sync_interval_minutes: c.sync_interval_minutes ?? 15,
      history_from: c.history_from ?? "",
    }));
  }, [c]);

  const save = useMutation({
    mutationFn: () => api("/ingestion/credentials/hdika", { method: "PUT", body: JSON.stringify(f) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hdika-config"] }),
  });
  const test = useMutation({
    // αποθήκευση τρέχουσας φόρμας πρώτα → έλεγχος με το επιλεγμένο περιβάλλον (όχι το παλιό)
    mutationFn: async () => {
      await api("/ingestion/credentials/hdika", { method: "PUT", body: JSON.stringify(f) });
      return api<TestRes>("/ingestion/hdika/test", { method: "POST" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hdika-config"] }),
  });
  const discover = useMutation({
    // αποθήκευση credentials πρώτα → μετά άντληση στοιχείων φαρμακείου από ΗΔΥΚΑ
    mutationFn: async () => {
      await api("/ingestion/credentials/hdika", { method: "PUT", body: JSON.stringify(f) });
      return api<{ ok: boolean; discovered: Record<string, string> }>("/ingestion/hdika/discover", { method: "POST" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hdika-config"] }),
  });
  const sync = useMutation({
    mutationFn: () => api<SyncRes>("/ingestion/hdika/sync", { method: "POST" }),
    onSuccess: () => {
      syncStartRef.current = Date.now();
      setSyncing(true);
      qc.invalidateQueries({ queryKey: ["ingestion-jobs"] });
    },
  });
  // historical download for a chosen date range
  const [dlFrom, setDlFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [dlTo, setDlTo] = useState(new Date().toISOString().slice(0, 10));
  const [delFrom, setDelFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [delTo, setDelTo] = useState(new Date().toISOString().slice(0, 10));
  const continueHistory = useMutation({
    mutationFn: () => api("/ingestion/hdika/continue?floor=" + dlFrom, { method: "POST" }),
    onSuccess: () => { syncStartRef.current = Date.now(); setSyncing(true); qc.invalidateQueries({ queryKey: ["ingestion-jobs"] }); },
  });
  const backfillRange = useMutation({
    mutationFn: () => api("/ingestion/hdika/backfill?date_from=" + dlFrom + "&date_to=" + dlTo, { method: "POST" }),
    onSuccess: () => {
      syncStartRef.current = Date.now();
      setSyncing(true);
      qc.invalidateQueries({ queryKey: ["ingestion-jobs"] });
    },
  });

  const stopSync = useMutation({
    mutationFn: () => api<{ jobs: number }>("/ingestion/hdika/sync/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ingestion-jobs"] }),
  });

  const deleteRange = useMutation({
    mutationFn: () => api<{ executions: number; items: number; future: number }>(
      `/ingestion/hdika/data?date_from=${delFrom}&date_to=${delTo}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries(),
  });

  if (country === "CY") {
    return (
      <PanelCard title={t("Διασύνδεση ΓΕΣΥ (Κύπρος)", "ΓΕΣΥ Connection (Cyprus)")}>
        <p className="text-sm text-slate-600">
          {t("Για φαρμακεία Κύπρου η συλλογή γίνεται μέσω ", "For Cyprus pharmacies, collection is done via ")}<b>ΓΕΣΥ</b>{t(" (χειροκίνητο XML upload) και είναι προγραμματισμένη για το ", " (manual XML upload) and is scheduled for the ")}<b>{t("επόμενο στάδιο", "next stage")}</b>{t(". Η ΗΔΥΚΑ δεν ισχύει για Κύπρο.", ". ΗΔΥΚΑ does not apply to Cyprus.")}
        </p>
      </PanelCard>
    );
  }

  return (
    <div className="space-y-4">
      {/* status banner */}
      <div className="rx-card flex flex-wrap items-center gap-3 p-4">
        <span className={`grid h-10 w-10 place-items-center rounded-xl ${c?.configured ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
          <PlugZap className="h-5 w-5" />
        </span>
        <div className="mr-auto">
          <div className="text-sm font-semibold text-slate-800">
            {t("Διασύνδεση ΗΔΥΚΑ", "ΗΔΥΚΑ Connection")} {c?.configured ? t("— ενεργή", "— active") : t("— δεν έχει ρυθμιστεί", "— not configured")}
          </div>
          <div className="text-xs text-slate-400">
            {c?.configured
              ? t(
                  `Περιβάλλον: ${c.environment} · Χρήστης: ${c.username ?? "—"}${c.last_sync ? ` · Τελ. sync: ${c.last_sync.status}` : ""}`,
                  `Environment: ${c.environment} · User: ${c.username ?? "—"}${c.last_sync ? ` · Last sync: ${c.last_sync.status}` : ""}`
                )
              : t("Καταχωρήστε τα στοιχεία e-Συνταγογράφησης για άντληση συνταγών.", "Enter your e-Prescription credentials to fetch prescriptions.")}
          </div>
        </div>
        <button onClick={() => test.mutate()} disabled={test.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          {test.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {t("Έλεγχος σύνδεσης", "Test connection")}
        </button>
        <button onClick={() => sync.mutate()} disabled={syncing || sync.isPending || !c?.configured}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40">
          {(syncing || sync.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t("Συγχρονισμός τώρα", "Sync now")}
        </button>
      </div>

      {/* διακόπτης: όλα τα τεχνικά/επικίνδυνα εργαλεία κρυμμένα από προεπιλογή */}
      <div>
        <button type="button" onClick={() => setShowAdvanced((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400">
          {showAdvanced ? "▾" : "▸"} {t("Εργαλεία & ρυθμίσεις για προχωρημένους", "Advanced tools & settings")}
        </button>
      </div>

      {/* ── ΕΡΓΑΛΕΙΑ ΓΙΑ ΠΡΟΧΩΡΗΜΕΝΟΥΣ: κατέβασμα/διαγραφή περιόδου, τεχνικές παράμετροι, ιστορικό ── */}
      {showAdvanced && (
      <>
      {/* historical download for a chosen period */}
      <div className="rx-card flex flex-wrap items-end gap-3 p-4">
        <div className="mr-auto">
          <div className="text-sm font-semibold text-slate-800">{t("Κατέβασμα ιστορικού (επιλογή περιόδου)", "Download history (select period)")}</div>
          <div className="text-xs text-slate-400">{t("Διάλεξε ημερομηνίες και κατέβασε ΜΟΝΟ αυτό το διάστημα.", "Pick dates and download ONLY that range.")}</div>
        </div>
        <label className="text-xs text-slate-500">{t("Από", "From")}<DateInput value={dlFrom} onChange={setDlFrom} className="mt-1 w-40" /></label>
        <label className="text-xs text-slate-500">{t("Έως", "To")}<DateInput value={dlTo} onChange={setDlTo} className="mt-1 w-40" /></label>
        <button onClick={() => continueHistory.mutate()} disabled={syncing || continueHistory.isPending || !c?.configured || !dlFrom}
          title={t("Κατεβάζει αυτόματα ΟΛΟ το ιστορικό από την ημ/νία «Από» μέχρι σήμερα, συνεχίζοντας από εκεί που έφτασε (resume).", "Auto-downloads ALL history from «From» to today, resuming where it left off.")}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40">
          {(syncing || continueHistory.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t("Συνέχιση ιστορικού (auto)", "Continue history (auto)")}
        </button>
        <button onClick={() => backfillRange.mutate()} disabled={syncing || backfillRange.isPending || !c?.configured || !dlFrom}
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-40">
          {(syncing || backfillRange.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t("Κατέβασμα περιόδου", "Download period")}
        </button>
      </div>

      {/* delete a date range (destructive — double confirm) */}
      <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <div className="text-sm font-semibold text-rose-800">{t("Διαγραφή δεδομένων (περίοδος)", "Delete data (period)")}</div>
            <div className="text-xs text-rose-500">{t("Σβήνει ΟΡΙΣΤΙΚΑ εκτελέσεις + γραμμές + μελλοντικές αυτού του διαστήματος (για καθαρό re-ingest).", "PERMANENTLY deletes executions + line items + upcoming for this range (for a clean re-ingest).")}</div>
          </div>
          <label className="text-xs text-slate-500">{t("Από", "From")}<DateInput value={delFrom} onChange={setDelFrom} className="mt-1 w-40" /></label>
          <label className="text-xs text-slate-500">{t("Έως", "To")}<DateInput value={delTo} onChange={setDelTo} className="mt-1 w-40" /></label>
          <button
            onClick={async () => {
              if (!delFrom || !delTo) return;
              if (!(await appConfirm(t(`Οριστική διαγραφή ΟΛΩΝ των δεδομένων ${delFrom} → ${delTo};`, `Permanently delete ALL data ${delFrom} → ${delTo}?`), { danger: true }))) return;
              if (!(await appConfirm(t("Σίγουρα; Η ενέργεια ΔΕΝ αναιρείται.", "Are you sure? This action CANNOT be undone."), { danger: true }))) return;
              deleteRange.mutate();
            }}
            disabled={deleteRange.isPending || syncing || !delFrom || !delTo}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40">
            {deleteRange.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} {t("Διαγραφή περιόδου", "Delete period")}
          </button>
        </div>
        {deleteRange.isSuccess && deleteRange.data && (
          <div className="mt-2 text-xs font-medium text-rose-700">
            {t("Διαγράφηκαν:", "Deleted:")} {deleteRange.data.executions} {t("εκτελέσεις", "executions")} · {deleteRange.data.items} {t("γραμμές", "line items")} · {deleteRange.data.future} {t("μελλοντικές.", "upcoming.")}
          </div>
        )}
      </div>
      </>
      )}

      {/* live sync progress — real % bar driven by how much of the date range is done */}
      {showProgress && (() => {
        const pct = Math.max(0, Math.min(100, Math.round((latestJob?.progress ?? 0) * 100)));
        const known = typeof latestJob?.progress === "number" && latestJob.progress > 0;
        const fmtD = (d?: string) => d ? fmtDate(d) : "—";
        const win = latestJob?.window as { start?: string; end?: string } | undefined;
        return (
          <div className="rx-card p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
                {jobRunning
                  ? (latestJob?.type === "backfill" ? t("Ιστορική άντληση σε εξέλιξη…", "Historical fetch in progress…") : t("Συγχρονισμός σε εξέλιξη…", "Sync in progress…"))
                  : t("Εκκίνηση συγχρονισμού…", "Starting sync…")}
                {known && <span className="ml-1 font-bold text-brand-700">{pct}%</span>}
              </span>
              <span className="inline-flex items-center gap-3">
                <span className="text-slate-500">{(latestJob?.stats?.fetched ?? 0)} {t("συνταγές", "prescriptions")} · {(latestJob?.stats?.inserted ?? 0)} {t("νέες", "new")} · {(latestJob?.stats?.updated ?? 0)} {t("ενημ.", "upd.")}</span>
                {jobRunning && (
                  <button onClick={() => stopSync.mutate()} disabled={stopSync.isPending}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50">
                    {stopSync.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />} {stopSync.isSuccess ? t("Διακόπτεται…", "Stopping…") : t("Σταμάτημα", "Stop")}
                  </button>
                )}
              </span>
            </div>
            {(win?.start || latestJob?.cursor_date) && (
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span className="rounded-md bg-brand-50 px-1.5 py-0.5 font-semibold text-brand-700">
                  {latestJob?.type === "backfill" ? t("Ιστορικό", "Historical") : "Incremental"}
                </span>
                {win?.start && (
                  <span>{t("Περίοδος:", "Period:")} <b className="text-slate-700">{fmtD(win.start)}</b> → <b className="text-slate-700">{fmtD(win.end)}</b></span>
                )}
                {latestJob?.cursor_date && (
                  <span>{t("· συγχρονίζει τώρα στο ", "· now syncing at ")}<b className="text-brand-700">{fmtD(latestJob.cursor_date)}</b></span>
                )}
              </div>
            )}
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full bg-brand-500 transition-[width] duration-700 ease-out ${known ? "" : "w-1/3 animate-pulse"}`}
                style={known ? { width: `${pct}%` } : undefined}
              />
            </div>
          </div>
        );
      })()}

      {test.data && (
        <div className={`rx-card p-3 text-sm ${test.data.ok ? "text-emerald-700" : "text-rose-700"}`}>
          <span className="inline-flex items-center gap-1.5">
            {test.data.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {test.data.message}
          </span>
        </div>
      )}
      {!syncing && latestJob && latestJob.type === "incremental" && latestJob.status !== "running" && (
        <div className="rx-card p-3 text-sm text-emerald-700">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            {t("Ο συγχρονισμός ολοκληρώθηκε —", "Sync completed —")} {latestJob.stats?.inserted ?? 0} {t("νέες,", "new,")} {latestJob.stats?.updated ?? 0} {t("ενημερώσεις,", "updates,")} {latestJob.stats?.fetched ?? 0} {t("σύνολο.", "total.")}
          </span>
        </div>
      )}
      {(discover.data || discover.error) && (
        <div className={`rx-card p-3 text-sm ${discover.error ? "text-rose-700" : "text-emerald-700"}`}>
          <span className="inline-flex items-center gap-1.5">
            {discover.error ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            {discover.error
              ? t("Αποτυχία άντλησης. Ελέγξτε τα στοιχεία σύνδεσης ΗΔΥΚΑ.", "Fetch failed. Check your ΗΔΥΚΑ connection credentials.")
              : t(
                  `Αντλήθηκαν αυτόματα ${Object.keys(discover.data?.discovered ?? {}).length} στοιχεία φαρμακείου από την ΗΔΥΚΑ.`,
                  `Automatically fetched ${Object.keys(discover.data?.discovered ?? {}).length} pharmacy details from ΗΔΥΚΑ.`
                )}
          </span>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <PanelCard title={t("Λογαριασμός e-Συνταγογράφησης", "e-Prescription account")}>
          <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
            <ShieldCheck className="h-4 w-4 shrink-0" /> {t("Δώσε ΜΟΝΟ το όνομα χρήστη & τον κωδικό σου της ΗΔΥΚΑ. Όλα τα υπόλοιπα (ΑΦΜ, ΑΜ ΕΟΠΥΥ, κωδικός ΣΗΣ, endpoint, key) αντλούνται/ρυθμίζονται αυτόματα.", "Enter ONLY your ΗΔΥΚΑ username & password. Everything else is fetched/configured automatically.")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Όνομα χρήστη ΗΔΥΚΑ", "ΗΔΥΚΑ username")}><input className={inputCls} value={f.username} onChange={(e) => set("username", e.target.value)} required /></Field>
            <Field label={t("Κωδικός", "Password")} hint={c?.configured ? t("Αποθηκευμένο — κενό για να μην αλλάξει", "Saved — leave empty to keep unchanged") : undefined}>
              {c?.configured && (
                <span className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t("Αποθηκευμένο (κρυπτογραφημένο)", "Saved (encrypted)")}
                </span>
              )}
              <input type="password" className={inputCls} value={f.password} onChange={(e) => set("password", e.target.value)} placeholder={c?.configured ? "••••••••" : ""} />
            </Field>
          </div>
        </PanelCard>

        <PanelCard title={t("Στοιχεία φαρμακείου (ανακτώνται αυτόματα από ΗΔΥΚΑ)", "Pharmacy details (fetched automatically from ΗΔΥΚΑ)")}>
          <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            <Link2 className="h-3.5 w-3.5" /> {t("Δεν χρειάζεται να τα πληκτρολογήσετε — πατήστε «Σύνδεση & άντληση στοιχείων» και συμπληρώνονται από την ΗΔΥΚΑ (λιγότερα λάθη).", "No need to type them — click «Connect & fetch details» and they are filled in from ΗΔΥΚΑ (fewer errors).")}
          </p>
          {(c?.pharmacy_name || c?.pharmacy_id) && (
            <div className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <b>{c?.pharmacy_name ?? "—"}</b>{c?.pharmacy_id ? ` · ΗΔΥΚΑ ID: ${c.pharmacy_id}` : ""}
            </div>
          )}
          {/* read-only — αντλούνται από ΗΔΥΚΑ, δεν τα πληκτρολογεί ο φαρμακοποιός */}
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            {[["ΑΦΜ", c?.afm], ["ΑΜ ΕΟΠΥΥ", c?.eopyy_registry], [t("Κωδικός ΣΗΣ", "ΣΗΣ code"), c?.pharmacy_code]].map(([lbl, val]) => (
              <div key={lbl as string} className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                <div className="text-[11px] text-slate-400">{lbl}</div>
                <div className="font-medium text-slate-800 dark:text-slate-100">{(val as string) || <span className="text-slate-300">{t("— μετά τη σύνδεση", "— after connecting")}</span>}</div>
              </div>
            ))}
          </div>
        </PanelCard>

        {/* Τεχνικές παράμετροι (integrator/endpoint) — κρυμμένες· κληρονομούνται από το platform. */}
        {showAdvanced && (
        <PanelCard title={t("Παράμετροι API ΗΔΥΚΑ", "ΗΔΥΚΑ API parameters")}>
          <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">
            <Link2 className="h-3.5 w-3.5" /> {t("Το endpoint & τα integrator credentials δίνονται από την ΗΔΥΚΑ κατόπιν σύμβασης (pharm.api.support@idika.gr).", "The endpoint & integrator credentials are provided by ΗΔΥΚΑ after a contract (pharm.api.support@idika.gr).")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Περιβάλλον", "Environment")}>
              <div className="flex gap-2">
                {(["test", "production"] as const).map((env) => (
                  <button type="button" key={env} onClick={() => selectEnv(env)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm ${f.environment === env ? "border-brand-500 bg-brand-50 font-medium text-brand-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                    {env === "test" ? t("Δοκιμαστικό (test)", "Test") : t("Παραγωγή (production)", "Production")}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="API endpoint (base URL)" hint={customUrl ? t("Προσαρμοσμένο URL", "Custom URL") : t("Συμπληρώνεται αυτόματα από το περιβάλλον", "Filled automatically from the environment")}>
              <input className={`${inputCls} ${customUrl ? "" : "bg-slate-50 text-slate-500"}`} value={f.base_url}
                readOnly={!customUrl} onChange={(e) => set("base_url", e.target.value)} />
              <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                <input type="checkbox" checked={customUrl}
                  onChange={(e) => { setCustomUrl(e.target.checked); if (!e.target.checked) set("base_url", HDIKA_ENDPOINTS[f.environment]); }} />
                {t("Προσαρμοσμένο URL (για ειδικές περιπτώσεις)", "Custom URL (for special cases)")}
              </label>
            </Field>
            <Field label="Application API Key" hint={c?.has_api_key ? t("Είναι αποθηκευμένο — άφησε κενό για να μην αλλάξει, ή γράψε νέο για αντικατάσταση.", "It is saved — leave empty to keep unchanged, or type a new one to replace.") : t("APPLICATION ACCESS API KEY (μοναδικό ανά εφαρμογή)", "APPLICATION ACCESS API KEY (unique per application)")}>
              {c?.has_api_key && (
                <span className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t("Αποθηκευμένο (κρυπτογραφημένο)", "Saved (encrypted)")}
                </span>
              )}
              <input type="password" className={inputCls} value={f.api_key} onChange={(e) => set("api_key", e.target.value)} placeholder={c?.has_api_key ? t("•••••••• (αποθηκευμένο)", "•••••••• (saved)") : t("επικόλλησε το key", "paste the key")} />
            </Field>
            <Field label="X-DOCTOR-IP" hint={t("εξωτερική IP κλήσης (αν απαιτείται)", "external call IP (if required)")}><input className={inputCls} value={f.doctor_ip} onChange={(e) => set("doctor_ip", e.target.value)} /></Field>
            <Field label="Client ID (integrator)"><input className={inputCls} value={f.client_id} onChange={(e) => set("client_id", e.target.value)} /></Field>
            <Field label="Client Secret" hint={c?.has_client_secret ? t("Αποθηκευμένο — κενό για να μην αλλάξει", "Saved — leave empty to keep unchanged") : undefined}>
              <input type="password" className={inputCls} value={f.client_secret} onChange={(e) => set("client_secret", e.target.value)} placeholder={c?.has_client_secret ? "••••••••" : ""} />
            </Field>
          </div>
        </PanelCard>
        )}

        <PanelCard title={t("Συγχρονισμός", "Synchronization")}>
          <div className="grid items-end gap-4 sm:grid-cols-3">
            <Field label={t("Αυτόματος συγχρονισμός", "Automatic sync")} hint={t("Κρατάει τις συνταγές ενημερωμένες αυτόματα.", "Keeps prescriptions up to date automatically.")}>
              <select className={inputCls} value={f.sync_enabled ? "1" : "0"} onChange={(e) => set("sync_enabled", e.target.value === "1")}>
                <option value="1">{t("Ενεργός", "Enabled")}</option>
                <option value="0">{t("Ανενεργός", "Disabled")}</option>
              </select>
            </Field>
            {showAdvanced && <Field label={t("Συχνότητα (λεπτά)", "Frequency (minutes)")}><input type="number" min={5} max={1440} className={inputCls} value={f.sync_interval_minutes} onChange={(e) => set("sync_interval_minutes", Number(e.target.value))} /></Field>}
            {showAdvanced && <Field label={t("Συγχρονισμός από (ιστορικό)", "Sync from (history)")} hint={t("Δεν κατεβάζει δεδομένα πριν από αυτή την ημερομηνία.", "Does NOT download data before this date.")}><DateInput value={f.history_from?.slice(0, 10) || ""} onChange={(v) => set("history_from", v)} /></Field>}
          </div>
        </PanelCard>

        <div className="flex flex-wrap items-center gap-3">
          {/* κύριο κουμπί: αποθηκεύει & αντλεί αυτόματα τα στοιχεία φαρμακείου από ΗΔΥΚΑ */}
          <button type="button" onClick={() => discover.mutate()} disabled={discover.isPending || !f.username}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40">
            {discover.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} {t("Αποθήκευση & αυτόματη άντληση", "Save & auto-fetch")}
          </button>
          <button type="submit" disabled={save.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {t("Μόνο αποθήκευση", "Save only")}
          </button>
          {(save.isSuccess || discover.isSuccess) && <span className="text-sm text-emerald-600">{t("Αποθηκεύτηκε ✓", "Saved ✓")}</span>}
          {(save.isError || discover.isError) && <span className="text-sm text-rose-600">{t("Σφάλμα", "Error")}</span>}
        </div>
      </form>

      {showAdvanced && (
      <PanelCard title={t("Ιστορικό συγχρονισμών", "Sync history")} bodyClassName="pt-2">
        <ul className="divide-y divide-slate-100 text-sm">
          {(jobs.data?.items ?? []).slice(0, 8).map((j: any) => (
            <li key={j._id} className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{j.source}</span>
                <span className="text-slate-600">{j.type}</span>
              </div>
              <span className={`text-xs font-medium ${j.status === "success" ? "text-emerald-600" : j.status === "failed" ? "text-rose-600" : "text-slate-400"}`}>
                {j.status} · {j.stats ? t(`${j.stats.inserted ?? 0} νέες / ${j.stats.duplicates ?? 0} διπλές`, `${j.stats.inserted ?? 0} new / ${j.stats.duplicates ?? 0} dup`) : ""}
              </span>
            </li>
          ))}
          {(jobs.data?.items?.length ?? 0) === 0 && <li className="py-6 text-center text-slate-400">{t("Καμία εργασία ακόμη", "No jobs yet")}</li>}
        </ul>
      </PanelCard>
      )}
    </div>
  );
}
