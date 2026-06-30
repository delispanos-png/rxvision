"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Trash2, Plus, Save } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Addon = {
  _id: string; name?: string; description?: string; icon?: string; category?: string;
  price_monthly?: number; price_yearly?: number; features?: string[]; active?: boolean;
};

const eur = (c?: number) => ((c ?? 0) / 100).toString();
const cents = (e: string) => Math.round((parseFloat(e) || 0) * 100);
const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";

export default function AddonsAdminPage() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin", "addons"], queryFn: () => adminApi<{ items: Addon[] }>("/admin/addons") });
  const [drafts, setDrafts] = useState<Record<string, Addon>>({});
  useEffect(() => { if (q.data) setDrafts(Object.fromEntries(q.data.items.map((a) => [a._id, { ...a }]))); }, [q.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "addons"] });
  const set = (id: string, patch: Partial<Addon>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  async function save(id: string) {
    const a = drafts[id];
    await adminApi(`/admin/addons/${id}`, { method: "PUT", body: JSON.stringify({
      name: a.name, description: a.description, icon: a.icon, category: a.category,
      price_monthly: a.price_monthly, price_yearly: a.price_yearly,
      features: a.features, active: a.active,
    }) });
    setNotice(`Αποθηκεύτηκε: ${a.name || id}`); refresh();
  }
  async function del(id: string) {
    if (!confirm(`Διαγραφή add-on «${id}»;`)) return;
    await adminApi(`/admin/addons/${id}`, { method: "DELETE" }); refresh();
  }
  async function create() {
    const id = prompt("Module key του add-on (π.χ. ai_assistant, loyalty):")?.trim();
    if (!id) return;
    await adminApi(`/admin/addons/${id}`, { method: "PUT", body: JSON.stringify({ name: id, active: false, price_monthly: 0 }) });
    refresh();
  }

  const items = Object.values(drafts).sort((a, b) => (a.price_monthly ?? 0) - (b.price_monthly ?? 0));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900"><Sparkles className="h-5 w-5 text-indigo-600" /> Add-ons</h1>
          <p className="text-sm text-slate-500">À-la-carte δυνατότητες. Το <b>_id</b> είναι το module key που ξεκλειδώνει (π.χ. ai_assistant).</p>
        </div>
        <button onClick={create} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><Plus className="h-4 w-4" /> Νέο add-on</button>
      </div>
      {notice && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((a) => (
          <div key={a._id} className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{a._id}</code>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input type="checkbox" checked={!!a.active} onChange={(e) => set(a._id, { active: e.target.checked })} /> Ενεργό
              </label>
            </div>
            <div className="flex gap-2">
              <input className={`${inp} w-16`} value={a.icon ?? ""} onChange={(e) => set(a._id, { icon: e.target.value })} placeholder="✨" />
              <input className={inp} value={a.name ?? ""} onChange={(e) => set(a._id, { name: e.target.value })} placeholder="Όνομα" />
            </div>
            <textarea className={inp} rows={2} value={a.description ?? ""} onChange={(e) => set(a._id, { description: e.target.value })} placeholder="Περιγραφή" />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-500">€/μήνα<input className={inp} type="number" step="1" value={eur(a.price_monthly)} onChange={(e) => set(a._id, { price_monthly: cents(e.target.value) })} /></label>
              <label className="text-xs text-slate-500">€/έτος<input className={inp} type="number" step="1" value={eur(a.price_yearly)} onChange={(e) => set(a._id, { price_yearly: cents(e.target.value) })} /></label>
            </div>
            <input className={inp} value={a.category ?? ""} onChange={(e) => set(a._id, { category: e.target.value })} placeholder="κατηγορία (ai / consumer)" />
            <textarea className={inp} rows={3} value={(a.features ?? []).join("\n")} onChange={(e) => set(a._id, { features: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} placeholder="Χαρακτηριστικά (μία ανά γραμμή)" />
            <div className="flex items-center justify-between pt-1">
              <button onClick={() => del(a._id)} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /> Διαγραφή</button>
              <button onClick={() => save(a._id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"><Save className="h-3.5 w-3.5" /> Αποθήκευση</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
