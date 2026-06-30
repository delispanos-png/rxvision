"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Trash2, Plus, Save, Headphones } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Pkg = {
  _id: string; name?: string; description?: string;
  price_monthly?: number; price_yearly?: number; extra_user_price?: number; extra_user_price_yearly?: number;
  trial_days?: number; seats?: number;
  sla?: string; modules?: string[]; features?: string[]; billing_cycles?: string[]; active?: boolean;
};
type Sla = { _id: string; name?: string; description?: string; response_hours?: number; channels?: string; price_monthly?: number; price_yearly?: number; active?: boolean };

// Capabilities a package can grant — same catalogue as the subscriber detail toggles.
const MODULE_LABELS: [string, string][] = [
  ["dashboard", "Πίνακας Ελέγχου"], ["prescription_analytics", "Συνταγές"],
  ["doctor_analytics", "Ιατροί"], ["patient_analytics", "Ασθενείς / Patient Intelligence"],
  ["icd10_analytics", "ICD-10"], ["profitability", "Κερδοφορία"],
  ["future_prescriptions", "Μελλοντικές συνταγές"], ["order_suggestions", "Σύμβουλος Παραγγελιών"],
  ["monthly_closing", "Αποζημίωση / Κλείσιμο"], ["ingestion", "Λήψη ΗΔΥΚΑ"], ["pharmacyone", "PharmacyOne"],
  ["ai_assistant", "✨ AI Βοηθός (Prescriptor/PharmaCat/Copilot)"],
  ["pharmacat", "🤖 PharmaCat"], ["patient_portal", "👥 Πύλη Πελατών"], ["loyalty", "🎁 Πιστότητα"],
];

const eur = (c?: number) => ((c ?? 0) / 100).toString();
const cents = (e: string) => Math.round((parseFloat(e) || 0) * 100);
const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";

