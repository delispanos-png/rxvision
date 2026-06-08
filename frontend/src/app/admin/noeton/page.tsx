"use client";

import { appConfirm } from "@/store/dialogStore";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";

type Cfg = { base_url: string; has_api_key: boolean; has_inbound_key: boolean; has_webhook_secret: boolean };
const OUR_HOST = "https://app.rxvision.gr";

export default function NoetonPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "noeton"], queryFn: () => adminApi<Cfg>("/admin/noeton"), retry: false });
  const [baseUrl, setBaseUrl] = useState("https://admin.noeton.eu/api/v1/external");
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<{ inbound_key: string; webhook_secret: string } | null>(null);

  useEffect(() => { if (data?.base_url) setBaseUrl(data.base_url); }, [data]);

  async function save() {
    setBusy(true); setNotice(null);
    try {
      await adminApi("/admin/noeton", { method: "PUT", body: JSON.stringify({ base_url: baseUrl, ...(apiKey ? { api_key: apiKey } : {}) }) });
      setApiKey("");
      await qc.invalidateQueries({ queryKey: ["admin", "noeton"] });  // refresh «✓ Αποθηκευμένο»
      setNotice(apiKey ? "Αποθηκεύτηκε ✓ — το API Key καταχωρήθηκε." : "Αποθηκεύτηκε ✓");
    } catch (e) { setNotice(e instanceof ApiError ? `Σφάλμα: ${JSON.stringify(e.problem)}` : "Σφάλμα."); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (data?.has_inbound_key && !(await appConfirm("Υπάρχουν ήδη κλειδιά. Επαναδημιουργία θα τα αντικαταστήσει (πρέπει να ξαναμπούν στη Noeton). Συνέχεια;", { title: "Επαναδημιουργία κλειδιών", danger: true, confirmText: "Επαναδημιουργία" }))) return;
    setBusy(true); setNotice(null);
    try {
      const r = await adminApi<{ inbound_key: string; webhook_secret: string }>("/admin/noeton/generate-keys", { method: "POST" });
      setGenerated(r); qc.invalidateQueries({ queryKey: ["admin", "noeton"] });
    } catch (e) { setNotice(e instanceof ApiError ? `Σφάλμα: ${JSON.stringify(e.problem)}` : "Σφάλμα."); }
    finally { setBusy(false); }
  }
  async function testHeartbeat() {
    setBusy(true); setNotice(null);
    try { await adminApi("/admin/noeton/heartbeat", { method: "POST" }); setNotice("Heartbeat προς Noeton: OK ✓"); }
    catch (e) { setNotice(e instanceof ApiError ? `Αποτυχία heartbeat: ${JSON.stringify(e.problem)}` : "Σφάλμα."); }
    finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none";
  const KV = ({ label, value }: { label: string; value: string }) => (
    <div className="mb-2">
      <div className="text-xs text-slate-500">{label}</div>
      <code className="block break-all rounded bg-white px-2 py-1 text-xs text-slate-800 ring-1 ring-slate-200">{value}</code>
    </div>
  );

  return (
    <div className="max-w-3xl">
      <h1 className="mb-2 text-xl font-bold text-slate-900">Διασύνδεση Noeton</h1>
      <p className="mb-6 text-sm text-slate-500">Όσα ορίζουμε εμείς δημιουργούνται αυτόματα· από τη Noeton περιμένουμε μόνο το API Key.</p>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      {/* 1. Auto-generated keys (we define → give to Noeton) */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-1 text-sm font-semibold text-slate-700">① Κλειδιά RxVision (αυτόματα)</div>
        <p className="mb-3 text-xs text-slate-500">
          Inbound Key + Webhook Secret — τα δημιουργούμε εμείς και τα δηλώνεις στο Noeton (product config).
          {data?.has_inbound_key && <span className="ml-1 font-medium text-emerald-600">✓ Έχουν δημιουργηθεί.</span>}
        </p>
        <button onClick={generate} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {data?.has_inbound_key ? "Επαναδημιουργία κλειδιών" : "Δημιουργία κλειδιών"}
        </button>
        {generated && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div className="mb-2 text-xs font-medium text-amber-800">⚠ Αντίγραψέ τα ΤΩΡΑ στο Noeton — εμφανίζονται μία φορά:</div>
            <KV label="Inbound Key (X-API-Key Noeton → RxVision)" value={generated.inbound_key} />
            <KV label="Webhook Secret (HMAC-SHA256)" value={generated.webhook_secret} />
          </div>
        )}
      </div>

      {/* 2. From Noeton */}
      <div className="mb-6 space-y-4 rounded-xl border border-slate-200 bg-white p-6">
        <div className="text-sm font-semibold text-slate-700">② Από τη Noeton</div>
        <label className="block text-sm"><span className="mb-1 block text-slate-600">Noeton API base URL</span>
          <input className={inp} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        <label className="block text-sm"><span className="mb-1 block text-slate-600">API Key — RxVision → Noeton (X-API-Key)</span>
          {data?.has_api_key && <span className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">✓ Αποθηκευμένο</span>}
          <input type="password" className={inp} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={data?.has_api_key ? "•••••••• (κενό για να μην αλλάξει)" : "noeton_... (από το Noeton Platform)"} /></label>
        <div className="flex gap-2">
          <button onClick={save} disabled={busy} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">Αποθήκευση</button>
          <button onClick={testHeartbeat} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">Test heartbeat</button>
        </div>
      </div>

      {/* 3. What to paste into Noeton */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
        <div className="mb-2 font-semibold text-slate-700">③ Στο Noeton Admin (external_platform_url)</div>
        <ul className="space-y-1">
          <li className="break-words">Base / Health: <code className="break-all">{OUR_HOST}</code> · <code className="break-all">{OUR_HOST}/health</code></li>
          <li className="break-words">Webhooks: <code className="break-all">{OUR_HOST}/api/noeton/webhooks</code></li>
          <li>+ τα κλειδιά του βήματος ① (inbound + webhook secret)</li>
        </ul>
      </div>
    </div>
  );
}
