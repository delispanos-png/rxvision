"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Wallet, Save, Loader2, Check, CreditCard, Building2 } from "lucide-react";

type Integrations = {
  revolut: { mode: string; api_key_set: boolean; webhook_secret_set: boolean };
  viva?: { mode: string; client_id_set: boolean; client_secret_set: boolean; merchant_id_set: boolean; api_key_set: boolean; source_code: string; checkout_ready: boolean; recurring_ready: boolean };
  alphabank?: { mode: string; merchant_id_set: boolean; shared_secret_set: boolean };
  subscription_provider?: string;
};
type PayMethods = { methods: Record<string, { enabled: boolean; label: { el: string; en: string } }>; alphabank_configured: boolean };
type Bank = { beneficiary?: string; bank_name?: string; iban?: string; swift?: string; notes?: string };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const Badge = ({ ok }: { ok?: boolean }) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{ok ? "Αποθηκευμένο" : "Μη ρυθμισμένο"}</span>;

export default function PaymentsSettingsPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integrations>("/admin/integrations"), retry: false });
  const pmQ = useQuery({ queryKey: ["admin", "payment-methods"], queryFn: () => adminApi<PayMethods>("/admin/payment-methods"), retry: false });
  const bankQ = useQuery({ queryKey: ["admin", "billing-bank"], queryFn: () => adminApi<Bank>("/admin/billing-bank"), retry: false });

  const [revKey, setRevKey] = useState("");
  const [revMode, setRevMode] = useState("sandbox");
  const [revSecret, setRevSecret] = useState("");
  const [vivaCid, setVivaCid] = useState("");
  const [vivaCsec, setVivaCsec] = useState("");
  const [vivaMid, setVivaMid] = useState("");
  const [vivaKey, setVivaKey] = useState("");
  const [vivaSrc, setVivaSrc] = useState("");
  const [vivaMode, setVivaMode] = useState("demo");
  const [abMid, setAbMid] = useState("");
  const [abSecret, setAbSecret] = useState("");
  const [abMode, setAbMode] = useState("test");
  const [subProvider, setSubProvider] = useState("revolut");
  const [bank, setBank] = useState<Bank>({});

  useEffect(() => { if (status.data?.alphabank) setAbMode(status.data.alphabank.mode || "test"); if (status.data?.viva) { setVivaMode(status.data.viva.mode || "demo"); setVivaSrc(status.data.viva.source_code || ""); } if (status.data?.subscription_provider) setSubProvider(status.data.subscription_provider); }, [status.data]);
  useEffect(() => { if (bankQ.data) setBank(bankQ.data); }, [bankQ.data]);

  const togglePm = useMutation({
    mutationFn: (u: Record<string, boolean>) => adminApi("/admin/payment-methods", { method: "PUT", body: JSON.stringify(u) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "payment-methods"] }),
  });
  const saveCreds = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({
      revolut_api_key: revKey || null, revolut_mode: revMode || null, revolut_webhook_secret: revSecret || null,
      viva_client_id: vivaCid || null, viva_client_secret: vivaCsec || null, viva_merchant_id: vivaMid || null,
      viva_api_key: vivaKey || null, viva_source_code: vivaSrc || null, viva_mode: vivaMode || null,
      subscription_provider: subProvider || null,
      alphabank_merchant_id: abMid || null, alphabank_shared_secret: abSecret || null, alphabank_mode: abMode || null,
    }) }),
    onSuccess: () => { setRevKey(""); setRevSecret(""); setVivaCid(""); setVivaCsec(""); setVivaMid(""); setVivaKey(""); setAbMid(""); setAbSecret(""); qc.invalidateQueries({ queryKey: ["integrations"] }); qc.invalidateQueries({ queryKey: ["admin", "payment-methods"] }); },
  });
  const saveBank = useMutation({
    mutationFn: () => adminApi("/admin/billing-bank", { method: "PUT", body: JSON.stringify(bank) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "billing-bank"] }),
  });

  const s = status.data;
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Wallet className="h-6 w-6 text-brand-600" /> Τρόποι πληρωμής</h1>
        <p className="mt-1 text-sm text-slate-500">Πάροχοι πληρωμών (Revolut, <b>Viva — κάρτα/IRIS</b>, Alpha Bank), ενεργοί τρόποι πληρωμής, τραπεζικός λογαριασμός κατάθεσης & τιμές συνδρομής. Τα διαπιστευτήρια αποθηκεύονται κρυπτογραφημένα.</p>
      </div>

      {/* Πάροχος χρέωσης συνδρομών */}
      <div className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-5 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-800"><CreditCard className="h-4 w-4 text-indigo-600" /> Πάροχος χρέωσης συνδρομών</h3>
        <p className="mb-3 text-xs text-slate-500">Ποιος πάροχος χρεώνει τις <b>δικές μας συνδρομές</b> (card-on-file + αυτόματη ανανέωση). Άλλαξέ το σε Viva όσο ο λογαριασμός Revolut δεν είναι ενεργός.</p>
        <div className="flex items-center gap-3">
          <select value={subProvider} onChange={(e) => setSubProvider(e.target.value)} className={`${inp} max-w-xs`}>
            <option value="revolut">Revolut</option>
            <option value="viva">Viva Wallet (κάρτα / IRIS)</option>
          </select>
          <span className="text-[11px] text-slate-500">{subProvider === "viva" ? (s?.viva?.recurring_ready ? "✓ Viva recurring έτοιμο" : "⚠️ Χρειάζεται Merchant ID + API key παρακάτω") : (s?.revolut?.api_key_set ? "✓ Revolut ρυθμισμένο" : "⚠️ Revolut μη ρυθμισμένο")}</span>
        </div>
      </div>

      {/* Ενεργοί τρόποι πληρωμής */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Wallet className="h-4 w-4 text-brand-600" /> Ενεργοί τρόποι πληρωμής</h3>
        <p className="mb-3 text-xs text-slate-500">Ό,τι ενεργοποιήσεις εδώ εμφανίζεται στους πελάτες (αναβάθμιση) και προσαρμόζει τη διαδικασία εγγραφής.</p>
        <div className="space-y-2">
          {Object.entries(pmQ.data?.methods ?? {}).map(([id, m]) => {
            const disabled = (id === "card_alpha" && !pmQ.data?.alphabank_configured) || (id === "card_viva" && !status.data?.viva?.checkout_ready);
            return (
              <div key={id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-slate-800">{m.label.el}</div>
                  {disabled && <div className="text-[11px] text-amber-600">Ρύθμισε πρώτα τα διαπιστευτήρια {id === "card_viva" ? "Viva Wallet" : "Alpha Bank"} παρακάτω</div>}
                </div>
                <button type="button" disabled={togglePm.isPending || disabled} onClick={() => togglePm.mutate({ [id]: !m.enabled })}
                  className={`relative h-6 w-11 rounded-full transition ${m.enabled ? "bg-emerald-500" : "bg-slate-300"} disabled:opacity-40`}>
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${m.enabled ? "left-[22px]" : "left-0.5"}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Revolut */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><CreditCard className="h-4 w-4 text-brand-600" /> Revolut Business (Merchant API) <Badge ok={s?.revolut.api_key_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Merchant Secret API key
            <input type="password" value={revKey} onChange={(e) => setRevKey(e.target.value)} placeholder={s?.revolut.api_key_set ? "•••• (αποθηκευμένο)" : "sk_..."} className={inp} /></label>
          <label className="text-xs text-slate-500">Περιβάλλον
            <select value={revMode} onChange={(e) => setRevMode(e.target.value)} className={inp}>
              <option value="sandbox">Sandbox (δοκιμές)</option><option value="live">Live (πραγματικές χρεώσεις)</option>
            </select></label>
          <label className="text-xs text-slate-500 sm:col-span-2">Webhook signing secret <Badge ok={s?.revolut.webhook_secret_set} />
            <input type="password" value={revSecret} onChange={(e) => setRevSecret(e.target.value)} placeholder={s?.revolut.webhook_secret_set ? "•••• (αποθηκευμένο)" : "wsk_..."} className={inp} /></label>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Webhook URL: <code className="text-brand-700">https://app.rxvision.gr/api/v1/billing/webhook/revolut</code></p>
      </div>

      {/* Viva Wallet */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><CreditCard className="h-4 w-4 text-indigo-600" /> Viva Wallet — Smart Checkout (κάρτα + IRIS) <Badge ok={s?.viva?.checkout_ready} /></h3>
        <p className="mb-3 text-xs text-slate-500">Εναλλακτική του Revolut για τις συνδρομές. Ένα integration → <b>κάρτα & IRIS</b>. Το IRIS εμφανίζεται αυτόματα αν είναι ενεργό στον λογαριασμό Viva.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Smart Checkout Client ID <Badge ok={s?.viva?.client_id_set} />
            <input value={vivaCid} onChange={(e) => setVivaCid(e.target.value)} placeholder={s?.viva?.client_id_set ? "•••• (αποθηκευμένο)" : "Client ID"} className={inp} /></label>
          <label className="text-xs text-slate-500">Smart Checkout Client Secret <Badge ok={s?.viva?.client_secret_set} />
            <input type="password" value={vivaCsec} onChange={(e) => setVivaCsec(e.target.value)} placeholder={s?.viva?.client_secret_set ? "•••• (αποθηκευμένο)" : "Client Secret"} className={inp} /></label>
          <label className="text-xs text-slate-500">Source Code (πηγή πληρωμών)
            <input value={vivaSrc} onChange={(e) => setVivaSrc(e.target.value)} placeholder="π.χ. 1234" className={inp} /></label>
          <label className="text-xs text-slate-500">Περιβάλλον
            <select value={vivaMode} onChange={(e) => setVivaMode(e.target.value)} className={inp}>
              <option value="demo">Demo (δοκιμές)</option><option value="live">Live (πραγματικές χρεώσεις)</option>
            </select></label>
          <label className="text-xs text-slate-500">Merchant ID <Badge ok={s?.viva?.merchant_id_set} /> <span className="text-slate-400">(για recurring συνδρομές)</span>
            <input value={vivaMid} onChange={(e) => setVivaMid(e.target.value)} placeholder={s?.viva?.merchant_id_set ? "•••• (αποθηκευμένο)" : "Merchant ID"} className={inp} /></label>
          <label className="text-xs text-slate-500">API key (Basic) <Badge ok={s?.viva?.api_key_set} /> <span className="text-slate-400">(για recurring)</span>
            <input type="password" value={vivaKey} onChange={(e) => setVivaKey(e.target.value)} placeholder={s?.viva?.api_key_set ? "•••• (αποθηκευμένο)" : "API key"} className={inp} /></label>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Smart Checkout (Client ID/Secret + Source) → κάρτα/IRIS. Recurring συνδρομές → Merchant ID + API key. {s?.viva?.recurring_ready ? "✓ Recurring έτοιμο." : "Recurring όχι ακόμη ρυθμισμένο."}</p>
      </div>

      {/* Alpha Bank */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><CreditCard className="h-4 w-4 text-red-600" /> Alpha Bank — Alpha e-Commerce (κάρτες) <Badge ok={s?.alphabank?.merchant_id_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Merchant ID
            <input value={abMid} onChange={(e) => setAbMid(e.target.value)} placeholder={s?.alphabank?.merchant_id_set ? "•••• (αποθηκευμένο)" : "Merchant ID"} className={inp} /></label>
          <label className="text-xs text-slate-500">Περιβάλλον
            <select value={abMode} onChange={(e) => setAbMode(e.target.value)} className={inp}>
              <option value="test">Test (δοκιμές)</option><option value="live">Live (πραγματικές χρεώσεις)</option>
            </select></label>
          <label className="text-xs text-slate-500 sm:col-span-2">Shared secret (digest) <Badge ok={s?.alphabank?.shared_secret_set} />
            <input type="password" value={abSecret} onChange={(e) => setAbSecret(e.target.value)} placeholder={s?.alphabank?.shared_secret_set ? "•••• (αποθηκευμένο)" : "Shared secret…"} className={inp} /></label>
        </div>
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">⚠️ Απαιτείται επιβεβαίωση Alpha Bank: gateway URL & σειρά πεδίων digest (docs/alphabank-api-requirements.md). Callback: <code>https://app.rxvision.gr/api/v1/subscription/alpha-callback</code></p>
      </div>

      <button onClick={() => saveCreds.mutate()} disabled={saveCreds.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {saveCreds.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : saveCreds.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση διαπιστευτηρίων καρτών
      </button>

      {/* Τραπεζικός λογαριασμός κατάθεσης */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Building2 className="h-4 w-4 text-slate-500" /> Τραπεζικός λογαριασμός κατάθεσης</h3>
        <p className="mt-1 text-xs text-slate-500">Τα στοιχεία που βλέπει ο πελάτης για αναβάθμιση με τραπεζική κατάθεση.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Δικαιούχος<input className={inp} value={bank.beneficiary ?? ""} onChange={(e) => setBank({ ...bank, beneficiary: e.target.value })} /></label>
          <label className="text-xs text-slate-500">Τράπεζα<input className={inp} value={bank.bank_name ?? ""} onChange={(e) => setBank({ ...bank, bank_name: e.target.value })} /></label>
          <label className="text-xs text-slate-500">IBAN<input className={`${inp} font-mono`} value={bank.iban ?? ""} onChange={(e) => setBank({ ...bank, iban: e.target.value })} /></label>
          <label className="text-xs text-slate-500">SWIFT/BIC<input className={`${inp} font-mono`} value={bank.swift ?? ""} onChange={(e) => setBank({ ...bank, swift: e.target.value })} /></label>
          <label className="text-xs text-slate-500 sm:col-span-2">Σημειώσεις<input className={inp} value={bank.notes ?? ""} onChange={(e) => setBank({ ...bank, notes: e.target.value })} /></label>
        </div>
        <button onClick={() => saveBank.mutate()} disabled={saveBank.isPending} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {saveBank.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : saveBank.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση λογαριασμού
        </button>
      </div>

      {/* Ειδοποιήσεις συνδρομής (κείμενα email + περιθώρια + επαφή) */}
      <SubNotifCard />

      <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">💡 Οι <b>τιμές & τα πακέτα συνδρομής</b> ρυθμίζονται στην «Πακέτα & SLA». Ο πάροχος μηνυμάτων (Apifon) & τα credits στην «Μηνύματα & Credits». Η ΑΑΔΕ στο «Κρατικές διασυνδέσεις».</div>
    </div>
  );
}

type SubNotif = {
  trial_grace_days: number; active_grace_days: number; warn_days: number[]; expired_max_days: number;
  sales_email: string; sales_phone: string;
  warn_subject: string; warn_body: string; expired_subject: string; expired_body: string;
};

function SubNotifCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "sub-notif"], queryFn: () => adminApi<SubNotif>("/admin/subscription-notifications"), retry: false });
  const [f, setF] = useState<SubNotif | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data, f]);
  const cur = f;
  const set = (k: keyof SubNotif, v: SubNotif[keyof SubNotif]) => { if (cur) setF({ ...cur, [k]: v }); };
  const save = useMutation({
    mutationFn: () => adminApi("/admin/subscription-notifications", { method: "PUT", body: JSON.stringify(cur) }),
    onSuccess: () => { setMsg("Αποθηκεύτηκε ✓"); qc.invalidateQueries({ queryKey: ["admin", "sub-notif"] }); },
  });
  const test = useMutation({
    mutationFn: (kind: string) => adminApi<{ ok: boolean; error?: string }>("/admin/subscription-notifications/test", { method: "POST", body: JSON.stringify({ email: testEmail, kind }) }),
    onSuccess: (r) => setMsg(r.ok ? "Στάλθηκε δοκιμαστικό ✓" : "Αποτυχία αποστολής: " + (r.error || "")),
  });
  if (!cur) return <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-400 shadow-sm">Φόρτωση…</div>;
  const ta = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Wallet className="h-4 w-4 text-brand-600" /> Ειδοποιήσεις συνδρομής (email)</h3>
      <p className="mb-3 text-xs text-slate-500">Προειδοποίηση πριν τη λήξη + καθημερινό «έχει λήξει» μετά. Placeholders: <code>{"{name}"}</code>, <code>{"{days}"}</code>, <code>{"{sales}"}</code>.</p>
      {msg && <div className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{msg}</div>}

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-slate-500">Περιθώριο δοκιμαστικών (μέρες)<input type="number" className={ta} value={cur.trial_grace_days} onChange={(e) => set("trial_grace_days", +e.target.value)} /></label>
        <label className="text-xs text-slate-500">Περιθώριο ενεργών (μέρες)<input type="number" className={ta} value={cur.active_grace_days} onChange={(e) => set("active_grace_days", +e.target.value)} /></label>
        <label className="text-xs text-slate-500">Μέρες προειδοποίησης (π.χ. 7,3,1)<input className={ta} value={(cur.warn_days || []).join(",")} onChange={(e) => set("warn_days", e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0))} /></label>
        <label className="text-xs text-slate-500">Όριο καθημερινών μετά (μέρες)<input type="number" className={ta} value={cur.expired_max_days} onChange={(e) => set("expired_max_days", +e.target.value)} /></label>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">Email τμήματος πωλήσεων<input className={ta} value={cur.sales_email} onChange={(e) => set("sales_email", e.target.value)} placeholder="sales@rxvision.gr" /></label>
        <label className="text-xs text-slate-500">Τηλέφωνο πωλήσεων<input className={ta} value={cur.sales_phone} onChange={(e) => set("sales_phone", e.target.value)} placeholder="21X…" /></label>
      </div>

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
        <div className="text-xs font-semibold text-amber-900">📣 Προειδοποίηση (πριν τη λήξη)</div>
        <label className="text-xs text-slate-500">Θέμα<input className={ta} value={cur.warn_subject} onChange={(e) => set("warn_subject", e.target.value)} /></label>
        <label className="mt-2 block text-xs text-slate-500">Κείμενο<textarea rows={4} className={ta} value={cur.warn_body} onChange={(e) => set("warn_body", e.target.value)} /></label>
      </div>
      <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/50 p-3">
        <div className="text-xs font-semibold text-rose-900">⛔ Έχει λήξει (καθημερινά μετά)</div>
        <label className="text-xs text-slate-500">Θέμα<input className={ta} value={cur.expired_subject} onChange={(e) => set("expired_subject", e.target.value)} /></label>
        <label className="mt-2 block text-xs text-slate-500">Κείμενο<textarea rows={4} className={ta} value={cur.expired_body} onChange={(e) => set("expired_body", e.target.value)} /></label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Αποθήκευση
        </button>
        <span className="mx-2 h-5 w-px bg-slate-200" />
        <input value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="email για δοκιμή" className="w-52 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
        <button onClick={() => test.mutate("warn")} disabled={!testEmail || test.isPending} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Δοκιμή «προειδοποίηση»</button>
        <button onClick={() => test.mutate("expired")} disabled={!testEmail || test.isPending} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Δοκιμή «έληξε»</button>
      </div>
    </div>
  );
}
