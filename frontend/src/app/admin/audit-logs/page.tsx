"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";

type AuditLog = {
  _id: string; tenant_id?: string; actor_user_id?: string; action?: string; at?: string;
  outcome?: string; status_code?: number; ip?: string; subject_id?: string; category?: string;
};
type Resp = { page: number; page_size: number; total: number; items: AuditLog[] };

const inp = "rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200";
const EMPTY = { tenant_id: "", actor_user_id: "", action: "", date_from: "", date_to: "" };

export default function AuditLogsPage() {
  const [form, setForm] = useState({ ...EMPTY });
  const [applied, setApplied] = useState({ ...EMPTY });
  const [page, setPage] = useState(1);

  const qs = new URLSearchParams();
  Object.entries(applied).forEach(([k, v]) => { if (v) qs.set(k, v); });
  qs.set("page", String(page));
  qs.set("page_size", "50");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "audit-logs", applied, page],
    queryFn: () => adminApi<Resp>(`/admin/audit-logs?${qs.toString()}`),
    retry: false,
  });

  function setField(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
  }
  function search(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setApplied({ ...form });
  }
  function reset() {
    setForm({ ...EMPTY });
    setApplied({ ...EMPTY });
    setPage(1);
  }

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold text-slate-900 dark:text-slate-100">Αρχείο ενεργειών</h1>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Καταγραφή ενεργειών (read-only) — ποιος, πότε, ποια ενέργεια, σε ποιον tenant.
      </p>

      <form onSubmit={search} className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">Από
          <input type="date" className={`${inp} block`} value={form.date_from} onChange={(e) => setField("date_from", e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">Έως
          <input type="date" className={`${inp} block`} value={form.date_to} onChange={(e) => setField("date_to", e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">Tenant
          <input className={`${inp} block`} placeholder="tenant_id" value={form.tenant_id} onChange={(e) => setField("tenant_id", e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">Χρήστης
          <input className={`${inp} block`} placeholder="user id" value={form.actor_user_id} onChange={(e) => setField("actor_user_id", e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">Ενέργεια
          <input className={`${inp} block`} placeholder="π.χ. gdpr.export" value={form.action} onChange={(e) => setField("action", e.target.value)} />
        </label>
        <button type="submit" className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">Αναζήτηση</button>
        <button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">Καθαρισμός</button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="px-3 py-2">Ημ/νία</th><th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2">Χρήστης</th><th className="px-3 py-2">Ενέργεια</th>
              <th className="px-3 py-2">Έκβαση</th><th className="px-3 py-2">Υποκείμενο</th>
              <th className="px-3 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Φόρτωση…</td></tr>}
            {isError && <tr><td colSpan={7} className="px-3 py-6 text-center text-red-500">Σφάλμα φόρτωσης.</td></tr>}
            {!isLoading && !isError && rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Δεν βρέθηκαν εγγραφές.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r._id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{r.at ? new Date(r.at).toLocaleString("el-GR") : "—"}</td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.tenant_id ?? "—"}</td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.actor_user_id ?? "—"}</td>
                <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{r.action ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className={r.outcome === "error" ? "text-red-600" : "text-emerald-600"}>{r.outcome ?? "—"}{r.status_code ? ` (${r.status_code})` : ""}</span>
                </td>
                <td className="px-3 py-2 text-slate-500">{r.subject_id ?? "—"}</td>
                <td className="px-3 py-2 text-slate-400">{r.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
        <span>{total} εγγραφές</span>
        <div className="flex items-center gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-600">←</button>
          <span>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-600">→</button>
        </div>
      </div>
    </div>
  );
}
