"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Receipt, Check, Loader2, PlugZap, Boxes } from "lucide-react";

type S1 = {
  base_url?: string; app_id?: string; username?: string; password_set?: boolean;
  company?: string; branch?: string; module?: string; refid?: string;
  series?: string; salesman?: string; form?: string; js_endpoint?: string; issuer_afm?: string; issuer_name?: string;
  issuer_doy?: string; issuer_activity?: string; issuer_legal_form?: string; issuer_gemi?: string;
  issuer_address?: string; issuer_postal_code?: string; issuer_city?: string; issuer_region?: string;
  issuer_phone?: string; issuer_email?: string;
  auto_invoicing?: boolean; configured?: boolean;
};
const ISSUER_KEYS = ["issuer_afm", "issuer_name", "issuer_doy", "issuer_activity", "issuer_legal_form", "issuer_gemi", "issuer_address", "issuer_postal_code", "issuer_city", "issuer_region", "issuer_phone", "issuer_email"] as const;
type Integr = { softone?: S1 };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const lbl = "mb-1 block text-xs font-medium text-slate-500";

export default function AdminSoftonePage() {
  const q = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integr>("/admin/integrations") });
  const s1 = q.data?.softone;
  const [f, setF] = useState({ base_url: "", app_id: "", username: "", password: "", company: "", branch: "", module: "", refid: "", series: "", salesman: "", form: "", js_endpoint: "", issuer_afm: "", issuer_name: "", issuer_doy: "", issuer_activity: "", issuer_legal_form: "", issuer_gemi: "", issuer_address: "", issuer_postal_code: "", issuer_city: "", issuer_region: "", issuer_phone: "", issuer_email: "" });
  const [autoInv, setAutoInv] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    if (!s1) return;
    setF((p) => ({ ...p, base_url: s1.base_url || "", app_id: s1.app_id || "", username: s1.username || "", company: s1.company || "", branch: s1.branch || "", module: s1.module || "", refid: s1.refid || "", series: s1.series || "", salesman: s1.salesman || "", form: s1.form || "", js_endpoint: s1.js_endpoint || "", ...Object.fromEntries(ISSUER_KEYS.map((k) => [k, s1[k] || ""])) }));
    setAutoInv(!!s1.auto_invoicing);
  }, [s1]);

  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({
      softone_base_url: f.base_url, softone_app_id: f.app_id, softone_username: f.username,
      ...(f.password ? { softone_password: f.password } : {}),
      softone_company: f.company, softone_branch: f.branch, softone_module: f.module, softone_refid: f.refid,
      softone_series: f.series, softone_salesman: f.salesman, softone_form: f.form, softone_js_endpoint: f.js_endpoint,
      ...Object.fromEntries(ISSUER_KEYS.map((k) => [`softone_${k}`, f[k]])),
      softone_auto_invoicing: autoInv,
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
    <div className="w-full">
      <div className="mb-1 flex items-center gap-2"><Receipt className="h-6 w-6 text-brand-600" /><h1 className="text-xl font-bold text-slate-900">SoftOne / myDATA</h1></div>
      <p className="mb-5 text-sm text-slate-500">Διαπιστευτήρια SoftOne για έκδοση παραστατικών & διαβίβαση στο myDATA. Τα δεδομένα αποθηκεύονται κρυπτογραφημένα. {s1?.configured && <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">ρυθμισμένο</span>}</p>

      <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
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
            <div><label className={lbl}>SERIES (internal id σειράς)</label><input className={inp} value={f.series} onChange={(e) => set("series", e.target.value)} placeholder="7767" /><p className="mt-1 text-[11px] text-amber-600">⚠ Βάλε το <b>internal id ΣΕΙΡΑΣ</b>, όχι της φόρμας (FPRMS). π.χ. Τ.Π.Υ.=<code>7767</code>, Τ.Π.Υ. Ε.Ε.=<code>7069</code>, Προτιμολόγιο=<code>7002</code>. Άκυρο/κενό → πέφτει 7002.</p></div>
            <div><label className={lbl}>Πωλητής (κωδικός)</label><input className={inp} value={f.salesman} onChange={(e) => set("salesman", e.target.value)} placeholder="020" /></div>
            <div><label className={lbl}>FORM</label><input className={inp} value={f.form} onChange={(e) => set("form", e.target.value)} /></div>
          </div>
        </div>

        <div className="border-t border-slate-100 pt-4">
          <div className="mb-2 text-xs font-semibold text-slate-500">Στοιχεία εκδότη (CloudOn) — εμφανίζονται στην κεφαλίδα του παραστατικού</div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2"><label className={lbl}>Επωνυμία</label><input className={inp} value={f.issuer_name} onChange={(e) => set("issuer_name", e.target.value)} placeholder="CloudOn Ι.Κ.Ε" /></div>
            <div><label className={lbl}>ΑΦΜ</label><input className={inp} value={f.issuer_afm} onChange={(e) => set("issuer_afm", e.target.value)} placeholder="998107371" /></div>
            <div><label className={lbl}>ΔΟΥ</label><input className={inp} value={f.issuer_doy} onChange={(e) => set("issuer_doy", e.target.value)} /></div>
            <div className="lg:col-span-2"><label className={lbl}>Δραστηριότητα</label><input className={inp} value={f.issuer_activity} onChange={(e) => set("issuer_activity", e.target.value)} placeholder="ΕΤΑΙΡΕΙΑ ΠΛΗΡΟΦΟΡΙΚΗΣ" /></div>
            <div><label className={lbl}>Νομική μορφή</label><input className={inp} value={f.issuer_legal_form} onChange={(e) => set("issuer_legal_form", e.target.value)} placeholder="Ι.Κ.Ε" /></div>
            <div><label className={lbl}>ΓΕΜΗ</label><input className={inp} value={f.issuer_gemi} onChange={(e) => set("issuer_gemi", e.target.value)} /></div>
            <div className="sm:col-span-2"><label className={lbl}>Διεύθυνση</label><input className={inp} value={f.issuer_address} onChange={(e) => set("issuer_address", e.target.value)} placeholder="Πελοποννήσου 13" /></div>
            <div><label className={lbl}>Τ.Κ.</label><input className={inp} value={f.issuer_postal_code} onChange={(e) => set("issuer_postal_code", e.target.value)} placeholder="15341" /></div>
            <div><label className={lbl}>Πόλη</label><input className={inp} value={f.issuer_city} onChange={(e) => set("issuer_city", e.target.value)} placeholder="Αγία Παρασκευή" /></div>
            <div><label className={lbl}>Νομός / Περιοχή</label><input className={inp} value={f.issuer_region} onChange={(e) => set("issuer_region", e.target.value)} placeholder="Αττικής" /></div>
            <div><label className={lbl}>Τηλέφωνο</label><input className={inp} value={f.issuer_phone} onChange={(e) => set("issuer_phone", e.target.value)} /></div>
            <div className="sm:col-span-2"><label className={lbl}>Email</label><input className={inp} value={f.issuer_email} onChange={(e) => set("issuer_email", e.target.value)} type="email" /></div>
          </div>
        </div>

        <div className="border-t border-slate-100 pt-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={autoInv} onChange={(e) => setAutoInv(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
            <span>
              <span className="block text-sm font-medium text-slate-800">Αυτόματη έκδοση τιμολογίων</span>
              <span className="block text-xs text-slate-500">Όταν είναι ενεργό, κάθε επιτυχής χρέωση (συνδρομή/ανανέωση/αναβάθμιση/top-up) παράγει αυτόματα παραστατικό και το διαβιβάζει στο SoftOne → myDATA (το SoftOne στέλνει το τιμολόγιο στον πελάτη). <b>Άφησέ το κλειστό μέχρι να ανέβει η JS του SoftOne</b> και να γίνει δοκιμαστική έκδοση.</span>
            </span>
          </label>
        </div>

        {notice && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{notice}</div>}
        {test && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{test}</div>}

        <div className="flex items-center gap-2 border-t border-slate-100 pt-4">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50">{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Αποθήκευση</button>
          <button onClick={() => doTest.mutate()} disabled={doTest.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{doTest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Δοκιμή σύνδεσης</button>
        </div>
      </div>
      <MtrlMap />
      </div>
    </div>
  );
}

function MtrlMap() {
  type Item = { key: string; group: string; name: string; mtrl: string };
  const q = useQuery({ queryKey: ["softone-items"], queryFn: () => adminApi<{ items: Item[]; default_mtrl: string }>("/admin/softone/items") });
  const [map, setMap] = useState<Record<string, string>>({});
  const [def, setDef] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const m: Record<string, string> = {};
    q.data.items.forEach((i) => { m[i.key] = i.mtrl || ""; });
    setMap(m); setDef(q.data.default_mtrl || "");
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => adminApi("/admin/softone/items", { method: "PUT", body: JSON.stringify({ map, default_mtrl: def }) }),
    onSuccess: () => { setNotice("Αποθηκεύτηκε ✓"); q.refetch(); },
    onError: () => setNotice("Σφάλμα αποθήκευσης"),
  });
  const items = q.data?.items ?? [];
  const groups = Array.from(new Set(items.map((i) => i.group)));
  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-2">
        <Boxes className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
        <div>
          <h2 className="text-lg font-bold text-slate-900">Είδη SoftOne (MTRL)</h2>
          <p className="text-sm text-slate-500">Κάθε τιμολογήσιμο είδος (συνδρομές, credits μηνυμάτων, add-ons, extras) χρειάζεται τον <b>κωδικό είδους (MTRL)</b> του SoftOne για να καταχωρηθεί σωστά το παραστατικό. Το <b>Default</b> χρησιμοποιείται όπου δεν έχει οριστεί ειδικό — ώστε να μη σπάει ποτέ η έκδοση.</p>
        </div>
      </div>
      {q.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : items.length === 0 ? <div className="text-sm text-slate-400">Δεν βρέθηκαν είδη.</div> : (
        <>
          {groups.map((g) => (
            <div key={g}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{g}</div>
              <div className="space-y-1.5">
                {items.filter((i) => i.group === g).map((i) => (
                  <div key={i.key} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{i.name}</span>
                    <input value={map[i.key] ?? ""} onChange={(e) => setMap({ ...map, [i.key]: e.target.value })} placeholder="MTRL" className="w-36 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
            <span className="min-w-0 flex-1 text-sm font-semibold text-slate-700">Default (fallback)</span>
            <input value={def} onChange={(e) => setDef(e.target.value)} placeholder="MTRL" className="w-36 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
        </>
      )}
      {notice && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{notice}</div>}
      <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50">{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Αποθήκευση αντιστοίχισης</button>
    </div>
  );
}
