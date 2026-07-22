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

      <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">💡 Οι <b>τιμές & τα πακέτα συνδρομής</b> ρυθμίζονται στην «Πακέτα & SLA». Ο πάροχος μηνυμάτων (Apifon) & τα credits στην «Μηνύματα & Credits». Η ΑΑΔΕ στο «Κρατικές διασυνδέσεις».</div>
    </div>
  );
}
