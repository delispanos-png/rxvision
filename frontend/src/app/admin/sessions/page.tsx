"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtDateTime } from "@/lib/formatters";

type Session = {
  sid: string; tenant: string; tenant_id: string; username: string; full_name?: string | null;
  ip: string; ua: string; impersonation: boolean; last_active_at: string; created_at: string;
};

function fmtAgo(iso?: string) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}″ πριν`;
  if (s < 3600) return `${Math.round(s / 60)}′ πριν`;
  return fmtDateTime(iso);
}

// σύντομη περιγραφή συσκευής από το user-agent
function device(ua: string) {
  if (!ua) return "—";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ") || ua.slice(0, 40);
}

export default function SessionsPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin", "sessions"], queryFn: () => adminApi<{ items: Session[] }>("/admin/sessions"), retry: false, refetchInterval: 15000 });
  const revoke = useMutation({
    mutationFn: (sid: string) => adminApi(`/admin/sessions/${sid}/revoke`, { method: "POST" }),
    onSettled: () => { setBusy(null); qc.invalidateQueries({ queryKey: ["admin", "sessions"] }); },
  });
  const rows = q.data?.items ?? [];

  const kick = (s: Session) => {
    if (!window.confirm(`Αποσύνδεση του χρήστη ${s.username}${s.full_name ? ` (${s.full_name})` : ""} από ${s.ip};\n\nΗ συσκευή αποσυνδέεται άμεσα.`)) return;
    setBusy(s.sid); revoke.mutate(s.sid);
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-900">Συνδεδεμένοι χρήστες</h1>
      <p className="mt-1 text-sm text-slate-500">Ενεργές συνεδρίες (ανά συσκευή) — username, IP, φαρμακείο & τελευταία δραστηριότητα. Μπορείς να αποσυνδέσεις οποιονδήποτε άμεσα.</p>

      <div className="mt-4 flex items-center gap-3 text-sm text-slate-500">
        <span className="rounded-lg bg-slate-100 px-3 py-1 font-semibold text-slate-700">{rows.length} ενεργές συνεδρίες</span>
        {q.isFetching && <span className="text-slate-400">ανανέωση…</span>}
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">Χρήστης</th>
              <th className="px-4 py-3">Φαρμακείο</th>
              <th className="px-4 py-3">IP</th>
              <th className="px-4 py-3">Συσκευή</th>
              <th className="px-4 py-3">Τελευταία δράση</th>
              <th className="px-4 py-3 text-right">Ενέργεια</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((s) => (
              <tr key={s.sid} className="hover:bg-slate-50/60">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">{s.username}{s.impersonation && <span className="ml-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">impersonation</span>}</div>
                  {s.full_name && <div className="text-xs text-slate-400">{s.full_name}</div>}
                </td>
                <td className="px-4 py-3 text-slate-600">{s.tenant}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{s.ip}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{device(s.ua)}</td>
                <td className="px-4 py-3 text-slate-500">{fmtAgo(s.last_active_at)}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => kick(s)} disabled={busy === s.sid}
                    className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                    {busy === s.sid ? "Αποσύνδεση…" : "Αποσύνδεση"}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">{q.isLoading ? "Φόρτωση…" : "Καμία ενεργή συνεδρία."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
