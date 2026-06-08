"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";

type EnvCfg = {
  base_url: string;
  has_api_key: boolean;
  integrator_username: string;
  has_integrator_password: boolean;
  pharmacy_id: string;
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
  const [f, setF] = useState({
    testUrl: DEFAULTS.test, prodUrl: DEFAULTS.production,
    testKey: "", testUser: "", testPass: "", testPid: "",
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
      testPid: data.test?.pharmacy_id || "",
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
            base_url: f.testUrl, integrator_username: f.testUser, pharmacy_id: f.testPid,
            ...(f.testKey ? { api_key: f.testKey } : {}),
            ...(f.testPass ? { integrator_password: f.testPass } : {}),
          },
          production: { base_url: f.prodUrl },  // per-pharmacy creds live in each tenant's settings
        }),
      });
      setNotice("Αποθηκεύτηκε ✓"); set("testKey", ""); set("testPass", "");
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
      <h1 className="mb-2 text-xl font-bold text-slate-900">Διασύνδεση ΗΔΙΚΑ</h1>
      <p className="mb-6 text-sm text-slate-500">
        Στο <b>production</b> κάθε φαρμακείο είναι αυτόνομη οντότητα: χρησιμοποιεί τα <b>δικά του</b> username/password/
        API key/pharmacy_id (ορίζονται ανά φαρμακείο στις ρυθμίσεις του). Εδώ ορίζεις μόνο το <b>endpoint</b> του production
        και τον κοινό <b>δοκιμαστικό (sandbox) λογαριασμό</b> της CloudOn για δοκιμές.
      </p>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-6">
        <div>
          <div className="mb-2 text-sm font-semibold text-slate-700">Ενεργό περιβάλλον</div>
          <div className="flex gap-2">
            {(["test", "production"] as const).map((env) => (
              <button key={env} type="button" onClick={() => setActiveEnv(env)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm ${activeEnv === env ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                {env === "test" ? "Δοκιμαστικό (sandbox)" : "Παραγωγή (production)"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {activeEnv === "test"
              ? "Όλα τα φαρμακεία δρομολογούνται μέσω του κοινού sandbox λογαριασμού."
              : "Κάθε φαρμακείο καλεί την ΗΔΙΚΑ με τα δικά του στοιχεία."}
          </p>
        </div>

        {/* TEST sandbox — CloudOn shared account */}
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="mb-1 text-sm font-semibold text-slate-700">Δοκιμαστικό sandbox (CloudOn)</div>
          <p className="mb-3 text-xs text-slate-400">Ο κοινός λογαριασμός που μας έδωσε η ΗΔΙΚΑ για δοκιμές ως φαρμακείο.</p>
          <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Base URL</span>
            <input className={inp} value={f.testUrl} onChange={(e) => set("testUrl", e.target.value)} /></label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm"><span className="mb-1 block text-slate-600">Username</span>
              <input className={inp} value={f.testUser} onChange={(e) => set("testUser", e.target.value)} placeholder="foreignoffice_tst" /></label>
            <label className="block text-sm"><span className="mb-1 block text-slate-600">Password</span>
              <SavedBadge on={!!data?.test?.has_integrator_password} />
              <input type="password" className={inp} value={f.testPass} onChange={(e) => set("testPass", e.target.value)}
                placeholder={data?.test?.has_integrator_password ? "•••••• (κενό = αμετάβλητο)" : "κωδικός"} /></label>
            <label className="block text-sm"><span className="mb-1 block text-slate-600">Application API Key</span>
              <SavedBadge on={!!data?.test?.has_api_key} />
              <input type="password" className={inp} value={f.testKey} onChange={(e) => set("testKey", e.target.value)}
                placeholder={data?.test?.has_api_key ? "•••••• (κενό = αμετάβλητο)" : "test api key"} /></label>
            <label className="block text-sm"><span className="mb-1 block text-slate-600">Pharmacy ID (test)</span>
              <input className={inp} value={f.testPid} onChange={(e) => set("testPid", e.target.value)} placeholder="π.χ. 11316" /></label>
          </div>
        </div>

        {/* PRODUCTION — endpoint only; credentials are per-pharmacy */}
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="mb-1 text-sm font-semibold text-slate-700">Παραγωγή (production)</div>
          <p className="mb-3 text-xs text-slate-400">
            Μόνο το endpoint. Τα <b>username/password/API key/pharmacy_id</b> κάθε φαρμακείου ορίζονται
            στις ρυθμίσεις του εκάστοτε φαρμακείου (αυτόνομη οντότητα).
          </p>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Base URL</span>
            <input className={inp} value={f.prodUrl} onChange={(e) => set("prodUrl", e.target.value)} /></label>
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
