"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Bot, Save, Loader2, Check, Gauge } from "lucide-react";

type Integrations = {
  anthropic?: { api_key_set: boolean; enabled: boolean; model: string; admin_model: string };
  drugbank?: { api_key_set: boolean; enabled: boolean; region: string };
};
// Στη γλώσσα των ΠΑΚΕΤΩΝ: κάθε φαρμακείο δικαιούται `included` ερωτήσεις (ανά period) από το πακέτο του.
type AiTenant = { tenant_id: string; name?: string | null; plan?: string | null; plan_name?: string | null; included: number; period: string; used: number; remaining: number; ai_used_today: number; ai_used_ai: number; ai_used_local: number; card_on_file: boolean };
type ModelPrice = { in: number; out: number; cin: number };
type AiCost = {
  margin_pct: number; models: Record<string, ModelPrice>;
  measured: { days: number; ai_questions: number; cost_cents_total: number; cost_cents_per_q: number | null };
  suggested_price_per_q_cents: number | null;
};
type AiLimits = { tenants: AiTenant[]; default: number; cost?: AiCost };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const Badge = ({ ok }: { ok?: boolean }) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{ok ? "Αποθηκευμένο" : "Μη ρυθμισμένο"}</span>;

const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
const periodLabel = (p: string) => (p === "month" ? "/μήνα" : "/μέρα");

