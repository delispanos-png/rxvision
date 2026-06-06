"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";

type EnvCfg = { base_url: string; has_api_key: boolean };
type Idika = { active_environment: string; doctor_ip: string | null; test: EnvCfg; production: EnvCfg };

const DEFAULTS: Record<string, string> = {
  test: "https://testeps.e-prescription.gr/pharmapiv2",
  production: "https://eps.e-prescription.gr/pharmapiv2",
};

export default function IdikaConfigPage() {
  const { data } = useQuery({ queryKey: ["admin", "idika"], queryFn: () => adminApi<Idika>("/admin/idika"), retry: false });

  const [activeEnv, setActiveEnv] = useState("test");
  const [doctorIp, setDoctorIp] = useState("");
  const [testUrl, setTestUrl] = useState(DEFAULTS.test);
  const [prodUrl, setProdUrl] = useState(DEFAULTS.production);
  const [testKey, setTestKey] = useState("");
  const [prodKey, setProdKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setActiveEnv(data.active_environment ?? "test");
    setDoctorIp(data.doctor_ip ?? "");
    setTestUrl(data.test?.base_url || DEFAULTS.test);
    setProdUrl(data.production?.base_url || DEFAULTS.production);
  }, [data]);

  async function save() {
    setBusy(true); setNotice(null);
    try {
      await adminApi("/admin/idika", {
        method: "PUT",
        body: JSON.stringify({
          active_environment: activeEnv, doctor_ip: doctorIp,
          test: { base_url: testUrl, ...(testKey ? { api_key: testKey } : {}) },
          production: { base_url: prodUrl, ...(prodKey ? { api_key: prodKey } : {}) },
        }),
      });
      setNotice("Αποθηκεύτηκε ✓"); setTestKey(""); setProdKey("");
    } catch (e) {
      setNotice(e instanceof ApiError ? `Σφάλμα: ${JSON.stringify(e.problem)}` : "Σφάλμα.");
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none";
  const SavedBadge = ({ on }: { on: boolean }) => on ? (
    <span className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">✓ Αποθηκευμένο (κρυπτογραφημένο)</span>
  ) : null;

  return (
    <div className="max-w-3xl">
      <h1 className="mb-2 text-xl font-bold text-slate-900">Διασύνδεση ΗΔΙΚΑ (integrator)</h1>
      <p className="mb-6 text-sm text-slate-500">
        Παράμετροι σε επίπεδο πλατφόρμας — κοινές για όλα τα φαρμακεία. Το κάθε φαρμακείο βάζει μόνο το δικό του
        username/password· το <b>application API key</b> και τα endpoints είναι του CloudOn.
      </p>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-6">
        <div>
          <div className="mb-2 text-sm font-semibold text-slate-700">Ενεργό περιβάλλον</div>
          <div className="flex gap-2">
            {(["test", "production"] as const).map((env) => (
              <button key={env} type="button" onClick={() => setActiveEnv(env)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm ${activeEnv === env ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                {env === "test" ? "Δοκιμαστικό (test)" : "Παραγωγή (production)"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">Όλα τα φαρμακεία χρησιμοποιούν αυτό το περιβάλλον.</p>
        </div>

        <div className="rounded-lg border border-slate-200 p-4">
          <div className="mb-3 text-sm font-semibold text-slate-700">Δοκιμαστικό (test)</div>
          <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Base URL</span>
            <input className={inp} value={testUrl} onChange={(e) => setTestUrl(e.target.value)} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Application API Key</span>
            <SavedBadge on={!!data?.test?.has_api_key} />
            <input type="password" className={inp} value={testKey} onChange={(e) => setTestKey(e.target.value)}
              placeholder={data?.test?.has_api_key ? "•••••••• (αποθηκευμένο — κενό για να μην αλλάξει)" : "application access api key"} /></label>
        </div>

        <div className="rounded-lg border border-slate-200 p-4">
          <div className="mb-3 text-sm font-semibold text-slate-700">Παραγωγή (production)</div>
          <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Base URL</span>
            <input className={inp} value={prodUrl} onChange={(e) => setProdUrl(e.target.value)} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Application API Key</span>
            <SavedBadge on={!!data?.production?.has_api_key} />
            <input type="password" className={inp} value={prodKey} onChange={(e) => setProdKey(e.target.value)}
              placeholder={data?.production?.has_api_key ? "•••••••• (αποθηκευμένο — κενό για να μην αλλάξει)" : "application access api key"} /></label>
        </div>

        <label className="block text-sm"><span className="mb-1 block text-slate-600">X-DOCTOR-IP (αν απαιτείται)</span>
          <input className={inp} value={doctorIp} onChange={(e) => setDoctorIp(e.target.value)} placeholder="π.χ. 157.180.26.98" /></label>

        <button onClick={save} disabled={busy} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? "Αποθήκευση…" : "Αποθήκευση"}
        </button>
      </div>
    </div>
  );
}
