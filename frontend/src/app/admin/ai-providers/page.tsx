"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Bot, Save, Loader2, Check, Gauge } from "lucide-react";

type Integrations = {
  anthropic?: { api_key_set: boolean; enabled: boolean; model: string; admin_model: string };
  drugbank?: { api_key_set: boolean; enabled: boolean; region: string };
};
type AiTenant = { tenant_id: string; name?: string | null; ai_daily_limit: number; ai_used_today: number; ai_used_ai: number; ai_used_local: number; ai_surcharge_cents: number; card_on_file: boolean };
type AiLimits = { tenants: AiTenant[]; price_per_block_cents: number; block: number; default: number; max: number };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const Badge = ({ ok }: { ok?: boolean }) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{ok ? "Αποθηκευμένο" : "Μη ρυθμισμένο"}</span>;

const LIMIT_OPTS = [50, 75, 100, 150, 200, 300, 500, 1000];
const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";
// επιβάρυνση/μήνα = ceil((limit-50)/block) × price/μπλοκ
const limitLabel = (v: number, block: number, ppb: number) => {
  const extra = Math.max(0, Math.ceil((v - 50) / block));
  return `${v}/μέρα${v === 50 ? " · βασικό" : ` · +${eur(extra * ppb)}/μ`}`;
};

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

  // Όρια AI ερωτημάτων ανά φαρμακείο (κεντρικό κλειδί, ημερήσιο όριο· >50 = πρόσθετη υπηρεσία)
  const limits = useQuery({ queryKey: ["ai-limits"], queryFn: () => adminApi<AiLimits>("/admin/ai-limits"), retry: false });
  const setLimit = useMutation({
    mutationFn: (v: { id: string; limit: number }) => adminApi(`/admin/tenants/${v.id}`, { method: "PATCH", body: JSON.stringify({ ai_daily_limit: v.limit }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-limits"] }),
  });
  const ppb = limits.data?.price_per_block_cents ?? 500;
  const block = limits.data?.block ?? 25;
  const [ppbEur, setPpbEur] = useState<string>("");
  const savePpb = useMutation({
    mutationFn: () => adminApi("/admin/ai-pricing", { method: "PUT", body: JSON.stringify({ price_per_block_cents: Math.round(parseFloat(ppbEur || "0") * 100) }) }),
    onSuccess: () => { setPpbEur(""); qc.invalidateQueries({ queryKey: ["ai-limits"] }); },
  });

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
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Τροφοδοτεί το <b>PharmaCat Clinical Assistant</b> (κοινό κεντρικό κλειδί). <b>Όλα</b> τα ερωτήματα μετρούν στο όριο — και όσα σερβίρονται από την τοπική βάση (ο πελάτης βλέπει μόνο το σύνολο· εμείς βλέπουμε AI vs τοπική στον πίνακα παρακάτω). Βασικό όριο <b>50 ερωτ./φαρμακείο/ημέρα</b> — ρυθμίζεται & χρεώνεται ανά φαρμακείο παρακάτω ↓</p>
      </div>

      {/* Όρια AI ερωτημάτων ανά φαρμακείο */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Gauge className="h-4 w-4 text-violet-600" /> Όρια AI ερωτημάτων ανά φαρμακείο</h3>
        <p className="mb-3 text-xs text-slate-500">Κοινό κεντρικό κλειδί για όλους. Κάθε φαρμακείο έχει ημερήσιο όριο ερωτημάτων. Βασικό: <b>{limits.data?.default ?? 50}/μέρα</b> (χωρίς χρέωση). Μεγαλύτερο = πρόσθετη υπηρεσία (μπαίνει αυτόματα στη συνδρομή).</p>

        {/* Τιμολόγηση: τιμή ανά μπλοκ των {block} επιπλέον ερωτημάτων */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-sm">
          <span className="font-semibold text-violet-900">💶 Τιμή ανά μπλοκ (+{block} ερωτ./μέρα):</span>
          <div className="flex items-center gap-1">
            <input type="number" step="0.5" min="0" value={ppbEur} onChange={(e) => setPpbEur(e.target.value)}
              placeholder={(ppb / 100).toString()} className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            <span className="text-slate-500">€/μήνα</span>
          </div>
          <button onClick={() => savePpb.mutate()} disabled={!ppbEur || savePpb.isPending}
            className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50">Αποθήκευση</button>
          <span className="text-[11px] text-violet-700">Τώρα: <b>{eur(ppb)}/μήνα</b> ανά μπλοκ των {block} πάνω από τα 50/μέρα.</span>
        </div>

        {limits.isLoading ? <div className="py-6 text-center text-sm text-slate-400">Φόρτωση…</div> : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Φαρμακείο</th>
                  <th className="px-3 py-2">Ημερήσιο όριο</th>
                  <th className="px-3 py-2 text-right">Σήμερα</th>
                  <th className="px-3 py-2 text-right">Χρέωση/μήνα</th>
                </tr>
              </thead>
              <tbody>
                {(limits.data?.tenants ?? []).map((t) => (
                  <tr key={t.tenant_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-800">{t.name || t.tenant_id}
                      {!t.card_on_file && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Χωρίς αποθηκευμένη κάρτα — το πραγματικό όριο καπάρεται στο βασικό (50) μέχρι να μπει κάρτα.">🔒 χωρίς κάρτα</span>}
                    </td>
                    <td className="px-3 py-2">
                      <select value={t.ai_daily_limit} onChange={(e) => setLimit.mutate({ id: t.tenant_id, limit: +e.target.value })}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
                        {LIMIT_OPTS.map((v) => <option key={v} value={v}>{limitLabel(v, block, ppb)}</option>)}
                      </select>
                      {!t.card_on_file && t.ai_daily_limit > 50 && <div className="mt-0.5 text-[10px] text-amber-600">ενεργό: 50 (χωρίς κάρτα)</div>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      <span className={t.ai_used_today >= t.ai_daily_limit ? "font-semibold text-rose-600" : ""}>{t.ai_used_today}</span>
                      <span className="text-slate-300"> / {t.ai_daily_limit}</span>
                      <div className="text-[10px] text-slate-400" title="Ανάλυση μόνο για εμάς — ο πελάτης βλέπει μόνο το σύνολο.">AI {t.ai_used_ai} · τοπική {t.ai_used_local}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.ai_surcharge_cents > 0
                        ? <span className="font-semibold text-violet-700">+{eur(t.ai_surcharge_cents)}</span>
                        : <span className="text-xs text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
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
