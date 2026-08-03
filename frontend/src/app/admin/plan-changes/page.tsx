"use client";

import Link from "next/link";
import { appConfirm } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtDateTime } from "@/lib/formatters";
import { Building2, Check, X, Loader2, ArrowUp, ArrowDown, CreditCard } from "lucide-react";

type Req = {
  tenant_id: string; tenant_name?: string; current_plan?: string; billing_cycle?: string;
  kind?: "upgrade" | "downgrade"; method?: "card" | "bank"; status?: string;
  plan?: string; plan_name?: string; new_price?: number; reference?: string;
  requested_by?: string; requested_at?: string; effective_at?: string;
};

const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);

export default function PlanChangesPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["admin", "plan-changes"], queryFn: () => adminApi<{ items: Req[] }>("/admin/plan-changes"), retry: false, refetchInterval: 30000 });

  const act = async (tid: string, action: "approve" | "reject") => {
    if (action === "approve" && !(await appConfirm("Επιβεβαίωση λήψης κατάθεσης & ενεργοποίηση της αναβάθμισης;", { title: "Έγκριση αναβάθμισης", confirmText: "Έγκριση" }))) return;
    if (action === "reject" && !(await appConfirm("Απόρριψη/ακύρωση του αιτήματος;", { title: "Απόρριψη", danger: true, confirmText: "Απόρριψη" }))) return;
    setBusy(tid);
    try { await adminApi(`/admin/plan-changes/${tid}/${action}`, { method: "POST" }); }
    finally { setBusy(null); qc.invalidateQueries({ queryKey: ["admin", "plan-changes"] }); }
  };

  const rows = q.data?.items ?? [];
  const bankReqs = rows.filter((r) => r.method === "bank" && r.status === "awaiting_payment");
  const others = rows.filter((r) => !(r.method === "bank" && r.status === "awaiting_payment"));

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Αιτήματα αναβάθμισης πλάνου</h1>
        <p className="mt-1 text-sm text-slate-500">Αναβαθμίσεις με τραπεζική κατάθεση προς έγκριση, και όλες οι εκκρεμείς αλλαγές πλάνου. Ο τραπεζικός λογαριασμός ρυθμίζεται στο <Link href="/admin/payments" className="text-brand-600 hover:underline">Τρόποι πληρωμής</Link>.</p>
      </div>

      {/* ── Αιτήματα προς έγκριση (τραπεζική κατάθεση) ── */}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700"><Building2 className="h-4 w-4 text-amber-500" /> Προς έγκριση — τραπεζική κατάθεση ({bankReqs.length})</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">Φαρμακείο</th><th className="px-4 py-3">Αναβάθμιση σε</th>
              <th className="px-4 py-3">Ποσό</th><th className="px-4 py-3">Αιτιολογία</th>
              <th className="px-4 py-3">Αίτημα</th><th className="px-4 py-3 text-right">Ενέργεια</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-50">
              {bankReqs.map((r) => (
                <tr key={r.tenant_id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3"><div className="font-medium text-slate-800">{r.tenant_name || r.tenant_id}</div><div className="text-xs text-slate-400">{r.current_plan} → {r.plan}</div></td>
                  <td className="px-4 py-3 text-slate-700">{r.plan_name || r.plan}</td>
                  <td className="px-4 py-3 font-semibold text-slate-800">{eur(r.new_price)}<span className="text-xs font-normal text-slate-400">/{r.billing_cycle === "yearly" ? "έτος" : "μήνα"}</span></td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.reference}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{r.requested_at ? fmtDateTime(r.requested_at) : "—"}<div className="text-slate-400">{r.requested_by}</div></td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-2">
                      <button disabled={busy === r.tenant_id} onClick={() => act(r.tenant_id, "approve")} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{busy === r.tenant_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Ενεργοποίηση</button>
                      <button disabled={busy === r.tenant_id} onClick={() => act(r.tenant_id, "reject")} className="inline-flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50"><X className="h-3.5 w-3.5" /> Απόρριψη</button>
                    </div>
                  </td>
                </tr>
              ))}
              {bankReqs.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">{q.isLoading ? "Φόρτωση…" : "Κανένα αίτημα προς έγκριση."}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Λοιπές εκκρεμείς αλλαγές (πληροφοριακά) ── */}
      {others.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold text-slate-700">Λοιπές εκκρεμείς αλλαγές</h2>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Φαρμακείο</th><th className="px-4 py-3">Τύπος</th><th className="px-4 py-3">Πλάνο</th>
                <th className="px-4 py-3">Κατάσταση</th><th className="px-4 py-3">Ισχύς</th><th className="px-4 py-3 text-right">Ενέργεια</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-50">
                {others.map((r) => (
                  <tr key={r.tenant_id}>
                    <td className="px-4 py-3 text-slate-700">{r.tenant_name || r.tenant_id}</td>
                    <td className="px-4 py-3">{r.kind === "upgrade" ? <span className="inline-flex items-center gap-1 text-brand-600"><ArrowUp className="h-3.5 w-3.5" /> Αναβάθμιση</span> : <span className="inline-flex items-center gap-1 text-slate-500"><ArrowDown className="h-3.5 w-3.5" /> Υποβάθμιση</span>}{r.method === "card" && <CreditCard className="ml-1 inline h-3.5 w-3.5 text-slate-400" />}</td>
                    <td className="px-4 py-3 text-slate-600">{r.plan_name || r.plan}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.status}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.effective_at ? new Date(r.effective_at).toLocaleDateString("el-GR") : "—"}</td>
                    <td className="px-4 py-3 text-right"><button disabled={busy === r.tenant_id} onClick={() => act(r.tenant_id, "reject")} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">Ακύρωση</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
