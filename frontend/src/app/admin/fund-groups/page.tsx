"use client";

import { appConfirm } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Trash2, Plus } from "lucide-react";

type Group = { id: string; name: string; codes: string[]; color?: string | null };
type Fund = { code: string; name: string; tenants: number; group?: string | null };

export default function FundGroupsPage() {
  const qc = useQueryClient();
  const inval = () => qc.invalidateQueries({ queryKey: ["fg"] });

  const groups = useQuery({ queryKey: ["fg", "groups"], queryFn: () => adminApi<{ items: Group[] }>("/platform/fund-groups"), retry: false });
  const catalog = useQuery({ queryKey: ["fg", "catalog"], queryFn: () => adminApi<{ items: Fund[] }>("/platform/fund-groups/catalog"), retry: false });

  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");

  const create = useMutation({ mutationFn: (name: string) => adminApi("/platform/fund-groups", { method: "POST", body: JSON.stringify({ name, codes: [] }) }), onSuccess: () => { setNewName(""); inval(); } });
  const rename = useMutation({ mutationFn: (g: { id: string; name: string; codes: string[] }) => adminApi(`/platform/fund-groups/${g.id}`, { method: "PUT", body: JSON.stringify({ name: g.name, codes: g.codes }) }), onSuccess: inval });
  const del = useMutation({ mutationFn: (id: string) => adminApi(`/platform/fund-groups/${id}`, { method: "DELETE" }), onSuccess: inval });
  const assign = useMutation({ mutationFn: (v: { code: string; group_id: string | null }) => adminApi("/platform/fund-groups/assign", { method: "POST", body: JSON.stringify(v) }), onSuccess: inval });

  const gs = groups.data?.items ?? [];
  const funds = (catalog.data?.items ?? []).filter((f) => !filter || f.name.toLowerCase().includes(filter.toLowerCase()) || f.code.toLowerCase().includes(filter.toLowerCase()));
  const assignedCount = (gid: string) => gs.find((g) => g.id === gid)?.codes.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Ομάδες ταμείων</h1>
        <p className="mt-1 text-sm text-slate-500">
          Ορίζονται <b>κεντρικά</b> και ισχύουν σε <b>όλα τα φαρμακεία</b> — που βλέπουν τα ταμεία ομαδοποιημένα (π.χ. ΕΟΠΥΥ). Ταμεία χωρίς ομάδα εμφανίζονται μόνα τους.
        </p>
      </div>

      {/* groups manager */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Ομάδες ({gs.length})</h2>
        <div className="mb-4 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) create.mutate(newName.trim()); }}
            placeholder="Νέα ομάδα (π.χ. ΕΟΠΥΥ, Δημόσιο, Ναυτικοί)"
            className="w-72 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <button onClick={() => newName.trim() && create.mutate(newName.trim())} disabled={!newName.trim() || create.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            <Plus className="h-4 w-4" /> Προσθήκη
          </button>
        </div>
        {gs.length === 0 ? (
          <p className="text-sm text-slate-400">Καμία ομάδα ακόμη. Πρόσθεσε μία και μετά ανάθεσε ταμεία παρακάτω.</p>
        ) : (
          <div className="space-y-2">
            {gs.map((g) => (
              <div key={g.id} className="flex items-center gap-3">
                <input
                  defaultValue={g.name}
                  onBlur={(e) => { if (e.target.value.trim() && e.target.value !== g.name) rename.mutate({ id: g.id, name: e.target.value.trim(), codes: g.codes }); }}
                  className="w-72 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-800 focus:border-brand-500 focus:outline-none"
                />
                <span className="text-xs text-slate-400">{assignedCount(g.id)} ταμεία</span>
                <button onClick={async () => { if (await appConfirm(`Διαγραφή ομάδας «${g.name}»;`, { danger: true })) del.mutate(g.id); }}
                  className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Διαγραφή">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* funds catalog with assignment */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-700">Ταμεία ({funds.length}) — ανάθεση σε ομάδα</h2>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Αναζήτηση ταμείου…"
            className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-500">Ταμείο</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500">Κωδικός ΗΔΥΚΑ</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Φαρμακεία</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500">Ομάδα</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {funds.map((f) => {
                const cur = gs.find((g) => g.codes.includes(f.code));
                return (
                  <tr key={f.code} className={cur ? "bg-brand-50/30" : ""}>
                    <td className="px-3 py-2 text-slate-800">{f.name}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{f.code}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{f.tenants}</td>
                    <td className="px-3 py-2">
                      <select
                        value={cur?.id ?? ""}
                        onChange={(e) => assign.mutate({ code: f.code, group_id: e.target.value || null })}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                      >
                        <option value="">— (καμία)</option>
                        {gs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