export default function AiProvidersPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integrations>("/admin/integrations"), retry: false });

  const [antKey, setAntKey] = useState("");
  const [antEnabled, setAntEnabled] = useState(true);
  const [antModel, setAntModel] = useState("claude-opus-4-8");
  const [antAdminModel, setAntAdminModel] = useState("claude-opus-4-8");
  const [dbKey, setDbKey] = useState("");
  const [dbEnabled, setDbEnabled] = useState(true);
  const [dbRegion, setDbRegion] = useState("eu");
  useEffect(() => {
    if (status.data?.anthropic) {
      setAntEnabled(status.data.anthropic.enabled ?? true);
      setAntModel(status.data.anthropic.model || "claude-opus-4-8");
      setAntAdminModel(status.data.anthropic.admin_model || "claude-opus-4-8");
    }
    if (status.data?.drugbank) {
      setDbEnabled(status.data.drugbank.enabled ?? true);
      setDbRegion(status.data.drugbank.region || "eu");
    }
  }, [status.data]);

  const save = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({
      anthropic_api_key: antKey || null, anthropic_enabled: antEnabled, anthropic_model: antModel || null,
      anthropic_admin_model: antAdminModel || null,
      drugbank_api_key: dbKey || null, drugbank_enabled: dbEnabled, drugbank_region: dbRegion || null,
    }) }),
    onSuccess: () => { setAntKey(""); setDbKey(""); qc.invalidateQueries({ queryKey: ["integrations"] }); },
  });

  // Όρια AI στη γλώσσα των ΠΑΚΕΤΩΝ: ανά φαρμακείο → included (δικαιούμενα) & κατανάλωση περιόδου.
  const limits = useQuery({ queryKey: ["ai-limits"], queryFn: () => adminApi<AiLimits>("/admin/ai-limits"), retry: false });
  const base = limits.data?.default ?? 50;
  const [baseFree, setBaseFree] = useState<string>("");
  const saveBase = useMutation({
    mutationFn: () => adminApi("/admin/ai-pricing", { method: "PUT", body: JSON.stringify({ base_daily_free: Math.max(0, Math.round(parseFloat(baseFree || "0"))) }) }),
    onSuccess: () => { setBaseFree(""); qc.invalidateQueries({ queryKey: ["ai-limits"] }); },
  });
  // cost-plus τιμολόγηση: μετρημένο κόστος + περιθώριο + τιμές μοντέλων
  const cost = limits.data?.cost;
  const [margin, setMargin] = useState<string>("");
  const [mp, setMp] = useState<Record<string, ModelPrice>>({});
  const mpriceOf = (m: string): ModelPrice => mp[m] ?? cost?.models?.[m] ?? { in: 0, out: 0, cin: 0 };
  const editMp = (m: string, k: keyof ModelPrice, v: string) => setMp((s) => ({ ...s, [m]: { ...mpriceOf(m), [k]: Math.max(0, Math.round(parseFloat(v || "0"))) } }));
  const saveCost = useMutation({
    mutationFn: () => adminApi("/admin/ai-pricing", { method: "PUT", body: JSON.stringify({ margin_pct: margin === "" ? null : Math.max(0, Math.round(parseFloat(margin))), models: { ...(cost?.models || {}), ...mp } }) }),
    onSuccess: () => { setMargin(""); setMp({}); qc.invalidateQueries({ queryKey: ["ai-limits"] }); },
  });
  const cpq = cost?.measured?.cost_cents_per_q ?? null;   // πραγματικό κόστος/ερώτηση (cents)
  const marginNow = margin === "" ? (cost?.margin_pct ?? 40) : parseFloat(margin || "0");
  const suggQ = cpq != null ? cpq * (1 + marginNow / 100) : null;   // προτεινόμενη τιμή/ερώτηση

  const s = status.data;
  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Bot className="h-6 w-6 text-brand-600" /> AI Providers</h1>
        <p className="mt-1 text-sm text-slate-500">Κλειδιά AI: <b>Anthropic</b> (PharmaCat) & <b>DrugBank</b> (αλληλεπιδράσεις). Κρυπτογραφημένα — δεν εμφανίζονται ξανά.</p>
      </div>

      {/* Anthropic / PharmaCat */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Bot className="h-4 w-4 text-brand-600" /> PharmaCat — Anthropic (Claude) <Badge ok={s?.anthropic?.api_key_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500 sm:col-span-2">Anthropic API key
            <input type="password" value={antKey} onChange={(e) => setAntKey(e.target.value)} placeholder={s?.anthropic?.api_key_set ? "•••• (αποθηκευμένο — κενό = αμετάβλητο)" : "sk-ant-..."} className={inp} /></label>
          <label className="text-xs text-slate-500">Μοντέλο φαρμακοποιού
            <select value={antModel} onChange={(e) => setAntModel(e.target.value)} className={inp}>
              <option value="claude-opus-4-8">Opus 4.8 — κορυφαίο</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 — ισορροπία</option>
              <option value="claude-haiku-4-5">Haiku 4.5 — οικονομικό</option>
            </select></label>
          <label className="text-xs text-slate-500">Μοντέλο διορθώσεων / admin
            <select value={antAdminModel} onChange={(e) => setAntAdminModel(e.target.value)} className={inp}>
              <option value="claude-opus-4-8">Opus 4.8 — κορυφαίο</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 — ισορροπία</option>
              <option value="claude-haiku-4-5">Haiku 4.5 — οικονομικό</option>
            </select></label>
          <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-slate-600 sm:col-span-2">
            <input type="checkbox" checked={antEnabled} onChange={(e) => setAntEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Ενεργή υπηρεσία {!antEnabled && <span className="text-rose-500">(απενεργοποιημένη για όλους)</span>}
          </label>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Τροφοδοτεί το <b>PharmaCat Clinical Assistant</b> (κοινό κεντρικό κλειδί). <b>Όλα</b> τα ερωτήματα μετρούν (και όσα σερβίρονται από την τοπική βάση· εμείς βλέπουμε AI vs τοπική στον πίνακα). Τα δικαιούμενα ερωτήματα <b>ορίζονται ανά ΠΑΚΕΤΟ</b> (Ρυθμίσεις → Πακέτα) — εδώ βλέπεις τι δικαιούται & τι κατανάλωσε κάθε φαρμακείο ↓</p>
      </div>

      {/* Όρια AI ερωτημάτων ανά φαρμακείο */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Gauge className="h-4 w-4 text-violet-600" /> Όρια AI ερωτημάτων ανά φαρμακείο</h3>
        <p className="mb-3 text-xs text-slate-500">Τα δικαιούμενα ερωτήματα ορίζονται <b>ανά πακέτο</b> (Πακέτα → «🤖 Δωρεάν AI ερωτήσεις»). Πάνω από αυτά → αγορά επιπλέον (AI credits). Το παρακάτω <b>καθολικό όριο</b> ισχύει μόνο ως fallback για πακέτα χωρίς ρυθμισμένο included.</p>

        {/* Καθολικό fallback (για πακέτα χωρίς included) */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-sm">
          <span className="font-semibold text-violet-900">🎁 Καθολικό δωρεάν fallback:</span>
          <div className="flex items-center gap-1">
            <input type="number" step="5" min="0" value={baseFree} onChange={(e) => setBaseFree(e.target.value)}
              placeholder={base.toString()} className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            <span className="text-slate-500">ερωτ./μέρα</span>
          </div>
          <button onClick={() => saveBase.mutate()} disabled={!baseFree || saveBase.isPending}
            className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50">Αποθήκευση</button>
          <span className="w-full text-[11px] text-violet-700">Τώρα: <b>{base}/μέρα</b> — ισχύει μόνο για πακέτα που ΔΕΝ έχουν ορίσει δικά τους included.</span>
        </div>

        {/* Cost-plus: πραγματικό κόστος/ερώτηση + περιθώριο → προτεινόμενη τιμή */}
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-sm">
          <div className="mb-2 flex items-center gap-2 font-semibold text-emerald-900">💡 Κόστος & τιμολόγηση (cost-plus)</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-white/70 p-2">
              <div className="text-[11px] text-slate-500">Πραγματικό κόστος/ερώτηση (τελ. {cost?.measured?.days ?? 30} ημ.)</div>
              {cpq != null ? (
                <><div className="text-lg font-bold text-slate-800">{cpq.toFixed(3)}¢</div>
                <div className="text-[11px] text-slate-500">≈ {eur(Math.round(cpq * 10))}/1.000 ερωτ. · από {cost?.measured?.ai_questions ?? 0} ερωτ.</div></>
              ) : <div className="text-xs text-slate-400">Δεν υπάρχουν ακόμη μετρήσεις — θα γεμίσει με τη χρήση.</div>}
            </div>
            <div className="rounded-lg bg-white/70 p-2">
              <div className="text-[11px] text-slate-500">Περιθώριο κέρδους</div>
              <div className="mt-1 flex items-center gap-1">
                <input type="number" step="5" min="0" value={margin} onChange={(e) => setMargin(e.target.value)}
                  placeholder={String(cost?.margin_pct ?? 40)} className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
                <span className="text-slate-500">%</span>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">τώρα: <b>{cost?.margin_pct ?? 40}%</b></div>
            </div>
            <div className="rounded-lg bg-white/70 p-2">
              <div className="text-[11px] text-slate-500">Προτεινόμενη τιμή/ερώτηση</div>
              {suggQ != null ? (
                <><div className="text-lg font-bold text-emerald-700">{suggQ.toFixed(3)}¢</div>
                <div className="text-[11px] text-slate-500">≈ {eur(Math.round(suggQ * 10))}/1.000 ερωτ. (κόστος +{marginNow}%)</div></>
              ) : <div className="text-xs text-slate-400">—</div>}
            </div>
          </div>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-emerald-800">Τιμές μοντέλων (cents ανά 1.000.000 tokens)</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-[420px] text-xs">
                <thead className="text-left text-slate-500"><tr><th className="py-1 pr-3">Μοντέλο</th><th className="pr-3">Input</th><th className="pr-3">Output</th><th className="pr-3">Cached in</th></tr></thead>
                <tbody>
                  {Object.keys(cost?.models || {}).map((m) => (
                    <tr key={m} className="border-t border-emerald-100">
                      <td className="py-1 pr-3 font-mono text-[11px]">{m}</td>
                      {(["in", "out", "cin"] as (keyof ModelPrice)[]).map((k) => (
                        <td key={k} className="pr-3"><input type="number" min="0" value={mpriceOf(m)[k]} onChange={(e) => editMp(m, k, e.target.value)} className="w-20 rounded border border-slate-300 px-1.5 py-0.5" /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button onClick={() => saveCost.mutate()} disabled={saveCost.isPending}
              className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">Αποθήκευση περιθωρίου & τιμών</button>
            {suggQ != null && (
              <span className="text-[11px] text-slate-500">💡 Αυτή η τιμή/ερώτηση θα χρησιμοποιηθεί για την τιμολόγηση των <b>AI credits</b> (αγορά επιπλέον πάνω από το included του πακέτου).</span>
            )}
          </div>
        </div>

        {limits.isLoading ? <div className="py-6 text-center text-sm text-slate-400">Φόρτωση…</div> : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Φαρμακείο</th>
                  <th className="px-3 py-2">Πακέτο</th>
                  <th className="px-3 py-2 text-right">Δικαιούται</th>
                  <th className="px-3 py-2 text-right">Κατανάλωσε (περίοδος)</th>
                </tr>
              </thead>
              <tbody>
                {(limits.data?.tenants ?? []).map((t) => {
                  const over = t.used >= t.included && t.included > 0;
                  const pct = t.included > 0 ? Math.min(100, Math.round((t.used / t.included) * 100)) : 0;
                  return (
                  <tr key={t.tenant_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-800">{t.name || t.tenant_id}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{t.plan_name || t.plan || <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-700">{t.included}<span className="text-[11px] font-normal text-slate-400">{periodLabel(t.period)}</span></td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      <span className={over ? "font-semibold text-rose-600" : ""}>{t.used}</span>
                      <span className="text-slate-300"> / {t.included}</span>
                      <div className="mt-1 ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full rounded-full ${over ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400" title="Ανάλυση μόνο για εμάς — ο πελάτης βλέπει μόνο το σύνολο.">σήμερα: AI {t.ai_used_ai} · τοπική {t.ai_used_local}</div>
                    </td>
                  </tr>
                );})}
                {(limits.data?.tenants ?? []).length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-slate-400">Δεν υπάρχουν φαρμακεία.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* DrugBank */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Bot className="h-4 w-4 text-orange-500" /> DrugBank — Αλληλεπιδράσεις φαρμάκων <Badge ok={s?.drugbank?.api_key_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500 sm:col-span-2">DrugBank API key
            <input type="password" value={dbKey} onChange={(e) => setDbKey(e.target.value)} placeholder={s?.drugbank?.api_key_set ? "•••• (αποθηκευμένο — κενό = αμετάβλητο)" : "DrugBank production key…"} className={inp} /></label>
          <label className="text-xs text-slate-500">Περιοχή (region)
            <select value={dbRegion} onChange={(e) => setDbRegion(e.target.value)} className={inp}>
              <option value="eu">EU (Ευρώπη)</option><option value="us">US</option><option value="canada">Canada</option>
            </select></label>
          <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-slate-600">
            <input type="checkbox" checked={dbEnabled} onChange={(e) => setDbEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Ενεργό {!dbEnabled && <span className="text-rose-500">(ανενεργό)</span>}
          </label>
        </div>
        <p className="mt-3 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-700">Curated κλινική βάση για drug-drug interactions. Με κλειδί → έλεγχος μέσω DrugBank (AI fallback). Χωρίς κλειδί → interim μέσω PharmaCat AI.</p>
      </div>

      <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση κλειδιών AI
      </button>
    </div>
  );
}
