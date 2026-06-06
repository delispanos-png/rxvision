"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";

type Smtp = {
  configured?: boolean;
  host?: string; port?: number; username?: string;
  from_email?: string; from_name?: string; use_tls?: boolean; has_password?: boolean;
};

export default function SmtpPage() {
  const { data } = useQuery({ queryKey: ["admin", "smtp"], queryFn: () => adminApi<Smtp>("/admin/smtp"), retry: false });
  const [form, setForm] = useState<Smtp>({ port: 587, use_tls: true, from_name: "RxVision" });
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (data && data.host) setForm(data); }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(null);
    try {
      await adminApi("/admin/smtp", { method: "PUT", body: JSON.stringify({ ...form, ...(password ? { password } : {}) }) });
      setNotice("Αποθηκεύτηκε ✓"); setPassword("");
    } catch (e) { setNotice(errMsg(e, "Σφάλμα αποθήκευσης")); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setNotice(null);
    try {
      const r = await adminApi<{ ok: boolean; to: string }>("/admin/smtp/test", { method: "POST", body: JSON.stringify({}) });
      setNotice(`Δοκιμαστικό email στάλθηκε στο ${r.to} ✓`);
    } catch (e) { setNotice(errMsg(e, "Αποτυχία αποστολής")); }
    finally { setBusy(false); }
  }

  // Pull the real SMTP error message out of the API problem detail (was JSON-dumped raw).
  function errMsg(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
      const p: any = e.problem;
      const d = p?.detail ?? p;
      const m = (typeof d === "object" ? d?.message : d) ?? "";
      return `${fallback}${m ? `: ${m}` : ""}`;
    }
    return `${fallback}.`;
  }
  const ssl465 = Number(form.port) === 465;
  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none";
  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-xl font-bold text-slate-900">Ρυθμίσεις SMTP</h1>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}
      <form onSubmit={save} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="col-span-2 text-sm"><span className="mb-1 block text-slate-600">Host</span>
            <input required className={inp} value={form.host ?? ""} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.gmail.com" /></label>
          <label className="text-sm"><span className="mb-1 block text-slate-600">Port</span>
            <input type="number" className={inp} value={form.port ?? 587} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="text-sm"><span className="mb-1 block text-slate-600">Username</span>
            <input className={inp} value={form.username ?? ""} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">
              Password {form.has_password && <span className="font-medium text-emerald-600">✓ αποθηκευμένος</span>}
            </span>
            <input type="password" className={inp} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={form.has_password ? "•••••• (άφησε κενό για να μην αλλάξει)" : "ο κωδικός / app-password"} />
            {form.has_password && <span className="mt-1 block text-[11px] text-slate-400">Ο κωδικός είναι αποθηκευμένος (κρυφός για ασφάλεια). Γράψε εδώ μόνο αν θες να τον αλλάξεις.</span>}
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="text-sm"><span className="mb-1 block text-slate-600">From email</span>
            <input required type="email" className={inp} value={form.from_email ?? ""} onChange={(e) => setForm({ ...form, from_email: e.target.value })} /></label>
          <label className="text-sm"><span className="mb-1 block text-slate-600">From name</span>
            <input className={inp} value={form.from_name ?? ""} onChange={(e) => setForm({ ...form, from_name: e.target.value })} /></label>
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={form.use_tls ?? true} disabled={ssl465} onChange={(e) => setForm({ ...form, use_tls: e.target.checked })} /> STARTTLS
          </label>
          <p className="mt-1 text-[11px] text-slate-400">
            {ssl465
              ? "Port 465 → χρησιμοποιείται αυτόματα κρυπτογράφηση SSL/TLS (το STARTTLS δεν ισχύει εδώ)."
              : "Port 587 → STARTTLS (συνιστάται). Port 465 → SSL αυτόματα. Port 25 → χωρίς κρυπτογράφηση."}
          </p>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">Αποθήκευση</button>
          <button type="button" onClick={test} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">Δοκιμαστικό email</button>
        </div>
      </form>
    </div>
  );
}
