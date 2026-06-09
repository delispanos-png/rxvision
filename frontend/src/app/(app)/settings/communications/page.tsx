"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Loader2, Check, Settings } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";

type S = {
  email_configured: boolean; from_name?: string | null; from_email?: string | null;
  smtp_host?: string | null; smtp_port?: number; smtp_username?: string | null; smtp_use_tls?: boolean;
  sms_configured: boolean; sms_sender?: string | null;
};

export default function CommsSettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["comms", "settings"], queryFn: () => api<S>("/communications/settings"), retry: false });
  const [f, setF] = useState<Record<string, string | number | boolean>>({ smtp_port: 587, smtp_use_tls: true });
  useEffect(() => { if (settings.data) setF((s) => ({ ...s, from_name: settings.data.from_name || "", from_email: settings.data.from_email || "", smtp_host: settings.data.smtp_host || "", smtp_port: settings.data.smtp_port || 587, smtp_username: settings.data.smtp_username || "", smtp_use_tls: settings.data.smtp_use_tls ?? true, sms_sender: settings.data.sms_sender || "" })); }, [settings.data]);
  const set = (k: string, v: string | number | boolean) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({ mutationFn: () => api("/communications/settings", { method: "PUT", body: JSON.stringify(f) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["comms", "settings"] }) });
  const [testTo, setTestTo] = useState("");
  const testEmail = useMutation({ mutationFn: () => api(`/communications/test-email?to=${encodeURIComponent(testTo)}`, { method: "POST" }), onError: (e: Error) => alert("Αποτυχία: " + e.message), onSuccess: () => alert("Στάλθηκε δοκιμαστικό email ✅") });
  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none";

  return (
    <PanelCard title="Ρυθμίσεις αποστολέα (email & SMS)">
      <p className="-mt-1 mb-4 text-xs text-slate-400">Τα emails φεύγουν από το <b>δικό σου</b> mail account· τα SMS μέσω Apifon. Τα στοιχεία αποθηκεύονται κρυπτογραφημένα.</p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><Mail className="h-4 w-4" /> Email (SMTP του φαρμακείου)</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 text-xs text-slate-500">Όνομα αποστολέα<input value={String(f.from_name ?? "")} onChange={(e) => set("from_name", e.target.value)} placeholder="Φαρμακείο …" className={inp} /></label>
            <label className="col-span-2 text-xs text-slate-500">Email αποστολέα<input value={String(f.from_email ?? "")} onChange={(e) => set("from_email", e.target.value)} placeholder="info@pharmacy.gr" className={inp} /></label>
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
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Settings className="h-4 w-4" />} Αποθήκευση</button>
        <span className="mx-2 text-slate-300">·</span>
        <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="email για δοκιμή" className="w-52 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <button onClick={() => testEmail.mutate()} disabled={testEmail.isPending || !testTo} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{testEmail.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Δοκιμή email</button>
      </div>
    </PanelCard>
  );
}
