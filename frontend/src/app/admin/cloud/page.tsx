"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Cloud, Save, Loader2, Check, ShieldCheck, Trash2, HardDrive } from "lucide-react";
import { InfraDashboard } from "@/components/admin/InfraDashboard";

type Status = { hetzner_configured: boolean; cloudflare_configured: boolean; storage_configured?: boolean; storage_host?: string | null; storage_user?: string | null; storage_path?: string | null };
type Verify = { hetzner_ok?: boolean; hetzner_servers?: string[]; cloudflare_ok?: boolean; cloudflare_zones?: string[]; hetzner_error?: string; cloudflare_error?: string; storage_ok?: boolean; storage_error?: string };

export default function CloudPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["cloud", "status"], queryFn: () => adminApi<Status>("/platform/cloud"), retry: false });
  const [hetzner, setHetzner] = useState("");
  const [cloudflare, setCloudflare] = useState("");
  const [stHost, setStHost] = useState("");
  const [stUser, setStUser] = useState("");
  const [stPass, setStPass] = useState("");
  const [stPath, setStPath] = useState("");
  const [verify, setVerify] = useState<Verify | null>(null);

  const save = useMutation({
    mutationFn: () => adminApi("/platform/cloud", { method: "PUT", body: JSON.stringify({ hetzner_token: hetzner || null, cloudflare_token: cloudflare || null, storage_host: stHost || null, storage_user: stUser || null, storage_password: stPass || null, storage_path: stPath || null }) }),
    onSuccess: () => { setHetzner(""); setCloudflare(""); setStPass(""); qc.invalidateQueries({ queryKey: ["cloud", "status"] }); },
  });
  const doVerify = useMutation({ mutationFn: () => adminApi<Verify>("/platform/cloud/verify", { method: "POST" }), onSuccess: (r) => setVerify(r), onError: (e: Error) => alert("Αποτυχία: " + e.message) });
  const clear = useMutation({ mutationFn: () => adminApi("/platform/cloud", { method: "DELETE" }), onSuccess: () => { setVerify(null); qc.invalidateQueries({ queryKey: ["cloud", "status"] }); } });

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
  const Badge = ({ ok }: { ok?: boolean }) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{ok ? "Αποθηκευμένο" : "Μη ρυθμισμένο"}</span>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Cloud className="h-6 w-6 text-brand-600" /> Υποδομή / Cloud</h1>
        <p className="mt-1 text-sm text-slate-500">Τα tokens αποθηκεύονται <b>κρυπτογραφημένα στο Vault</b> — δεν εμφανίζονται ποτέ ξανά, δεν μπαίνουν σε git/logs. Χρησιμοποιούνται για auto-provisioning (Hetzner) & DNS (Cloudflare).</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">Hetzner Cloud <Badge ok={status.data?.hetzner_configured} /></h3>
            <label className="text-xs text-slate-500">API token (Read &amp; Write)
              <input type="password" value={hetzner} onChange={(e) => setHetzner(e.target.value)} placeholder={status.data?.hetzner_configured ? "••••• (αποθηκευμένο — άσε κενό για να μείνει)" : "κόλλα το token"} className={inp} />
            </label>
          </div>
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">Cloudflare (DNS) <Badge ok={status.data?.cloudflare_configured} /></h3>
            <label className="text-xs text-slate-500">API token
              <input type="password" value={cloudflare} onChange={(e) => setCloudflare(e.target.value)} placeholder={status.data?.cloudflare_configured ? "••••• (αποθηκευμένο)" : "κόλλα το token"} className={inp} />
            </label>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending || (!hetzner && !cloudflare)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση</button>
          <button onClick={() => doVerify.mutate()} disabled={doVerify.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{doVerify.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Έλεγχος</button>
          <button onClick={() => { if (confirm("Διαγραφή αποθηκευμένων tokens;")) clear.mutate(); }} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" /> Διαγραφή</button>
        </div>

        {verify && (
          <div className="mt-4 space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            {"hetzner_ok" in verify && <div>Hetzner: {verify.hetzner_ok ? <span className="text-emerald-700">✓ έγκυρο — servers: {(verify.hetzner_servers ?? []).join(", ") || "—"}</span> : <span className="text-rose-600">✕ {verify.hetzner_error || "άκυρο"}</span>}</div>}
            {"cloudflare_ok" in verify && <div>Cloudflare: {verify.cloudflare_ok ? <span className="text-emerald-700">✓ έγκυρο — zones: {(verify.cloudflare_zones ?? []).join(", ") || "—"}</span> : <span className="text-rose-600">✕ {verify.cloudflare_error || "άκυρο"}</span>}</div>}
            {"storage_ok" in verify && <div>Storage: {verify.storage_ok ? <span className="text-emerald-700">✓ προσβάσιμο (SSH/SFTP θύρα 23)</span> : <span className="text-rose-600">✕ {verify.storage_error || "μη προσβάσιμο"}</span>}</div>}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><HardDrive className="h-4 w-4 text-amber-600" /> Backup Storage <Badge ok={status.data?.storage_configured} /></h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">Hetzner Storage Box (ή άλλο SFTP) για offsite backups της βάσης. Ο κωδικός αποθηκεύεται κρυπτογραφημένα, δεν εμφανίζεται ξανά.</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="text-xs text-slate-500">Host
            <input value={stHost} onChange={(e) => setStHost(e.target.value)} placeholder={status.data?.storage_host || "u599547.your-storagebox.de"} className={inp} />
          </label>
          <label className="text-xs text-slate-500">Username
            <input value={stUser} onChange={(e) => setStUser(e.target.value)} placeholder={status.data?.storage_user || "u599547"} className={inp} />
          </label>
          <label className="text-xs text-slate-500">Password
            <input type="password" value={stPass} onChange={(e) => setStPass(e.target.value)} placeholder={status.data?.storage_configured ? "••••• (αποθηκευμένο — άσε κενό για να μείνει)" : "κωδικός storage"} className={inp} />
          </label>
          <label className="text-xs text-slate-500">Φάκελος backup (προαιρετικό)
            <input value={stPath} onChange={(e) => setStPath(e.target.value)} placeholder={status.data?.storage_path || "/rxvision-backups"} className={inp} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση</button>
          <button onClick={() => doVerify.mutate()} disabled={doVerify.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"><ShieldCheck className="h-4 w-4" /> Έλεγχος</button>
        </div>
      </div>

      {status.data?.hetzner_configured && <InfraDashboard />}
    </div>
  );
}