export default function PackagesAdminPage() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["admin", "packages"] }); qc.invalidateQueries({ queryKey: ["admin", "sla"] }); };

  const pkgsQ = useQuery({ queryKey: ["admin", "packages"], queryFn: () => adminApi<{ items: Pkg[] }>("/admin/packages") });
  const slaQ = useQuery({ queryKey: ["admin", "sla"], queryFn: () => adminApi<{ items: Sla[] }>("/admin/sla") });

  const [drafts, setDrafts] = useState<Record<string, Pkg>>({});
  useEffect(() => {
    if (pkgsQ.data) setDrafts(Object.fromEntries(pkgsQ.data.items.map((p) => [p._id, { ...p }])));
  }, [pkgsQ.data]);
  const [slaDrafts, setSlaDrafts] = useState<Record<string, Sla>>({});
  useEffect(() => {
    if (slaQ.data) setSlaDrafts(Object.fromEntries(slaQ.data.items.map((s) => [s._id, { ...s }])));
  }, [slaQ.data]);

  const slaTiers = slaQ.data?.items ?? [];

  function setP(code: string, patch: Partial<Pkg>) { setDrafts((d) => ({ ...d, [code]: { ...d[code], ...patch } })); }
  function toggleMod(code: string, key: string) {
    setDrafts((d) => {
      const cur = new Set(d[code]?.modules ?? []);
      cur.has(key) ? cur.delete(key) : cur.add(key);
      return { ...d, [code]: { ...d[code], modules: [...cur] } };
    });
  }
  async function savePkg(code: string) {
    const p = drafts[code];
    await adminApi(`/admin/packages/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify({
      name: p.name, description: p.description, price_monthly: p.price_monthly, price_yearly: p.price_yearly,
      extra_user_price: p.extra_user_price, extra_user_price_yearly: p.extra_user_price_yearly,
      trial_days: p.trial_days, seats: p.seats, sla: p.sla,
      modules: p.modules ?? [], features: p.features ?? [],
      billing_cycles: p.billing_cycles ?? ["monthly", "yearly"], active: p.active ?? true,
    }) });
    setNotice(`Αποθηκεύτηκε το πακέτο «${p.name || code}» ✓`); refresh();
  }
  async function delPkg(code: string) {
    if (!window.confirm(`Διαγραφή πακέτου «${code}»;`)) return;
    await adminApi(`/admin/packages/${encodeURIComponent(code)}`, { method: "DELETE" });
    setNotice("Διαγράφηκε."); refresh();
  }
  const [newCode, setNewCode] = useState("");
  async function createPkg() {
    const code = newCode.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!code) return;
    await adminApi(`/admin/packages/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify({
      name: code, price_monthly: 0, trial_days: 14, seats: 1, modules: [], active: true,
    }) });
    setNewCode(""); setNotice(`Δημιουργήθηκε το πακέτο «${code}» ✓`); refresh();
  }

  function setS(code: string, patch: Partial<Sla>) { setSlaDrafts((d) => ({ ...d, [code]: { ...d[code], ...patch } })); }
  async function saveSla(code: string) {
    const s = slaDrafts[code];
    await adminApi(`/admin/sla/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify({
      name: s.name, description: s.description, response_hours: s.response_hours, channels: s.channels,
      price_monthly: s.price_monthly ?? 0, price_yearly: s.price_yearly ?? 0, active: s.active ?? true,
    }) });
    setNotice(`Αποθηκεύτηκε το SLA «${s.name || code}» ✓`); refresh();
  }
  async function delSla(code: string) { if (window.confirm(`Διαγραφή SLA «${code}»;`)) { await adminApi(`/admin/sla/${encodeURIComponent(code)}`, { method: "DELETE" }); refresh(); } }
  const [newSla, setNewSla] = useState("");
  async function createSla() {
    const code = newSla.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!code) return;
    await adminApi(`/admin/sla/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify({ name: code, response_hours: 24, channels: "email" }) });
    setNewSla(""); refresh();
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg"><Boxes className="h-6 w-6" /></span>
        <div>
          <h1 className="text-xl font-bold text-slate-900">Πακέτα Συνδρομής & SLA</h1>
          <p className="text-sm text-slate-500">Όρισε τιμές, δοκιμή, θέσεις, υποστήριξη και τις δυνατότητες (modules) κάθε πακέτου.</p>
        </div>
      </div>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      {/* ── packages ─────────────────────────────────────────── */}
      <div className="space-y-4">
        {pkgsQ.isLoading && <div className="text-slate-400">Φόρτωση…</div>}
        {Object.values(drafts).map((p) => (
          <div key={p._id} className={`rounded-2xl border bg-white p-5 shadow-sm ${(p.active ?? true) ? "border-slate-200" : "border-slate-200 opacity-70"}`}>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{p._id}</code>
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={p.active ?? true} onChange={(e) => setP(p._id, { active: e.target.checked })} className="h-4 w-4 accent-indigo-600" /> Ενεργό</label>
                {!(p.active ?? true) && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">δεν προτείνεται σε νέες συνδρομές</span>}
              </div>
              <button onClick={() => delPkg(p._id)} className="inline-flex items-center gap-1 text-xs text-rose-600 hover:underline"><Trash2 className="h-3.5 w-3.5" /> Διαγραφή</button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block text-xs font-medium text-slate-500">Όνομα<input className={`mt-1 ${inp}`} value={p.name ?? ""} onChange={(e) => setP(p._id, { name: e.target.value })} /></label>
              <label className="block text-xs font-medium text-slate-500">Τιμή/μήνα (€)<input type="number" className={`mt-1 ${inp}`} value={eur(p.price_monthly)} onChange={(e) => setP(p._id, { price_monthly: cents(e.target.value) })} /></label>
              <label className="block text-xs font-medium text-slate-500">Τιμή/έτος (€)<input type="number" className={`mt-1 ${inp}`} value={eur(p.price_yearly)} onChange={(e) => setP(p._id, { price_yearly: cents(e.target.value) })} /></label>
              <label className="block text-xs font-medium text-slate-500">Δοκιμή (ημέρες)<input type="number" className={`mt-1 ${inp}`} value={p.trial_days ?? 0} onChange={(e) => setP(p._id, { trial_days: parseInt(e.target.value) || 0 })} /></label>
              <label className="block text-xs font-medium text-slate-500">Θέσεις χρηστών<input type="number" className={`mt-1 ${inp}`} value={p.seats ?? 1} onChange={(e) => setP(p._id, { seats: parseInt(e.target.value) || 1 })} /></label>
              <label className="block text-xs font-medium text-slate-500">Κόστος επιπλέον χρήστη (€/μήνα)<input type="number" className={`mt-1 ${inp}`} value={eur(p.extra_user_price)} onChange={(e) => setP(p._id, { extra_user_price: cents(e.target.value) })} /></label>
              <label className="block text-xs font-medium text-slate-500">Κόστος επιπλέον χρήστη (€/έτος)<input type="number" className={`mt-1 ${inp}`} value={eur(p.extra_user_price_yearly)} onChange={(e) => setP(p._id, { extra_user_price_yearly: cents(e.target.value) })} /></label>
              <label className="block text-xs font-medium text-slate-500">SLA / Υποστήριξη
                <select className={`mt-1 ${inp}`} value={p.sla ?? ""} onChange={(e) => setP(p._id, { sla: e.target.value })}>
                  <option value="">—</option>
                  {slaTiers.filter((s) => (s.active ?? true) || s._id === p.sla).map((s) => <option key={s._id} value={s._id}>{s.name || s._id}{(s.active ?? true) ? "" : " (ανενεργό)"}</option>)}
                </select>
              </label>
              <div className="block text-xs font-medium text-slate-500">Διαθέσιμοι κύκλοι χρέωσης
                <div className="mt-1 flex gap-2">
                  {(["monthly", "yearly"] as const).map((c) => {
                    const cyc = p.billing_cycles ?? ["monthly", "yearly"];
                    const on = cyc.includes(c);
                    return (
                      <label key={c} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                        <input type="checkbox" checked={on} className="h-4 w-4 accent-indigo-600"
                          onChange={() => { const next = on ? cyc.filter((x) => x !== c) : [...cyc, c]; setP(p._id, { billing_cycles: next.length ? next : cyc }); }} />
                        {c === "monthly" ? "Μηνιαίο" : "Ετήσιο"}
                      </label>
                    );
                  })}
                </div>
              </div>
              <label className="block text-xs font-medium text-slate-500 sm:col-span-2 lg:col-span-3">Περιγραφή<input className={`mt-1 ${inp}`} value={p.description ?? ""} onChange={(e) => setP(p._id, { description: e.target.value })} /></label>
              <label className="block text-xs font-medium text-slate-500 sm:col-span-2 lg:col-span-3">Δυνατότητες στην κάρτα τιμολόγησης <span className="text-slate-400">(μία ανά γραμμή — εμφανίζονται με ✓)</span>
                <textarea className={`mt-1 ${inp}`} rows={5} value={(p.features ?? []).join("\n")} onChange={(e) => setP(p._id, { features: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} placeholder={"π.χ.\nΣύνδεση ΗΔΙΚΑ / ΓΕΣΥ\nΈλεγχος & κλείσιμο ΕΟΠΥΥ\nΈως 10 χρήστες"} />
              </label>
            </div>
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-semibold text-slate-600">Δυνατότητες (modules) που δίνει το πακέτο</div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {MODULE_LABELS.map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
                    <span className="text-slate-700">{label}</span>
                    <input type="checkbox" checked={(p.modules ?? []).includes(key)} onChange={() => toggleMod(p._id, key)} className="h-4 w-4 accent-indigo-600" />
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-4">
              <button onClick={() => savePkg(p._id)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"><Save className="h-4 w-4" /> Αποθήκευση πακέτου</button>
            </div>
          </div>
        ))}
        {/* new package */}
        <div className="flex items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white p-4">
          <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="κωδικός νέου πακέτου (π.χ. enterprise)" className={`${inp} max-w-xs`} />
          <button onClick={createPkg} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"><Plus className="h-4 w-4" /> Νέο πακέτο</button>
        </div>
      </div>

      {/* ── SLA tiers ────────────────────────────────────────── */}
      <div className="mt-10">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Headphones className="h-4 w-4 text-indigo-500" /> Επίπεδα Υποστήριξης (SLA)</div>
        <div className="space-y-3">
          {Object.values(slaDrafts).map((s) => {
            const active = s.active ?? true;
            return (
            <div key={s._id} className={`rounded-2xl border bg-white p-5 shadow-sm ${active ? "border-slate-200" : "border-slate-200 opacity-70"}`}>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{s._id}</code>
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={active} onChange={(e) => setS(s._id, { active: e.target.checked })} className="h-4 w-4 accent-indigo-600" /> Ενεργό</label>
                  {!active && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">δεν προτείνεται σε νέες συνδρομές</span>}
                </div>
                <button onClick={() => delSla(s._id)} className="inline-flex items-center gap-1 text-xs text-rose-600 hover:underline"><Trash2 className="h-3.5 w-3.5" /> Διαγραφή</button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block text-xs font-medium text-slate-500">Όνομα<input className={`mt-1 ${inp}`} placeholder="π.χ. Professional" value={s.name ?? ""} onChange={(e) => setS(s._id, { name: e.target.value })} /></label>
                <label className="block text-xs font-medium text-slate-500 sm:col-span-2">Περιγραφή<input className={`mt-1 ${inp}`} placeholder="π.χ. Τηλ. + email, προτεραιότητα" value={s.description ?? ""} onChange={(e) => setS(s._id, { description: e.target.value })} /></label>
                <label className="block text-xs font-medium text-slate-500">Απόκριση (ώρες)<input type="number" className={`mt-1 ${inp}`} value={s.response_hours ?? 0} onChange={(e) => setS(s._id, { response_hours: parseInt(e.target.value) || 0 })} /></label>
                <label className="block text-xs font-medium text-slate-500">Κανάλια<input className={`mt-1 ${inp}`} placeholder="π.χ. phone,email" value={s.channels ?? ""} onChange={(e) => setS(s._id, { channels: e.target.value })} /></label>
                <label className="block text-xs font-medium text-slate-500">Κόστος (€/μήνα)<input type="number" className={`mt-1 ${inp}`} value={eur(s.price_monthly)} onChange={(e) => setS(s._id, { price_monthly: cents(e.target.value) })} /></label>
                <label className="block text-xs font-medium text-slate-500">Κόστος (€/έτος)<input type="number" className={`mt-1 ${inp}`} value={eur(s.price_yearly)} onChange={(e) => setS(s._id, { price_yearly: cents(e.target.value) })} /></label>
                <div className="flex items-end sm:col-span-2 lg:col-span-2"><button onClick={() => saveSla(s._id)} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"><Save className="h-4 w-4" /> Αποθήκευση</button></div>
              </div>
            </div>
          );})}
          <div className="flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-3">
            <input value={newSla} onChange={(e) => setNewSla(e.target.value)} placeholder="κωδικός SLA (π.χ. enterprise)" className={`${inp} max-w-xs`} />
            <button onClick={createSla} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"><Plus className="h-4 w-4" /> Νέο SLA</button>
          </div>
        </div>
      </div>
    </div>
  );
}
