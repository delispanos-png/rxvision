"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";

type EnvCfg = {
  base_url: string;
  has_api_key: boolean;
  integrator_username: string;
  has_integrator_password: boolean;
};
type Idika = { active_environment: string; doctor_ip: string | null; test: EnvCfg; production: EnvCfg };

const DEFAULTS: Record<string, string> = {
  test: "https://testeps.e-prescription.gr/pharmapiv2",
  production: "https://eps.e-prescription.gr/pharmacistapi",
};

export default function IdikaConfigPage() {
  const { data } = useQuery({ queryKey: ["admin", "idika"], queryFn: () => adminApi<Idika>("/admin/idika"), retry: false });

  const [activeEnv, setActiveEnv] = useState("test");
  const [doctorIp, setDoctorIp] = useState("");
  // per-env: base url, api key, integrator username, integrator password
  const [f, setF] = useState({
    testUrl: DEFAULTS.test, prodUrl: DEFAULTS.production,
    testKey: "", prodKey: "",
    testUser: "", prodUser: "",
    testPass: "", prodPass: "",
  });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setActiveEnv(data.active_environment ?? "test");
    setDoctorIp(data.doctor_ip ?? "");
    setF((s) => ({
      ...s,
      testUrl: data.test?.base_url || DEFAULTS.test,
      prodUrl: data.production?.base_url || DEFAULTS.production,
      testUser: data.test?.integrator_username || "",
      prodUser: data.production?.integrator_username || "",
    }));
  }, [data]);

  async function save() {
    setBusy(true); setNotice(null);
    try {
      await adminApi("/admin/idika", {
        method: "PUT",
        body: JSON.stringify({
          active_environment: activeEnv, doctor_ip: doctorIp,
          test: {
            base_url: f.testUrl, integrator_username: f.testUser,
            ...(f.testKey ? { api_key: f.testKey } : {}),
            ...(f.testPass ? { integrator_password: f.testPass } : {}),
          },
          production: {
            base_url: f.prodUrl, integrator_username: f.prodUser,
            ...(f.prodKey ? { api_key: f.prodKey } : {}),
            ...(f.prodPass ? { integrator_password: f.prodPass } : {}),
          },
        }),
      });
      setNotice("Αποθηκεύτηκε ✓"); set("testKey", ""); set("prodKey", ""); set("testPass", ""); set("prodPass", "");
    } catch (e) {
      setNotice(e instanceof ApiError ? `Σφάλμα: ${JSON.stringify(e.problem)}` : "Σφάλμα.");
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none";
  const SavedBadge = ({ on }: { on: boolean }) => on ? (
    <span className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">✓ Αποθηκευμένο (κρυπτογραφημένο)</span>
  ) : null;

  function EnvBlock({ title, env }: { title: string; env: "test" | "prod" }) {
    const cfg = env === "test" ? data?.test : data?.production;
    const urlK = `${env}Url`, keyK = `${env}Key`, userK = `${env}User`, passK = `${env}Pass`;
    return (
      <div className="rounded-lg border border-slate-200 p-4">
        <div className="mb-3 text-sm font-semibold text-slate-700">{title}</div>
        <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Base URL</span>
          <input className={inp} value={(f as any)[urlK]} onChange={(e) => set(urlK, e.target.value)} /></label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Integrator username</span>
            <input className={inp} value={(f as any)[userK]} onChange={(e) => set(userK, e.target.value)}
              placeholder="π.χ. foreignoffice_tst" /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Integrator password</span>
            <SavedBadge on={!!cfg?.has_integrator_password} />
            <input type="password" className={inp} value={(f as any)[passK]} onChange={(e) => set(passK, e.target.value)}
              placeholder={cfg?.has_integrator_password ? "•••••••• (κενό = αμετάβλητο)" : "κωδικός integrator"} /></label>
        </div>
        <label className="mt-3 block text-sm"><span className="mb-1 block text-slate-600">Application API Key</span>
          <SavedBadge on={!!cfg?.has_api_key} />
          <input type="password" className={inp} value={(f as any)[keyK]} onChange={(e) => set(keyK, e.target.value)}
            placeholder={cfg?.has_api_key ? "•••••••• (κενό = αμετάβλητο)" : "application access api key"} /></label>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-2 text-xl font-bold text-slate-900">Διασύνδεση ΗΔΙΚΑ (integrator)</h1>
      <p className="mb-6 text-sm text-slate-500">
        Παράμετροι σε επίπεδο πλατφόρμας — κοινές για όλα τα φαρμακεία. Το <b>Basic auth (integrator username/password)</b>,
        το <b>application API key</b> και τα endpoints είναι του CloudOn. Κάθε φαρμακείο ορίζει μόνο το δικό του
        <b> pharmacy_id</b> (στις ρυθμίσεις του φαρμακείου).
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

        <EnvBlock title="Δοκιμαστικό (test)" env="test" />
        <EnvBlock title="Παραγωγή (production)" env="prod" />

        <label className="block text-sm"><span className="mb-1 block text-slate-600">X-DOCTOR-IP (αν απαιτείται)</span>
          <input className={inp} value={doctorIp} onChange={(e) => setDoctorIp(e.target.value)} placeholder="π.χ. 157.180.26.98" /></label>

        <button onClick={save} disabled={busy} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? "Αποθήκευση…" : "Αποθήκευση"}
        </button>
      </div>
    </div>
  );
}
