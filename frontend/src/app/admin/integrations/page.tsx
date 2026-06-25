"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { KeyRound, Save, Loader2, Check, Landmark, CreditCard, Package, Bot } from "lucide-react";
import { fmtMoney } from "@/lib/formatters";

type Integrations = {
  aade: { username: string | null; configured: boolean };
  revolut: { mode: string; api_key_set: boolean; webhook_secret_set: boolean };
  anthropic?: { api_key_set: boolean; enabled: boolean; model: string; admin_model: string };
};
type Pkg = { _id: string; name?: string; price_monthly?: number; price_yearly?: number; trial_days?: number };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const Badge = ({ ok }: { ok?: boolean }) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{ok ? "Αποθηκευμένο" : "Μη ρυθμισμένο"}</span>;

export default function IntegrationsPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integrations>("/admin/integrations"), retry: false });
  const pkgs = useQuery({ queryKey: ["admin-packages"], queryFn: () => adminApi<{ items: Pkg[] }>("/admin/packages"), retry: false });

  const [aadeUser, setAadeUser] = useState("");
  const [aadePass, setAadePass] = useState("");
  const [revKey, setRevKey] = useState("");
  const [revMode, setRevMode] = useState("sandbox");
  const [revSecret, setRevSecret] = useState("");
  const [antKey, setAntKey] = useState("");
  const [antEnabled, setAntEnabled] = useState(true);
  const [antModel, setAntModel] = useState("claude-opus-4-8");
  const [antAdminModel, setAntAdminModel] = useState("claude-opus-4-8");
  useEffect(() => {
    if (status.data?.anthropic) {
      setAntEnabled(status.data.anthropic.enabled ?? true);
      setAntModel(status.data.anthropic.model || "claude-opus-4-8");
      setAntAdminModel(status.data.anthropic.admin_model || "claude-opus-4-8");
    }
  }, [status.data]);

  const save = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({
      aade_username: aadeUser || null, aade_password: aadePass || null,
      revolut_api_key: revKey || null, revolut_mode: revMode || null, revolut_webhook_secret: revSecret || null,
      anthropic_api_key: antKey || null, anthropic_enabled: antEnabled, anthropic_model: antModel || null,
      anthropic_admin_model: antAdminModel || null,
    }) }),
    onSuccess: () => { setAadePass(""); setRevKey(""); setRevSecret(""); setAntKey(""); qc.invalidateQueries({ queryKey: ["integrations"] }); },
  });

  const std = pkgs.data?.items?.find((p) => p._id === "standard");
  const [pm, setPm] = useState<string>("");
  const [py, setPy] = useState<string>("");
  const [td, setTd] = useState<string>("");
  const savePkg = useMutation({
    mutationFn: () => adminApi("/admin/packages/standard", { method: "PUT", body: JSON.stringify({
      price_monthly: pm ? Math.round(parseFloat(pm) * 100) : null,
      price_yearly: py ? Math.round(parseFloat(py) * 100) : null,
      trial_days: td ? parseInt(td) : null,
    }) }),
    onSuccess: () => { setPm(""); setPy(""); setTd(""); qc.invalidateQueries({ queryKey: ["admin-packages"] }); },
  });

  const s = status.data;
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><KeyRound className="h-6 w-6 text-brand-600" /> Πληρωμές & ΑΑΔΕ</h1>
        <p className="mt-1 text-sm text-slate-500">Διαπιστευτήρια <b>ΑΑΔΕ</b> (auto-fill εγγραφής) & <b>Revolut</b> (συνδρομές). Αποθηκεύονται κρυπτογραφημένα — δεν εμφανίζονται ξανά, δεν μπαίνουν σε git/logs.</p>
      </div>

      {/* ΑΑΔΕ */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Landmark className="h-4 w-4 text-brand-600" /> ΑΑΔΕ — RgWsPublic2 (VAT lookup) <Badge ok={s?.aade.configured} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Όνομα χρήστη (special account)
            <input value={aadeUser} onChange={(e) => setAadeUser(e.target.value)} placeholder={s?.aade.username || "username"} className={inp} />
          </label>
          <label className="text-xs text-slate-500">Κωδικός
            <input type="password" value={aadePass} onChange={(e) => setAadePass(e.target.value)} placeholder={s?.aade.configured ? "•••• (αποθηκευμένο — κενό = αμετάβλητο)" : "password"} className={inp} />
          </label>
        </div>
      </div>

      {/* Revolut */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><CreditCard className="h-4 w-4 text-brand-600" /> Revolut Business (Merchant API) <Badge ok={s?.revolut.api_key_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Merchant Secret API key
            <input type="password" value={revKey} onChange={(e) => setRevKey(e.target.value)} placeholder={s?.revolut.api_key_set ? "•••• (αποθηκευμένο)" : "sk_..."} className={inp} />
          </label>
          <label className="text-xs text-slate-500">Περιβάλλον
            <select value={revMode} onChange={(e) => setRevMode(e.target.value)} className={inp}>
              <option value="sandbox">Sandbox (δοκιμές)</option>
              <option value="live">Live (πραγματικές χρεώσεις)</option>
            </select>
          </label>
          <label className="text-xs text-slate-500 sm:col-span-2">Webhook signing secret <Badge ok={s?.revolut.webhook_secret_set} />
            <input type="password" value={revSecret} onChange={(e) => setRevSecret(e.target.value)} placeholder={s?.revolut.webhook_secret_set ? "•••• (αποθηκευμένο)" : "wsk_..."} className={inp} />
          </label>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Webhook URL για το Revolut dashboard: <code className="text-brand-700">https://app.rxvision.gr/api/v1/billing/webhook/revolut</code> (events: ORDER_COMPLETED, ORDER_PAYMENT_FAILED)</p>
      </div>

      {/* Anthropic / PharmaCat */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Bot className="h-4 w-4 text-brand-600" /> PharmaCat — Anthropic (Claude) <Badge ok={s?.anthropic?.api_key_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500 sm:col-span-2">Anthropic API key
            <input type="password" value={antKey} onChange={(e) => setAntKey(e.target.value)} placeholder={s?.anthropic?.api_key_set ? "•••• (αποθηκευμένο — κενό = αμετάβλητο)" : "sk-ant-..."} className={inp} />
          </label>
          <label className="text-xs text-slate-500">Μοντέλο φαρμακοποιού (κόστος vs ποιότητα)
            <select value={antModel} onChange={(e) => setAntModel(e.target.value)} className={inp}>
              <option value="claude-opus-4-8">Opus 4.8 — κορυφαίο (ακριβότερο)</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 — ισορροπία (φθηνό)</option>
              <option value="claude-haiku-4-5">Haiku 4.5 — οικονομικό</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">Μοντέλο διορθώσεων / admin (ποιότητα)
            <select value={antAdminModel} onChange={(e) => setAntAdminModel(e.target.value)} className={inp}>
              <option value="claude-opus-4-8">Opus 4.8 — κορυφαίο (ακριβότερο)</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 — ισορροπία (φθηνό)</option>
              <option value="claude-haiku-4-5">Haiku 4.5 — οικονομικό</option>
            </select>
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-slate-600 sm:col-span-2">
            <input type="checkbox" checked={antEnabled} onChange={(e) => setAntEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Ενεργή υπηρεσία {!antEnabled && <span className="text-rose-500">(απενεργοποιημένη για όλους)</span>}
          </label>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Τροφοδοτεί το <b>PharmaCat Clinical Assistant</b> (CDSS). Cache: επαναλαμβανόμενες ερωτήσεις = δωρεάν. Όριο: 50 νέες ερωτήσεις/φαρμακείο/ημέρα.</p>
      </div>

      <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση διαπιστευτηρίων
      </button>

      {/* Package pricing */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Package className="h-4 w-4 text-brand-600" /> Πακέτο RxVision Standard — τιμές</h3>
        <p className="mb-3 text-xs text-slate-500">Τρέχον: <b>{fmtMoney(std?.price_monthly ?? 0)} €/μήνα</b> · <b>{fmtMoney(std?.price_yearly ?? 0)} €/έτος</b> · <b>{std?.trial_days ?? 0} ημέρες</b> δοκιμή. (Κενό = αμετάβλητο.)</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-xs text-slate-500">€/μήνα<input type="number" value={pm} onChange={(e) => setPm(e.target.value)} placeholder={String((std?.price_monthly ?? 0) / 100)} className={inp} /></label>
          <label className="text-xs text-slate-500">€/έτος<input type="number" value={py} onChange={(e) => setPy(e.target.value)} placeholder={String((std?.price_yearly ?? 0) / 100)} className={inp} /></label>
          <label className="text-xs text-slate-500">Ημέρες δοκιμής<input type="number" value={td} onChange={(e) => setTd(e.target.value)} placeholder={String(std?.trial_days ?? 0)} className={inp} /></label>
        </div>
        <button onClick={() => savePkg.mutate()} disabled={savePkg.isPending || (!pm && !py && !td)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {savePkg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : savePkg.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση τιμών
        </button>
      </div>
    </div>
  );
}
