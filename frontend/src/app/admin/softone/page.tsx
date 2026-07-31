"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Receipt, Check, Loader2, PlugZap } from "lucide-react";

type S1 = {
  base_url?: string; app_id?: string; username?: string; password_set?: boolean;
  company?: string; branch?: string; module?: string; refid?: string;
  series?: string; form?: string; js_endpoint?: string; issuer_afm?: string; issuer_name?: string; configured?: boolean;
};
type Integr = { softone?: S1 };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const lbl = "mb-1 block text-xs font-medium text-slate-500";

export default function AdminSoftonePage() {
  const q = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integr>("/admin/integrations") });
  const s1 = q.data?.softone;
  const [f, setF] = useState({ base_url: "", app_id: "", username: "", password: "", company: "", branch: "", module: "", refid: "", series: "", form: "", js_endpoint: "", issuer_afm: "", issuer_name: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    if (!s1) return;
    setF((p) => ({ ...p, base_url: s1.base_url || "", app_id: s1.app_id || "", username: s1.username || "", company: s1.company || "", branch: s1.branch || "", module: s1.module || "", refid: s1.refid || "", series: s1.series || "", form: s1.form || "", js_endpoint: s1.js_endpoint || "", issuer_afm: s1.issuer_afm || "", issuer_name: s1.issuer_name || "" }));
  }, [s1]);

  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({
      softone_base_url: f.base_url, softone_app_id: f.app_id, softone_username: f.username,
      ...(f.password ? { softone_password: f.password } : {}),
      softone_company: f.company, softone_branch: f.branch, softone_module: f.module, softone_refid: f.refid,
      softone_series: f.series, softone_form: f.form, softone_js_endpoint: f.js_endpoint, softone_issuer_afm: f.issuer_afm, softone_issuer_name: f.issuer_name,
    }) }),
    onSuccess: () => { setNotice("Αποθηκεύτηκε ✓"); setF((p) => ({ ...p, password: "" })); q.refetch(); },
    onError: () => setNotice("Σφάλμα αποθήκευσης"),
  });

  const doTest = useMutation({
    mutationFn: () => adminApi<{ ok: boolean; error?: string; companies?: { company?: string; name?: string; branch?: string }[]; authenticated?: boolean }>("/admin/integrations/softone/test", { method: "POST" }),
    onSuccess: (r) => setTest(r.ok
      ? `✓ Σύνδεση OK${r.authenticated === false ? " (αλλά authenticate απέτυχε — έλεγξε company/branch)" : ""}. Εταιρείες: ${(r.companies || []).map((c) => `${c.company}/${c.branch} ${c.name || ""}`).join(" · ") || "—"}`
      : `✗ Απέτυχε: ${r.error || "άγνωστο"}`),
    onError: () => setTest("✗ Σφάλμα κλήσης"),
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-1 flex items-center gap-2"><Receipt className="h-6 w-6 text-brand-600" /><h1 className="text-xl font-bold text-slate-900">SoftOne / myDATA</h1></div>
      <p className="mb-5 text-sm text-slate-500">Διαπιστευτήρια SoftOne για έκδοση παραστατικών & διαβίβαση στο myDATA. Τα δεδομένα αποθηκεύονται κρυπτογραφημένα. {s1?.configured && <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">ρυθμισμένο</span>}</p>

      <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><label className={lbl}>Base URL (S1 Web Services)</label><input className={inp} value={f.base_url} onChange={(e) => set("base_url", e.target.value)} placeholder="https://<host>/s1services" /></div>
          <div><label className={lbl}>App ID</label><input className={inp} value={f.app_id} onChange={(e) => set("app_id", e.target.value)} /></div>
          <div><label className={lbl}>Username</label><input className={inp} value={f.username} onChange={(e) => set("username", e.target.value)} /></div>
          <div><label className={lbl}>Password {s1?.password_set && <span className="text-emerald-600">✓ αποθηκευμένος</span>}</label><input className={inp} type="password" value={f.password} onChange={(e) => set("password", e.target.value)} placeholder={s1?.password_set ? "(άφησε κενό για να μην αλλάξει)" : ""} /></div>
        </div>

        <div className="border-t border-slate-100 pt-4">
          <div className="mb-2 text-xs font-semibold text-slate-500">Login context</div>
          <div className="grid gap-4 sm:grid-cols-4">
            <div><label className={lbl}>Company</label><input className={inp} value={f.company} onChange={(e) => set("company", e.target.value)} /></div>
            <div><label className={lbl}>Branch</label><input className={inp} value={f.branch} onChange={(e) => set("branch", e.target.value)} /></div>
            <div><label className={lbl}>Module</label><input className={inp} value={f.module} onChange={(e) => set("module", e.target.value)} /></div>
            <div><label className={lbl}>RefId</label><input className={inp} value={f.refid} onChange={(e) => set("refid", e.target.value)} /></div>
          </div>
        </div>

        <div className="border-t border-slate-100 pt-4">
          <div className="mb-2 text-xs font-semibold text-slate-500">Παραστατικό (τιμολόγιο παροχής υπηρεσιών)</div>
          <div className="mb-4 sm:col-span-2"><label className={lbl}>Custom JS Web Service (module/function)</label><input className={inp} value={f.js_endpoint} onChange={(e) => set("js_endpoint", e.target.value)} placeholder="π.χ. RXVISION/createInvoice" /><p className="mt-1 text-[11px] text-slate-400">Το endpoint που θα καλέσουμε: <code>&lt;base_url&gt;/JS/&lt;αυτό&gt;</code>. Το γράφει η ομάδα SoftOne σε Advanced JavaScript.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className={lbl}>SERIES (σειρά)</label><input className={inp} value={f.series} onChange={(e) => set("series", e.target.value)} /></div>
            <div><label className={lbl}>FORM</label><input className={inp} value={f.form} onChange={(e) => set("form", e.target.value)} /></div>
            <div><label className={lbl}>ΑΦΜ εκδότη (CloudOn)</label><input className={inp} value={f.issuer_afm} onChange={(e) => set("issuer_afm", e.target.value)} /></div>
            <div><label className={lbl}>Επωνυμία εκδότη</label><input className={inp} value={f.issuer_name} onChange={(e) => set("issuer_name", e.target.value)} /></div>
          </div>
        </div>

        {notice && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{notice}</div>}
        {test && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{test}</div>}

        <div className="flex items-center gap-2 border-t border-slate-100 pt-4">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50">{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Αποθήκευση</button>
          <button onClick={() => doTest.mutate()} disabled={doTest.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{doTest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Δοκιμή σύνδεσης</button>
        </div>
      </div>
    </div>
  );
}
