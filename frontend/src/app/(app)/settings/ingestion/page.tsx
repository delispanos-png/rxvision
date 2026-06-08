"use client";

import { useEffect, useState } from "react";
import { DateInput } from "@/components/ui/DateInput";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Loader2, PlugZap, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";

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

// Επίσημα ΗΔΙΚΑ endpoints ανά περιβάλλον — επιλέγεις περιβάλλον, μπαίνει το URL μόνο του.
const HDIKA_ENDPOINTS: Record<string, string> = {
  test: "https://testeps.e-prescription.gr/pharmapiv2",
  production: "https://eps.e-prescription.gr/pharmapiv2",
};

export default function IngestionSettingsPage() {
  const qc = useQueryClient();
  const tenant = useQuery({ queryKey: ["tenant"], queryFn: () => api<Tenant>("/tenant"), retry: false });
  const cfg = useQuery({ queryKey: ["hdika-config"], queryFn: () => api<Config>("/ingestion/credentials/hdika"), retry: false });
  const jobs = useQuery({ queryKey: ["ingestion-jobs"], queryFn: () => api<{ items: any[] }>("/ingestion/jobs"), retry: false });

  const country = (tenant.data?.country || "GR").toUpperCase();
  const c = cfg.data;

  const [f, setF] = useState({
    username: "", password: "", afm: "", eopyy_registry: "", pharmacy_code: "",
    environment: "test", base_url: HDIKA_ENDPOINTS.test, api_key: "", doctor_ip: "", client_id: "", client_secret: "",
    sync_enabled: true, sync_interval_minutes: 15, history_from: "",
  });
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));
  const [customUrl, setCustomUrl] = useState(false);
  // Επιλογή περιβάλλοντος → αυτόματη συμπλήρωση endpoint (εκτός custom).
  const selectEnv = (env: string) =>
    setF((s) => ({ ...s, environment: env, base_url: customUrl ? s.base_url : HDIKA_ENDPOINTS[env] }));

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
    // αποθήκευση credentials πρώτα → μετά άντληση στοιχείων φαρμακείου από ΗΔΙΚΑ
    mutationFn: async () => {
      await api("/ingestion/credentials/hdika", { method: "PUT", body: JSON.stringify(f) });
      return api<{ ok: boolean; discovered: Record<string, string> }>("/ingestion/hdika/discover", { method: "POST" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hdika-config"] }),
  });
  const sync = useMutation({
    mutationFn: () => api<SyncRes>("/ingestion/hdika/sync", { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ingestion-jobs"] }); qc.invalidateQueries({ queryKey: ["hdika-config"] }); },
  });

  if (country === "CY") {
    return (
      <PanelCard title="Διασύνδεση ΓΕΣΥ (Κύπρος)">
        <p className="text-sm text-slate-600">
          Για φαρμακεία Κύπρου η συλλογή γίνεται μέσω <b>ΓΕΣΥ</b> (χειροκίνητο XML upload) και
          είναι προγραμματισμένη για το <b>επόμενο στάδιο</b>. Η ΗΔΙΚΑ δεν ισχύει για Κύπρο.
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
            Διασύνδεση ΗΔΙΚΑ {c?.configured ? "— ενεργή" : "— δεν έχει ρυθμιστεί"}
          </div>
          <div className="text-xs text-slate-400">
            {c?.configured
              ? `Περιβάλλον: ${c.environment} · Χρήστης: ${c.username ?? "—"}${c.last_sync ? ` · Τελ. sync: ${c.last_sync.status}` : ""}`
              : "Καταχωρήστε τα στοιχεία e-Συνταγογράφησης για άντληση συνταγών."}
          </div>
        </div>
        <button onClick={() => test.mutate()} disabled={test.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          {test.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Έλεγχος σύνδεσης
        </button>
        <button onClick={() => discover.mutate()} disabled={discover.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100">
          {discover.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Σύνδεση & άντληση στοιχείων
        </button>
        <button onClick={() => sync.mutate()} disabled={sync.isPending || !c?.configured}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40">
          {sync.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Συγχρονισμός τώρα
        </button>
      </div>

      {(test.data || sync.data) && (
        <div className={`rx-card p-3 text-sm ${(test.data?.ok ?? true) ? "text-emerald-700" : "text-rose-700"}`}>
          <span className="inline-flex items-center gap-1.5">
            {(test.data?.ok ?? true) ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {test.data?.message ?? (sync.data ? `Συγχρονισμός: ${sync.data.status}` : "")}
          </span>
        </div>
      )}
      {(discover.data || discover.error) && (
        <div className={`rx-card p-3 text-sm ${discover.error ? "text-rose-700" : "text-emerald-700"}`}>
          <span className="inline-flex items-center gap-1.5">
            {discover.error ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            {discover.error
              ? "Αποτυχία άντλησης. Ελέγξτε τα στοιχεία σύνδεσης ΗΔΙΚΑ."
              : `Αντλήθηκαν αυτόματα ${Object.keys(discover.data?.discovered ?? {}).length} στοιχεία φαρμακείου από την ΗΔΙΚΑ.`}
          </span>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <PanelCard title="Λογαριασμός e-Συνταγογράφησης">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Όνομα χρήστη ΗΔΙΚΑ"><input className={inputCls} value={f.username} onChange={(e) => set("username", e.target.value)} required /></Field>
            <Field label="Κωδικός" hint={c?.configured ? "Αποθηκευμένο — κενό για να μην αλλάξει" : undefined}>
              {c?.configured && (
                <span className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Αποθηκευμένο (κρυπτογραφημένο)
                </span>
              )}
              <input type="password" className={inputCls} value={f.password} onChange={(e) => set("password", e.target.value)} placeholder={c?.configured ? "••••••••" : ""} />
            </Field>
          </div>
        </PanelCard>

        <PanelCard title="Στοιχεία φαρμακείου (ανακτώνται αυτόματα από ΗΔΙΚΑ)">
          <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            <Link2 className="h-3.5 w-3.5" /> Δεν χρειάζεται να τα πληκτρολογήσετε — πατήστε «Σύνδεση & άντληση στοιχείων» και συμπληρώνονται από την ΗΔΙΚΑ (λιγότερα λάθη).
          </p>
          {(c?.pharmacy_name || c?.pharmacy_id) && (
            <div className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <b>{c?.pharmacy_name ?? "—"}</b>{c?.pharmacy_id ? ` · ΗΔΙΚΑ ID: ${c.pharmacy_id}` : ""}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="ΑΦΜ" hint="ανακτάται αυτόματα"><input className={inputCls} value={f.afm} onChange={(e) => set("afm", e.target.value)} /></Field>
            <Field label="ΑΜ ΕΟΠΥΥ" hint="ανακτάται αυτόματα"><input className={inputCls} value={f.eopyy_registry} onChange={(e) => set("eopyy_registry", e.target.value)} /></Field>
            <Field label="Κωδικός φαρμακείου (ΣΗΣ)" hint="ανακτάται αυτόματα"><input className={inputCls} value={f.pharmacy_code} onChange={(e) => set("pharmacy_code", e.target.value)} /></Field>
          </div>
        </PanelCard>

        <PanelCard title="Παράμετροι API ΗΔΙΚΑ">
          <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">
            <Link2 className="h-3.5 w-3.5" /> Το endpoint & τα integrator credentials δίνονται από την ΗΔΙΚΑ κατόπιν σύμβασης (pharm.api.support@idika.gr).
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Περιβάλλον">
              <div className="flex gap-2">
                {(["test", "production"] as const).map((env) => (
                  <button type="button" key={env} onClick={() => selectEnv(env)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm ${f.environment === env ? "border-brand-500 bg-brand-50 font-medium text-brand-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                    {env === "test" ? "Δοκιμαστικό (test)" : "Παραγωγή (production)"}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="API endpoint (base URL)" hint={customUrl ? "Προσαρμοσμένο URL" : "Συμπληρώνεται αυτόματα από το περιβάλλον"}>
              <input className={`${inputCls} ${customUrl ? "" : "bg-slate-50 text-slate-500"}`} value={f.base_url}
                readOnly={!customUrl} onChange={(e) => set("base_url", e.target.value)} />
              <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                <input type="checkbox" checked={customUrl}
                  onChange={(e) => { setCustomUrl(e.target.checked); if (!e.target.checked) set("base_url", HDIKA_ENDPOINTS[f.environment]); }} />
                Προσαρμοσμένο URL (για ειδικές περιπτώσεις)
              </label>
            </Field>
            <Field label="Application API Key" hint={c?.has_api_key ? "Είναι αποθηκευμένο — άφησε κενό για να μην αλλάξει, ή γράψε νέο για αντικατάσταση." : "APPLICATION ACCESS API KEY (μοναδικό ανά εφαρμογή)"}>
              {c?.has_api_key && (
                <span className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Αποθηκευμένο (κρυπτογραφημένο)
                </span>
              )}
              <input type="password" className={inputCls} value={f.api_key} onChange={(e) => set("api_key", e.target.value)} placeholder={c?.has_api_key ? "•••••••• (αποθηκευμένο)" : "επικόλλησε το key"} />
            </Field>
            <Field label="X-DOCTOR-IP" hint="εξωτερική IP κλήσης (αν απαιτείται)"><input className={inputCls} value={f.doctor_ip} onChange={(e) => set("doctor_ip", e.target.value)} /></Field>
            <Field label="Client ID (integrator)"><input className={inputCls} value={f.client_id} onChange={(e) => set("client_id", e.target.value)} /></Field>
            <Field label="Client Secret" hint={c?.has_client_secret ? "Αποθηκευμένο — κενό για να μην αλλάξει" : undefined}>
              <input type="password" className={inputCls} value={f.client_secret} onChange={(e) => set("client_secret", e.target.value)} placeholder={c?.has_client_secret ? "••••••••" : ""} />
            </Field>
          </div>
        </PanelCard>

        <PanelCard title="Συγχρονισμός">
          <div className="grid items-end gap-4 sm:grid-cols-3">
            <Field label="Αυτόματος συγχρονισμός">
              <select className={inputCls} value={f.sync_enabled ? "1" : "0"} onChange={(e) => set("sync_enabled", e.target.value === "1")}>
                <option value="1">Ενεργός (αέναος)</option>
                <option value="0">Ανενεργός</option>
              </select>
            </Field>
            <Field label="Συχνότητα (λεπτά)"><input type="number" min={5} max={1440} className={inputCls} value={f.sync_interval_minutes} onChange={(e) => set("sync_interval_minutes", Number(e.target.value))} /></Field>
            <Field label="Άντληση ιστορικού από" hint="αρχή σύμβασης ΕΟΠΥΥ"><DateInput value={f.history_from?.slice(0, 10) || ""} onChange={(v) => set("history_from", v)} /></Field>
          </div>
        </PanelCard>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={save.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Αποθήκευση
          </button>
          {save.isSuccess && <span className="text-sm text-emerald-600">Αποθηκεύτηκε ✓</span>}
          {save.isError && <span className="text-sm text-rose-600">Σφάλμα αποθήκευσης</span>}
        </div>
      </form>

      <PanelCard title="Ιστορικό συγχρονισμών" bodyClassName="pt-2">
        <ul className="divide-y divide-slate-100 text-sm">
          {(jobs.data?.items ?? []).slice(0, 8).map((j: any) => (
            <li key={j._id} className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{j.source}</span>
                <span className="text-slate-600">{j.type}</span>
              </div>
              <span className={`text-xs font-medium ${j.status === "success" ? "text-emerald-600" : j.status === "failed" ? "text-rose-600" : "text-slate-400"}`}>
                {j.status} · {j.stats ? `${j.stats.inserted ?? 0} νέες / ${j.stats.duplicates ?? 0} διπλές` : ""}
              </span>
            </li>
          ))}
          {(jobs.data?.items?.length ?? 0) === 0 && <li className="py-6 text-center text-slate-400">Καμία εργασία ακόμη</li>}
        </ul>
      </PanelCard>
    </div>
  );
}
