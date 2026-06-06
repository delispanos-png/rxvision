"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";

type Maint = { enabled: boolean; message: string };

export default function MaintenancePage() {
  const { data } = useQuery({ queryKey: ["admin", "maintenance"], queryFn: () => adminApi<Maint>("/admin/maintenance"), retry: false });
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (data) { setEnabled(data.enabled); setMessage(data.message); } }, [data]);

  async function save() {
    setBusy(true); setNotice(null);
    try {
      await adminApi("/admin/maintenance", { method: "PUT", body: JSON.stringify({ enabled, message }) });
      setNotice("Αποθηκεύτηκε ✓");
    } finally { setBusy(false); }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-xl font-bold text-slate-900">Συντήρηση</h1>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <label className="mb-4 flex items-center gap-3">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-5 w-5" />
          <span className="font-medium text-slate-800">Ενεργοποίηση maintenance banner στα φαρμακεία</span>
        </label>
        <label className="mb-5 block text-sm">
          <span className="mb-1 block text-slate-600">Μήνυμα προς tenants</span>
          <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="π.χ. Προγραμματισμένη συντήρηση 02:00–03:00."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>

        {enabled && message && (
          <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            Προεπισκόπηση: {message}
          </div>
        )}

        <button onClick={save} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? "…" : "Αποθήκευση"}
        </button>
      </div>
    </div>
  );
}
