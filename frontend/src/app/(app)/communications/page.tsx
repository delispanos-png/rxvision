"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Loader2, Check, Settings, Users } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PanelCard } from "@/components/ui/Card";

type Settings = {
  email_configured: boolean; from_name?: string | null; from_email?: string | null;
  smtp_host?: string | null; smtp_port?: number; smtp_username?: string | null; smtp_use_tls?: boolean;
  sms_configured: boolean; sms_sender?: string | null;
};
type Campaign = { id: string; channel: string; subject?: string | null; recipients: number; sent: number; failed: number; created_at: string };

export default function CommunicationsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["comms", "settings"], queryFn: () => api<Settings>("/communications/settings"), retry: false });
  const history = useQuery({ queryKey: ["comms", "history"], queryFn: () => api<{ items: Campaign[] }>("/communications/history"), retry: false });

  // settings form
  const [f, setF] = useState<Record<string, string | number | boolean>>({ smtp_port: 587, smtp_use_tls: true });
  useEffect(() => { if (settings.data) setF((s) => ({ ...s, from_name: settings.data.from_name || "", from_email: settings.data.from_email || "", smtp_host: settings.data.smtp_host || "", smtp_port: settings.data.smtp_port || 587, smtp_username: settings.data.smtp_username || "", smtp_use_tls: settings.data.smtp_use_tls ?? true, sms_sender: settings.data.sms_sender || "" })); }, [settings.data]);
  const set = (k: string, v: string | number | boolean) => setF((s) => ({ ...s, [k]: v }));
  const saveSettings = useMutation({ mutationFn: () => api("/communications/settings", { method: "PUT", body: JSON.stringify(f) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["comms", "settings"] }) });
  const [testTo, setTestTo] = useState("");
  const testEmail = useMutation({ mutationFn: () => api(`/communications/test-email?to=${encodeURIComponent(testTo)}`, { method: "POST" }), onError: (e: Error) => alert("Αποτυχία: " + e.message), onSuccess: () => alert("Στάλθηκε δοκιμαστικό email ✅") });

  // composer
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const audience = useQuery({ queryKey: ["comms", "audience", channel], queryFn: () => api<{ count: number }>(`/communications/audience?channel=${channel}`), retry: false });
  const send = useMutation({
    mutationFn: () => api<{ recipients: number; sent: number; failed: number }>("/communications/send", { method: "POST", body: JSON.stringify({ channel, subject, message }) }),
    onSuccess: (r) => { alert(`Στάλθηκαν ${r.sent}/${r.recipients} (${r.failed} αποτυχίες)`); setMessage(""); setSubject(""); qc.invalidateQueries({ queryKey: ["comms", "history"] }); },
    onError: (e: Error) => alert("Αποτυχία: " + e.message),
  });

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none";

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><Mail className="h-6 w-6 text-brand-600" /> Επικοινωνία</h1>
        <p className="mt-1 text-sm text-slate-500">Newsletter & ειδοποιήσεις προς ασθενείς με συγκατάθεση — email ή SMS.</p>
      </div>

      <div className="space-y-4">
        {/* composer */}
        <PanelCard title="Νέα αποστολή">
          <div className="mb-3 flex gap-2">
            <button onClick={() => setChannel("email")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "email" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><Mail className="h-4 w-4" /> Email</button>
            <button onClick={() => setChannel("sms")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "sms" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><MessageSquare className="h-4 w-4" /> SMS</button>
            <span className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-500"><Users className="h-4 w-4" /> Παραλήπτες με συγκατάθεση: <b className="text-slate-800">{audience.data?.count ?? "…"}</b></span>
          </div>
          {channel === "email" && <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Θέμα email" className={`${inp} mb-2`} />}
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} placeholder={channel === "sms" ? "Κείμενο SMS (σύντομο)…" : "Μήνυμα…"} className={inp} />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">{channel === "sms" ? `${message.length} χαρακτήρες` : ""}</span>
            <button onClick={() => { if (message.trim() && confirm(`Αποστολή σε ${audience.data?.count ?? 0} παραλήπτες;`)) send.mutate(); }}
              disabled={send.isPending || !message.trim() || !(audience.data?.count)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Αποστολή
            </button>
          </div>
        </PanelCard>

        {/* sender settings */}
        <PanelCard collapsible defaultOpen={!settings.data?.email_configured} title="Ρυθμίσεις αποστολέα (email & SMS)">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><Mail className="h-4 w-4" /> Email (SMTP του φαρμακείου)</h3>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-500 col-span-2">Όνομα αποστολέα<input value={String(f.from_name ?? "")} onChange={(e) => set("from_name", e.target.value)} placeholder="Φαρμακείο …" className={inp} /></label>
                <label className="text-xs text-slate-500 col-span-2">Email αποστολέα<input value={String(f.from_email ?? "")} onChange={(e) => set("from_email", e.target.value)} placeholder="info@pharmacy.gr" className={inp} /></label>
                <label className="text-xs text-slate-500">SMTP host<input value={String(f.smtp_host ?? "")} onChange={(e) => set("smtp_host", e.target.value)} placeholder="smtp.gmail.com" className={inp} /></label>
                <label className="text-xs text-slate-500">Θύρα<input value={String(f.smtp_port ?? 587)} onChange={(e) => set("smtp_port", Number(e.target.value))} className={inp} /></label>
                <label className="text-xs text-slate-500">Χρήστης<input value={String(f.smtp_username ?? "")} onChange={(e) => set("smtp_username", e.target.value)} className={inp} /></label>
                <label className="text-xs text-slate-500">Κωδικός<input type="password" onChange={(e) => set("smtp_password", e.target.value)} placeholder={settings.data?.email_configured ? "••••• (αποθηκευμένο)" : ""} className={inp} /></label>
              </div>
            </div>
            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><MessageSquare className="h-4 w-4" /> SMS (Apifon)</h3>
              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-slate-500">Όνομα αποστολέα SMS<input value={String(f.sms_sender ?? "")} onChange={(e) => set("sms_sender", e.target.value)} placeholder="PHARMACY" className={inp} /></label>
                <label className="text-xs text-slate-500">Apifon token<input onChange={(e) => set("apifon_token", e.target.value)} placeholder={settings.data?.sms_configured ? "••••• (αποθηκευμένο)" : ""} className={inp} /></label>
                <label className="text-xs text-slate-500">Apifon secret<input type="password" onChange={(e) => set("apifon_secret", e.target.value)} placeholder={settings.data?.sms_configured ? "••••• (αποθηκευμένο)" : ""} className={inp} /></label>
                <p className="text-[11px] text-slate-400">Τα στοιχεία SMS τα παίρνεις από τον λογαριασμό σου στην Apifon.</p>
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{saveSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : saveSettings.isSuccess ? <Check className="h-4 w-4" /> : <Settings className="h-4 w-4" />} Αποθήκευση</button>
            <span className="mx-2 text-slate-300">·</span>
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="email για δοκιμή" className="w-52 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button onClick={() => testEmail.mutate()} disabled={testEmail.isPending || !testTo} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{testEmail.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Δοκιμή email</button>
          </div>
        </PanelCard>

        {/* history */}
        <PanelCard collapsible defaultOpen={false} title="Ιστορικό αποστολών">
          {(history.data?.items?.length ?? 0) === 0 ? <p className="text-sm text-slate-400">Καμία αποστολή ακόμη.</p> : (
            <div className="divide-y divide-slate-100">
              {history.data!.items.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="flex items-center gap-2 text-slate-700">{c.channel === "email" ? <Mail className="h-4 w-4 text-slate-400" /> : <MessageSquare className="h-4 w-4 text-slate-400" />}{c.subject || (c.channel === "sms" ? "SMS" : "Email")}</span>
                  <span className="text-slate-500">{new Date(c.created_at).toLocaleDateString("el-GR")} · {c.sent}/{c.recipients} {c.failed ? `· ${c.failed} ✗` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
