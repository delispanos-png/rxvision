"use client";

import { appConfirm } from "@/store/dialogStore";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";

type Tenant = { id: string; name: string; plan: string; status: string; users: number; mrr: number; created_at: string };
type Package = { _id: string; name: string; price_monthly: number; modules: string[]; seats: number; trial_days: number };

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700",
  trial: "bg-sky-100 text-sky-700",
  past_due: "bg-red-100 text-red-700",
  suspended: "bg-slate-200 text-slate-600",
};
function Badge({ value }: { value: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-600"}`}>{value}</span>;
}

export default function SubscribersPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), retry: false });
  const rows = tenants.data?.items ?? [];

  async function toggleStatus(t: Tenant) {
    const next = t.status === "suspended" ? "active" : "suspended";
    if (!(await appConfirm(`Αλλαγή κατάστασης «${t.name}» σε ${next};`, { title: "Αλλαγή κατάστασης", confirmText: "Αλλαγή" }))) return;
    await adminApi(`/admin/tenants/${t.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) });
    qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
  }

  const columns: Column<Tenant>[] = [
    { key: "name", header: "Tenant" },
    { key: "plan", header: "Πλάνο" },
    { key: "status", header: "Κατάσταση", render: (r) => <Badge value={r.status} /> },
    { key: "users", header: "Χρήστες", align: "right", render: (r) => fmtNum(r.users) },
    { key: "mrr", header: "MRR", align: "right", render: (r) => fmtEur(r.mrr) },
    { key: "created_at", header: "Εγγραφή", render: (r) => fmtDate(r.created_at) },
    {
      key: "actions", header: "", align: "right", fullWidthOnMobile: true,
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={(e) => { e.stopPropagation(); router.push(`/admin/subscribers/${encodeURIComponent(r.id)}`); }}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Καρτέλα</button>
          <button onClick={(e) => { e.stopPropagation(); toggleStatus(r); }}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">
            {r.status === "suspended" ? "Ενεργοποίηση" : "Αναστολή"}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">Συνδρομητές</h1>
        <button onClick={() => setOpen(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + Άνοιγμα tenant
        </button>
      </div>

      {tenants.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />}

      {open && <OpenTenantModal onClose={() => setOpen(false)} onDone={() => qc.invalidateQueries({ queryKey: ["admin", "tenants"] })} />}
    </div>
  );
}

function OpenTenantModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const packages = useQuery({ queryKey: ["admin", "packages"], queryFn: () => adminApi<{ items: Package[] }>("/admin/packages"), retry: false });
  const [form, setForm] = useState({ name: "", owner_email: "", owner_name: "", package_code: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tenant_id: string; owner_email: string; temp_password: string | null } | null>(null);

  const pkgs = packages.data?.items ?? [];
  const pkg = form.package_code || pkgs[0]?._id || "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await adminApi<{ tenant_id: string; owner_email: string; temp_password: string | null }>(
        "/admin/tenants", { method: "POST", body: JSON.stringify({ ...form, package_code: pkg }) });
      setResult(r); onDone();
    } catch (e) {
      setError(e instanceof ApiError ? "Σφάλμα — δοκιμάστε ξανά." : "Σφάλμα.");
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose}>
      {result ? (
          <div>
            <h2 className="mb-2 text-lg font-bold text-emerald-700">✓ Ο tenant άνοιξε</h2>
            <div className="space-y-1 rounded-lg bg-slate-50 p-4 text-sm">
              <div><b>Tenant:</b> {result.tenant_id}</div>
              <div><b>Owner:</b> {result.owner_email}</div>
              {result.temp_password && (
                <div className="text-amber-700"><b>Προσωρινός κωδικός:</b> <code>{result.temp_password}</code></div>
              )}
            </div>
            <button onClick={onClose} className="mt-4 w-full rounded-lg bg-indigo-600 py-2 text-white">Κλείσιμο</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h2 className="mb-4 text-lg font-bold text-slate-900">Άνοιγμα νέου tenant</h2>
            <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Επωνυμία φαρμακείου</span>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Email owner</span>
              <input required type="email" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Όνομα owner (προαιρετικό)</span>
              <input value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label className="mb-5 block text-sm"><span className="mb-1 block text-slate-600">Πακέτο</span>
              <select value={pkg} onChange={(e) => setForm({ ...form, package_code: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2">
                {pkgs.map((p) => <option key={p._id} value={p._id}>{p.name} — {p.price_monthly ? fmtEur(p.price_monthly) + "/μήνα" : "δωρεάν"}{p.trial_days ? ` (trial ${p.trial_days}ημ)` : ""}</option>)}
              </select></label>
            {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">Άκυρο</button>
              <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? "Άνοιγμα…" : "Άνοιγμα tenant"}</button>
            </div>
          </form>
        )}
    </Modal>
  );
}
