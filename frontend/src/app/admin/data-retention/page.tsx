"use client";

// Διατήρηση δεδομένων — κυλιόμενο παράθυρο ΑΝΑ φαρμακείο (default 36μ· >36 = πρόσθετη υπηρεσία)
// + διαφάνεια αποθηκευτικού χώρου/φαρμακείο. Ο καθαρισμός τρέχει και αυτόματα (μηνιαίο beat).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Database, Trash2, Loader2, HardDrive } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appConfirm } from "@/store/dialogStore";

type PerTenant = { tenant_id: string; name?: string | null; months: number; cutoff: string; executions: number; items: number };
type Storage = { tenant_id: string; name?: string | null; executions: number; items: number; mb: number; retention_months: number; surcharge_cents: number };
type Retention = { executions: number; items: number; per_tenant: PerTenant[]; storage: Storage[]; default_months: number; max_months: number; price_per_year_cents: number };

const MONTH_OPTS = [36, 48, 60, 72, 84, 96, 120];
const gb = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
// τιμή/μήνα για N μήνες = ceil((N-36)/12) × price/έτος
const surchargeFor = (months: number, pricePerYear: number) => Math.max(0, Math.ceil((months - 36) / 12)) * pricePerYear;
const monthsLabel = (m: number, ppy: number) => {
  const s = surchargeFor(m, ppy);
  return `${m} μήνες (${m / 12} χρ.)${m === 36 ? " · βασικό" : ` · +${eur(s)}/μ`}`;
};

export default function DataRetentionPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["data-retention"], queryFn: () => adminApi<Retention>("/admin/data-retention"), retry: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setMonths = useMutation({
    mutationFn: (v: { id: string; months: number }) => adminApi(`/admin/tenants/${v.id}`, { method: "PATCH", body: JSON.stringify({ retention_months: v.months }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["data-retention"] }),
  });
  const ppy = data?.price_per_year_cents ?? 1000;
  const [priceEur, setPriceEur] = useState<string>("");
  const savePrice = useMutation({
    mutationFn: () => adminApi("/admin/data-retention/pricing", { method: "PUT", body: JSON.stringify({ price_per_year_cents: Math.round(parseFloat(priceEur || "0") * 100) }) }),
    onSuccess: () => { setNotice("Η τιμή αποθηκεύτηκε ✓"); qc.invalidateQueries({ queryKey: ["data-retention"] }); },
  });

  async function purge() {
    const n = data?.executions ?? 0;
    if (n === 0) { setNotice("Δεν υπάρχει τίποτα εκτός παραθύρου."); return; }
    if (!(await appConfirm(`ΟΡΙΣΤΙΚΗ διαγραφή ${n.toLocaleString()} εκτελέσεων + ${(data?.items ?? 0).toLocaleString()} ειδών εκτός παραθύρου. Μη αναστρέψιμο. Συνέχεια;`, { title: "Καθαρισμός δεδομένων", confirmText: "Διαγραφή" }))) return;
    setBusy(true); setNotice(null);
    try {
      const r = await adminApi<{ executions: number; items: number }>("/admin/data-retention/purge", { method: "POST" });
      setNotice(`Διαγράφηκαν ${r.executions.toLocaleString()} εκτελέσεις + ${r.items.toLocaleString()} είδη.`);
      qc.invalidateQueries({ queryKey: ["data-retention"] });
    } catch { setNotice("Σφάλμα κατά τον καθαρισμό."); } finally { setBusy(false); }
  }

  // ένωσε storage + «προς διαγραφή» ανά φαρμακείο
  const purgeByTenant: Record<string, PerTenant> = Object.fromEntries((data?.per_tenant ?? []).map((p) => [p.tenant_id, p]));
  const rows = data?.storage ?? [];
  const totalMb = rows.reduce((s, r) => s + r.mb, 0);

  return (
    <div className="w-full">
      <h1 className="mb-1 flex items-center gap-2 text-xl font-bold text-slate-900"><Database className="h-5 w-5 text-indigo-600" /> Διατήρηση δεδομένων</h1>
      <p className="mb-4 text-sm text-slate-500">
        Κυλιόμενο παράθυρο <b>ανά φαρμακείο</b>. Βασικό: <b>{data?.default_months ?? 36} μήνες</b> (χωρίς χρέωση). Μεγαλύτερο = πρόσθετη υπηρεσία.
        Ό,τι βγαίνει εκτός παραθύρου καθαρίζεται <b>αυτόματα (μηνιαία)</b> — εδώ βλέπεις/ρυθμίζεις και τρέχεις χειροκίνητα.
      </p>

      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      {/* Τιμολόγηση extended retention (κλιμακωτά, ανά επιπλέον έτος) */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-sm">
        <span className="font-semibold text-emerald-900">💶 Τιμή ανά επιπλέον έτος:</span>
        <div className="flex items-center gap-1">
          <input type="number" step="0.5" min="0" value={priceEur} onChange={(e) => setPriceEur(e.target.value)}
            placeholder={(ppy / 100).toString()} className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
          <span className="text-slate-500">€/μήνα</span>
        </div>
        <button onClick={() => savePrice.mutate()} disabled={!priceEur || savePrice.isPending}
          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">Αποθήκευση</button>
        <span className="text-[11px] text-emerald-700">Τώρα: <b>{eur(ppy)}/μήνα</b> ανά έτος πάνω από τα 36μ. Μπαίνει αυτόματα στη συνδρομή.</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
        <HardDrive className="h-5 w-5 text-indigo-500" />
        <span className="text-sm text-indigo-900">Συνολικός χώρος (εκτίμηση): <b>{gb(totalMb)}</b> σε {rows.length} φαρμακεία</span>
        <button onClick={purge} disabled={busy || isLoading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Καθαρισμός τώρα ({(data?.executions ?? 0).toLocaleString()})
        </button>
      </div>

      {isLoading ? <div className="py-8 text-center text-sm text-slate-400">Φόρτωση…</div> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Φαρμακείο</th>
                <th className="px-3 py-2">Παράθυρο διατήρησης</th>
                <th className="px-3 py-2 text-right">Χρέωση/μήνα</th>
                <th className="px-3 py-2 text-right">Χώρος (εκτίμ.)</th>
                <th className="px-3 py-2 text-right">Προς διαγραφή</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = purgeByTenant[r.tenant_id];
                return (
                  <tr key={r.tenant_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-800">{r.name || r.tenant_id}</td>
                    <td className="px-3 py-2">
                      <select value={r.retention_months} onChange={(e) => setMonths.mutate({ id: r.tenant_id, months: +e.target.value })}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
                        {MONTH_OPTS.map((m) => <option key={m} value={m}>{monthsLabel(m, ppy)}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.surcharge_cents > 0
                        ? <span className="font-semibold text-emerald-700">+{eur(r.surcharge_cents)}</span>
                        : <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-700">{gb(r.mb)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">{p.executions.toLocaleString()}</span>
                         : <span className="text-xs text-slate-300">—</span>}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-slate-400">Δεν υπάρχουν δεδομένα.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-slate-400">Η μέτρηση χώρου είναι εκτίμηση (πλήθος × μέσο μέγεθος + αναλογικά indexes) — για διαφάνεια κόστους, όχι λογιστική ακρίβεια.</p>
    </div>
  );
}
